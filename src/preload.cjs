const { ipcRenderer } = require('electron');

// No bridge is exposed to the remote page. Its original player and input handlers
// remain in place; only the presentation and the view-only input gate change.
/** @type {HTMLVideoElement | HTMLCanvasElement | null} */
let source = null;
/** @type {HTMLElement | null} */
let player = null;
/** @type {HTMLDivElement} */
let surface;
/** @type {HTMLDivElement} */
let status;
let lastSize = '';
let hasShownVideo = false;
let ready = false;
let controlEnabled = false;
let moving = false;
let options = false;
let deviceName = '';
/** @type {{width: number, height: number} | null} */
let videoPoints = null;
let lastChrome = '';
/** @type {Element | null} */
let observedContent = null;
const contentObserver = new ResizeObserver(() => { if (surface) update(); });
/** @type {HTMLDivElement} */
let titleBar;
/** @type {HTMLSpanElement} */
let titleLabel;
let releasing = false;
let lastStreaming = false;
let loginReported = false;
const pressedKeys = new Map();
const pressedButtons = new Set();
/** @type {import('./keyboard.cjs').KeyboardSettings | undefined} */
let keyboard;
const pendingModifiers = new Map();
const consumedKeys = new Set();
const heldModifiers = new Map();
const keyboardActions = /** @type {const} */ (['insert', 'secureAttention', 'paste']);
/** @type {Record<string, 'meta' | 'control' | 'alt' | 'shift'>} */
const modifierNames = { MetaLeft: 'meta', MetaRight: 'meta', ControlLeft: 'control', ControlRight: 'control', AltLeft: 'alt', AltRight: 'alt', ShiftLeft: 'shift', ShiftRight: 'shift' };
function flushModifiers() {
  if (!player) return;
  for (const [code, key] of heldModifiers) {
    if (consumedKeys.has(code)) { pendingModifiers.set(code, key); consumedKeys.delete(code); }
  }
  releasing = true;
  try {
    for (const [code, key] of pendingModifiers) {
      pressedKeys.set(code, key);
      player.dispatchEvent(new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true }));
    }
  } finally { pendingModifiers.clear(); releasing = false; }
}
/** @param {KeyboardEvent} event */
function handleKeyboardShortcut(event) {
  if (!event.isTrusted || !keyboard || !playerFocused()) return false;
  const code = event.code;
  const modifier = modifierNames[code];
  if (modifier && event.type === 'keydown') heldModifiers.set(code, { code, key: event.key, location: event.location, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey });
  if (modifier && event.type === 'keyup') heldModifiers.delete(code);
  const action = keyboardActions.find(name => {
    const binding = keyboard?.[name];
    return binding && binding.code === code && binding.meta === event.metaKey && binding.control === event.ctrlKey && binding.alt === event.altKey && binding.shift === event.shiftKey;
  });
  if (event.type === 'keydown' && action) {
    for (const key of pendingModifiers.keys()) consumedKeys.add(key);
    pendingModifiers.clear(); consumedKeys.add(code);
    if (!event.repeat) ipcRenderer.send('glkvm:keyboard-shortcut', action);
    return true;
  }
  if (consumedKeys.has(code)) {
    if (event.type === 'keyup') consumedKeys.delete(code);
    return true;
  }
  if (event.type === 'keydown' && modifier && !pressedKeys.has(code) && keyboardActions.some(name => keyboard?.[name]?.[modifier])) {
    pendingModifiers.set(code, { code, key: event.key, location: event.location, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey });
    return true;
  }
  // A normal chord, or a modifier tapped alone, retains the vendor's input behavior.
  if (event.type === 'keydown' || event.type === 'keyup') flushModifiers();
  return false;
}

function playerFocused() {
  return !!player && (document.activeElement === player || player.contains(document.activeElement)) && !document.activeElement?.closest('input, textarea, select, [contenteditable="true"]');
}
function reportPlayerFocus() { ipcRenderer.send('glkvm:player-focus', playerFocused()); }
window.addEventListener('focusin', reportPlayerFocus);
window.addEventListener('focusout', () => queueMicrotask(reportPlayerFocus));
let keyboardBusy = false;
ipcRenderer.on('glkvm:keyboard-action', async (_event, command) => {
  if (!player || !ready || !controlEnabled || moving || !playerFocused() || keyboardBusy) return;
  const target = player;
  if (!['insert', 'secureAttention', 'paste'].includes(command?.action)) return;
  keyboardBusy = true;
  releaseInput(true);
  target.focus({ preventScroll: true });
  try {
    if (command.action === 'paste') {
      if (typeof command.text !== 'string' || !command.text) return;
      if (!['de', 'de-ch', 'en-us', 'en-gb', 'fr'].includes(command.keymap)) return;
      // Match the vendor Toolbox's authenticated text endpoint. Do not log text or tokens.
      const tokens = JSON.parse(localStorage.getItem('gl-kvm-token-keys') || '{}');
      const token = tokens.glkvm;
      const response = await fetch(`/api/hid/print?limit=0&keymap=${encodeURIComponent(command.keymap)}`, {
        method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...(typeof token === 'string' ? { token } : {}) },
        body: command.text,
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok || (await response.json()).ok !== true) throw new Error('Text could not be sent. Check the connection and remote keyboard layout. It was not retried automatically.');
    } else {
      const keys = command.action === 'insert' ? [{ code: 'Insert', key: 'Insert', keyCode: 45 }] : [
        { code: 'ControlLeft', key: 'Control', keyCode: 17, location: 1 },
        { code: 'AltLeft', key: 'Alt', keyCode: 18, location: 1 },
        { code: 'Delete', key: 'Delete', keyCode: 46 },
      ];
      releasing = true;
      try {
        for (const key of keys) target.dispatchEvent(new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true }));
      } finally {
        for (const key of [...keys].reverse()) target.dispatchEvent(new KeyboardEvent('keyup', { ...key, bubbles: true, cancelable: true }));
        releasing = false;
      }
    }
  } catch {
    ipcRenderer.send('glkvm:keyboard-error', 'The keyboard action could not be completed. Check the connection and paste layout. Text may have been partially sent; it was not retried.');
  } finally { keyboardBusy = false; }
});

/** @param {unknown} [preserveLocalModifiers] */
function releaseInput(preserveLocalModifiers = false) {
  pendingModifiers.clear();
  if (preserveLocalModifiers !== true) { heldModifiers.clear(); consumedKeys.clear(); }
  releasing = true;
  try {
    if (player) {
      for (const key of pressedKeys.values()) player.dispatchEvent(new KeyboardEvent('keyup', { ...key, bubbles: true }));
      const target = player.querySelector('#video-wrapper') || player;
      for (const button of pressedButtons) target.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true }));
      player.blur();
    }
    if (document.pointerLockElement) document.exitPointerLock();
  } finally { pressedKeys.clear(); pressedButtons.clear(); releasing = false; }
}
ipcRenderer.on('glkvm:release-input', releaseInput);
ipcRenderer.on('glkvm:mode', (_event, mode) => {
  releaseInput();
  keyboard = mode?.keyboard;
  controlEnabled = mode?.controlEnabled === true;
  moving = mode?.moving === true;
  if (options !== (mode?.options === true)) lastChrome = '';
  options = mode?.options === true;
  videoPoints = mode?.videoPoints || null;
  deviceName = typeof mode?.name === 'string' ? mode.name : '';
  if (surface) update();
});
window.addEventListener('blur', releaseInput);

for (const name of [
  'keydown', 'keyup', 'keypress', 'beforeinput', 'input',
  'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup',
  'mousemove', 'click', 'dblclick', 'contextmenu', 'wheel',
  'touchstart', 'touchmove', 'touchend', 'paste', 'cut', 'copy',
  'dragstart', 'dragover', 'drop',
]) {
  window.addEventListener(name, event => {
    if (releasing) return;
    if (!document.documentElement.hasAttribute('data-glkvm-clean') && !(playerFocused() && event instanceof KeyboardEvent)) return;
    if (!controlEnabled || moving || !ready || ['dragstart', 'dragover', 'drop'].includes(name)) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (event instanceof KeyboardEvent) {
      if (handleKeyboardShortcut(event)) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (name === 'keydown') pressedKeys.set(event.code || event.key, { code: event.code, key: event.key, location: event.location });
      if (name === 'keyup') pressedKeys.delete(event.code || event.key);
    }
    if (event instanceof MouseEvent) {
      if (name === 'mousedown') { flushModifiers(); pressedButtons.add(event.button); player?.focus({ preventScroll: true }); }
      if (name === 'mouseup') pressedButtons.delete(event.button);
    }
  }, { capture: true, passive: false });
}

function update() {
  const root = document.documentElement;
  root.toggleAttribute('data-glkvm-options', options);
  root.toggleAttribute('data-glkvm-sized', options && !!videoPoints);
  if (videoPoints) {
    root.style.setProperty('--glkvm-options-width', `${videoPoints.width}px`);
    root.style.setProperty('--glkvm-options-height', `${videoPoints.height}px`);
    const content = document.querySelector('.player-content');
    if (content !== observedContent) {
      contentObserver.disconnect();
      observedContent = content;
      if (content) contentObserver.observe(content);
    }
    // Preserve the selected window size while a sidebar temporarily takes video space.
    const available = content?.clientWidth || window.innerWidth;
    const fit = Math.min(1, available / videoPoints.width);
    root.style.setProperty('--glkvm-video-width', `${videoPoints.width * fit}px`);
    root.style.setProperty('--glkvm-video-height', `${videoPoints.height * fit}px`);
  }
  if (titleLabel) titleLabel.textContent = deviceName;
  const next = document.querySelector('#stream-video, #stream-canvas');
  const nextSource = next instanceof HTMLVideoElement || next instanceof HTMLCanvasElement ? next : null;
  const nextPlayer = nextSource?.closest('#stream-box');
  if (nextSource !== source) { releaseInput(); lastSize = ''; }
  source = nextSource;
  player = nextPlayer instanceof HTMLElement ? nextPlayer : null;
  const signingIn = [...document.querySelectorAll('input[type="password"]')].some(input => input.getBoundingClientRect().width > 0);
  let width = 0, height = 0;
  if (source instanceof HTMLVideoElement) {
    width = source.videoWidth; height = source.videoHeight;
    const media = source.srcObject;
    ready = media instanceof MediaStream && media.getVideoTracks().some(track => track.readyState === 'live') && !!width && source.readyState >= 2 && !source.ended;
  } else if (source instanceof HTMLCanvasElement) {
    width = source.width; height = source.height;
    ready = width > 0 && height > 0;
  } else ready = false;
  if (!player || signingIn) { hasShownVideo = false; ready = false; }
  else if (ready) hasShownVideo = true;
  if (ready && player) {
    const size = `${width}x${height}`;
    if (size !== lastSize) { lastSize = size; ipcRenderer.send('glkvm:video-size', { width, height }); }
  }
  if (signingIn && !loginReported) { loginReported = true; ipcRenderer.send('glkvm:login-required'); }
  if (!signingIn) loginReported = false;
  const streaming = hasShownVideo && ready;
  if (lastStreaming !== streaming) {
    if (!streaming) releaseInput();
    lastStreaming = streaming;
    ipcRenderer.send('glkvm:stream-state', streaming);
  }
  if (options) {
    for (const attribute of ['data-glkvm-clean', 'data-glkvm-control', 'data-glkvm-drag', 'data-glkvm-waiting']) root.removeAttribute(attribute);
    const frame = document.querySelector('#stream-window');
    if (ready && frame) {
      const rect = (document.querySelector('.player-content') || frame).getBoundingClientRect();
      const footer = document.querySelector('.kvm-video-info')?.getBoundingClientRect().height || 0;
      const keyboard = document.querySelector('.player-outer.keyboard-opened + .keyboard-container')?.getBoundingClientRect().height || 0;
      const chrome = { width: 0, height: Math.max(32, rect.top) + footer + keyboard };
      const key = JSON.stringify(chrome);
      if (key !== lastChrome) { lastChrome = key; ipcRenderer.send('glkvm:options-chrome', chrome); }
    }
    return;
  }
  root.setAttribute('data-glkvm-clean', '');
  status.textContent = signingIn ? 'Sign in in the Device Settings window (⌘⇧O).' : 'Waiting for live video…';
  root.toggleAttribute('data-glkvm-control', controlEnabled && !moving && ready);
  root.toggleAttribute('data-glkvm-drag', !controlEnabled || moving);
  root.toggleAttribute('data-glkvm-waiting', !ready);
  status.hidden = ready;
  // Remove ancestor clipping/stacking without detaching vendor-owned DOM nodes.
  // This preserves Vue's event bindings and all WebRTC reconnect behavior.
  if (player && hasShownVideo) {
    for (let ancestor = player.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) ancestor.setAttribute('data-glkvm-ancestor', '');
  }
  if (ready && player) {
    const scale = Math.min(window.innerWidth / width, window.innerHeight / height);
    root.style.setProperty('--glkvm-width', `${width * scale}px`);
    root.style.setProperty('--glkvm-height', `${height * scale}px`);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style');
  style.textContent = `
    html[data-glkvm-clean], html[data-glkvm-clean] body {
      margin: 0 !important; padding: 0 !important; width: 100% !important; height: 100% !important;
      overflow: hidden !important; background: black !important;
    }
    html[data-glkvm-clean] body, html[data-glkvm-clean] body * { visibility: hidden !important; }
    html[data-glkvm-clean] [data-glkvm-ancestor] {
      transform: none !important; filter: none !important; perspective: none !important;
      contain: none !important; will-change: auto !important; isolation: auto !important;
      opacity: 1 !important; z-index: auto !important; overflow: visible !important;
      clip-path: none !important; animation: none !important; transition: none !important;
    }
    #glkvm-clean-surface, #glkvm-clean-drag, #glkvm-title-bar { display: none; }
    html[data-glkvm-options] { padding-top: 32px !important; box-sizing: border-box !important; }
    /* Continue the sidebar surface below panels shorter than the video. */
    html[data-glkvm-options], html[data-glkvm-options] body {
      background: var(--gl-color-bg-surface1, #000) !important;
    }
    /* Vendor viewport-height containers otherwise center a fixed-size video with empty bands. */
    html:root[data-glkvm-options][data-glkvm-sized] .kvm-page-container,
    html:root[data-glkvm-options][data-glkvm-sized] .kvm-page,
    html:root[data-glkvm-options][data-glkvm-sized] .kvm-page-content,
    html:root[data-glkvm-options][data-glkvm-sized] .player-outer,
    html:root[data-glkvm-options][data-glkvm-sized] .player-container {
      height: auto !important; min-height: 0 !important; min-width: 0 !important; flex-grow: 0 !important;
      transition: none !important;
    }
    html:root[data-glkvm-options][data-glkvm-sized] .player-content,
    html:root[data-glkvm-options][data-glkvm-sized] .player-content .ant-spin-nested-loading,
    html:root[data-glkvm-options][data-glkvm-sized] .player-content .ant-spin-container {
      height: var(--glkvm-options-height) !important; min-height: 0 !important;
      flex: none !important; align-items: center !important;
      margin-top: 0 !important; margin-bottom: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important;
    }
    html:root[data-glkvm-options][data-glkvm-sized] #stream-window,
    html:root[data-glkvm-options][data-glkvm-sized] body #stream-window #stream-box {
      width: var(--glkvm-video-width) !important; height: var(--glkvm-video-height) !important;
      min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important;
      flex: none !important; margin: 0 !important; padding: 0 !important; border: 0 !important; transform: none !important;
      animation: none !important; transition: none !important;
    }
    html:root[data-glkvm-options][data-glkvm-sized] body #stream-window #stream-box #stream-video,
    html:root[data-glkvm-options][data-glkvm-sized] body #stream-window #stream-box #stream-canvas,
    html:root[data-glkvm-options][data-glkvm-sized] body #stream-window #stream-box #video-wrapper {
      width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important;
      padding: 0 !important; border: 0 !important; object-fit: contain !important; transform: none !important;
    }
    html[data-glkvm-options] #glkvm-title-bar {
      display: block; position: fixed; top: 0; left: 0; right: 0; height: 32px;
      z-index: 2147483647; background: #252525; color: #eee; text-align: center;
      font: 13px/32px system-ui; user-select: none; -webkit-app-region: drag;
    }
    #glkvm-title-bar .window-buttons { position: absolute; left: 12px; top: 10px; display: flex; gap: 8px; }
    #glkvm-title-bar button {
      -webkit-app-region: no-drag; width: 12px; height: 12px; border-radius: 50%;
      padding: 0; border: 1px solid #0003; cursor: default;
    }
    #glkvm-title-bar button:focus-visible { outline: 2px solid white; outline-offset: 2px; }
    html[data-glkvm-clean] #glkvm-clean-surface {
      display: flex; position: fixed; inset: 0; z-index: 2147483645;
      align-items: center; justify-content: center; visibility: visible !important;
      background: black; pointer-events: none;
    }
    html[data-glkvm-clean] body #stream-window #stream-box {
      visibility: visible !important; position: fixed !important; z-index: 2147483646 !important;
      top: 50% !important; left: 50% !important; right: auto !important; bottom: auto !important;
      transform: translate(-50%, -50%) !important;
      width: var(--glkvm-width) !important; height: var(--glkvm-height) !important;
      min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important;
      margin: 0 !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important;
      box-shadow: none !important; outline: none !important; background: black !important;
      overflow: hidden !important; display: flex !important; align-items: center !important;
      animation: none !important; transition: none !important;
    }
    html[data-glkvm-clean] body #stream-window #stream-box #stream-video,
    html[data-glkvm-clean] body #stream-window #stream-box #stream-canvas,
    html[data-glkvm-clean] body #stream-window #stream-box #video-wrapper {
      visibility: visible !important; position: absolute !important; inset: 0 !important;
      width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important;
      margin: 0 !important; padding: 0 !important; border: 0 !important; display: block !important;
      object-fit: contain !important; border-radius: 0 !important; user-select: none;
    }
    html[data-glkvm-clean] #stream-box #video-wrapper { z-index: 2 !important; }
    html[data-glkvm-clean][data-glkvm-waiting] body #stream-window #stream-box { display: none !important; }
    html[data-glkvm-clean][data-glkvm-drag] #glkvm-clean-drag {
      display: block; position: fixed; inset: 6px; z-index: 2147483647;
      -webkit-app-region: drag;
    }
    #glkvm-clean-status { color: #a3a3a3; font: 14px system-ui; }
    #glkvm-clean-status[hidden] { display: none; }
  `;
  document.head.append(style);
  surface = document.createElement('div');
  surface.id = 'glkvm-clean-surface';
  status = document.createElement('div');
  status.id = 'glkvm-clean-status'; status.textContent = 'Waiting for live video…';
  surface.append(status);
  const drag = document.createElement('div'); drag.id = 'glkvm-clean-drag';
  titleBar = document.createElement('div'); titleBar.id = 'glkvm-title-bar';
  titleLabel = document.createElement('span');
  const buttons = document.createElement('div'); buttons.className = 'window-buttons';
  for (const [action, label, color] of [['close', 'Close window', '#ff5f57'], ['minimize', 'Minimize window', '#febc2e'], ['fullscreen', 'Toggle fullscreen', '#28c840']]) {
    const button = document.createElement('button');
    button.type = 'button'; button.setAttribute('aria-label', label); button.title = label; button.style.background = color;
    button.addEventListener('click', event => { event.stopPropagation(); ipcRenderer.send('glkvm:window-action', action); });
    buttons.append(button);
  }
  titleBar.append(buttons, titleLabel);
  document.documentElement.append(surface, drag, titleBar);
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', update);
  setInterval(update, 500);
  ipcRenderer.send('glkvm:ready');
  update();
}, { once: true });
