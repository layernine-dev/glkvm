const { contextBridge, ipcRenderer } = require('electron');

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
/** Audio switching shortcut keys consumed in every focus and mode, until released. */
const pauseKeys = new Set();
const heldModifiers = new Map();
// The main process toggles audio switching for its shortcut; this page only consumes the key.
const keyboardActions = /** @type {const} */ (['insert', 'secureAttention', 'paste', 'pauseAudioSwitching']);
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
    // The audio switching key itself is tracked in pauseKeys, which outlives focus changes.
    pendingModifiers.clear(); if (action !== 'pauseAudioSwitching') consumedKeys.add(code);
    if (!event.repeat && action !== 'pauseAudioSwitching') ipcRenderer.send('glkvm:keyboard-shortcut', action);
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

/** @param {Event} event */
function isPauseShortcut(event) {
  const binding = keyboard?.pauseAudioSwitching;
  return event instanceof KeyboardEvent && event.type === 'keydown' && event.isTrusted && !!binding && binding.code === event.code && binding.meta === event.metaKey && binding.control === event.ctrlKey && binding.alt === event.altKey && binding.shift === event.shiftKey;
}
function playerFocused() {
  return !!player && (document.activeElement === player || player.contains(document.activeElement)) && !document.activeElement?.closest('input, textarea, select, [contenteditable="true"]');
}
let playerHadFocus = false;
function reportPlayerFocus() {
  const focused = playerFocused();
  // Keys released outside the player never reach it: forget them now rather than replaying them later.
  if (playerHadFocus && !focused) releaseInput();
  playerHadFocus = focused;
  ipcRenderer.send('glkvm:player-focus', focused);
}
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
    // The audio switching shortcut never reaches the page or the remote computer, in any mode.
    // Its key stays consumed until released, even after its modifiers are or focus moves between
    // the player and a local field; a fresh press means its keyup was missed.
    if (event instanceof KeyboardEvent && event.isTrusted && pauseKeys.has(event.code)) {
      if (event.type === 'keyup' || (event.type === 'keydown' && event.repeat)) {
        if (event.type === 'keyup') pauseKeys.delete(event.code);
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (event.type === 'keydown') pauseKeys.delete(event.code);
    }
    const pause = isPauseShortcut(event);
    if (pause) pauseKeys.add(/** @type {KeyboardEvent} */ (event).code);
    if (!document.documentElement.hasAttribute('data-glkvm-clean') && !(playerFocused() && event instanceof KeyboardEvent)) {
      if (pause) { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    if (!controlEnabled || moving || !ready || ['dragstart', 'dragover', 'drop'].includes(name)) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (event instanceof KeyboardEvent) {
      if (handleKeyboardShortcut(event) || pause) { event.preventDefault(); event.stopImmediatePropagation(); return; }
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

/**
 * Connection-local audio routing. Runs in the page's main world before vendor
 * scripts, because the vendor player owns capture and playback there. This
 * function is serialized: it must not reference anything outside its body.
 * The bridge is only reachable from this closure; nothing is added to `window`.
 * @param {{subscribe(onRoute: (route: import('./audio.cjs').SentRoute) => void, onRefresh: () => void, onStartup: (startup: {speaker: boolean, microphone: boolean, microphoneAccess: boolean}) => void): void, devices(list: {kind: string, deviceId: string, label: string}[]): void, status(status: import('./audio.cjs').AudioStatus): void, startup(status: import('./audio.cjs').StartupStatus): void}} bridge
 */
function installAudioRouting(bridge) {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices) return;
  const nativeGetUserMedia = MediaDevices.prototype.getUserMedia;
  const nativeEnumerate = MediaDevices.prototype.enumerateDevices;
  const nativePlay = HTMLMediaElement.prototype.play;
  const nativePause = HTMLMediaElement.prototype.pause;
  const nativeStop = MediaStreamTrack.prototype.stop;
  const NativeAudioContext = window.AudioContext;
  const NativeMediaStream = window.MediaStream;
  const srcObject = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject'));
  /** @type {import('./audio.cjs').SentRoute | null} */
  let route = null;
  /** @type {(value?: unknown) => void} */
  let routeArrived = () => {};
  const firstRoute = new Promise(resolve => { routeArrived = resolve; });
  /** @type {() => void} */
  let routeUpdated = () => {};
  /** @type {Promise<void>} */
  let nextRoute = new Promise(resolve => { routeUpdated = resolve; });

  // Output: every media element and page AudioContext follows the selected sink.
  /** @typedef {(HTMLMediaElement | AudioContext) & {setSinkId(id: string | {type: 'none'}): Promise<void>, sinkId: unknown}} Sink */
  /** @type {Set<WeakRef<Sink>>} */
  const sinks = new Set();
  const knownSinks = new WeakSet();
  /** Only 'ok' lets the main process unmute, and only for the generation it was reported with.
   * @type {'pending' | 'ok' | 'missing' | 'error'} */
  let outputState = 'pending';
  let outputVersion = 0;
  /** @type {WeakMap<Sink, {id: string, promise: Promise<void>}>} */
  const pendingSinks = new WeakMap();
  /** @param {Sink} target */
  const sinkMatches = target => typeof route?.output === 'string' && !pendingSinks.has(target) && target.sinkId === route.output;
  // Speaker changes reach Chromium only from applySink, through the methods captured here.
  const nativeMediaSetSinkId = HTMLMediaElement.prototype.setSinkId;
  const nativeContextSetSinkId = /** @type {Partial<Sink> | undefined} */ (NativeAudioContext?.prototype)?.setSinkId;
  /** @param {Sink} target @param {string} id @returns {Promise<void>} */
  const nativeSetSinkId = (target, id) => {
    const method = target instanceof HTMLMediaElement ? nativeMediaSetSinkId : nativeContextSetSinkId;
    return method ? method.call(target, id) : Promise.reject(new DOMException('Speaker selection is not supported.', 'NotSupportedError'));
  };
  /** Overlapping setSinkId calls abort each other, so share one per element and device.
   * Fails closed: without a resolved speaker nothing is applied, not even the system default.
   * @param {Sink} target */
  const applySink = target => {
    const wanted = route?.output;
    if (typeof wanted !== 'string') return Promise.reject(new DOMException('No speaker is selected.', 'NotFoundError'));
    const pending = pendingSinks.get(target);
    if (pending?.id === wanted) return pending.promise;
    if (!pending && target.sinkId === wanted) return Promise.resolve();
    // A queued change whose speaker was replaced meanwhile is skipped; callers check the route again.
    const promise = (pending ? pending.promise.catch(() => {}) : Promise.resolve()).then(() => route?.output === wanted ? nativeSetSinkId(target, wanted) : undefined)
      .finally(() => { if (pendingSinks.get(target)?.promise === promise) pendingSinks.delete(target); });
    pendingSinks.set(target, { id: wanted, promise });
    return promise;
  };
  // The page may only ask for the selected speaker; that request joins the app's queue for the
  // target, so it can neither overtake a newer route nor leave an older one behind. Any other
  // speaker, the system default, or no output is refused: the next route change would move the
  // target back anyway, and meanwhile a playing player or running context would leave the
  // confirmed speaker while the window stays audible.
  for (const proto of /** @type {(Partial<Sink> | undefined)[]} */ ([HTMLMediaElement.prototype, NativeAudioContext?.prototype])) {
    if (typeof proto?.setSinkId !== 'function') continue;
    /** @this {Sink} @param {unknown} id */
    proto.setSinkId = async function setSinkId(id) {
      if (!(this instanceof HTMLMediaElement || (NativeAudioContext && this instanceof NativeAudioContext))) throw new TypeError('Illegal invocation');
      if (typeof id !== 'string' || id !== route?.output) throw new DOMException('The speaker is selected in GLKVM Clean.', 'NotAllowedError');
      register(this);
      await applySink(this);
      // The route moved on meanwhile; the newer route is applied instead.
      if (this.sinkId !== id || route?.output !== id) throw new DOMException('The selected speaker changed.', 'AbortError');
    };
  }
  /** Chromium rejects setSinkId for players whose stream has no audio track; they cannot output anything.
   * Any other player can start or gain audio later, so its failed speaker change is an error.
   * @param {Sink} target */
  const silent = target => {
    if (!(target instanceof HTMLMediaElement)) return target.state === 'closed';
    const source = srcObject.get?.call(target);
    return source instanceof NativeMediaStream && !source.getAudioTracks().length;
  };
  /** An unresolved speaker (null) is never applied, not even as the system default.
   * The main process keeps the window muted while it is unresolved. */
  const unresolved = () => route?.output === null;
  /** Nothing to apply: no route yet or a missing or unresolved speaker (all keep the window muted), or already routed.
   * @param {Sink} target */
  const routed = target => !route || outputState === 'missing' || unresolved() || silent(target) || sinkMatches(target);
  const refreshOutput = async () => {
    if (!route) return;
    const version = ++outputVersion;
    const wanted = route.output;
    /** @type {'ok' | 'missing' | 'error'} */
    let state = 'ok';
    try {
      // Never fall back: a missing or unresolved device stays missing and the window stays muted.
      if (wanted === null) state = 'missing';
      else if (wanted && !(await nativeEnumerate.call(mediaDevices)).some(device => device.kind === 'audiooutput' && device.deviceId === wanted)) state = 'missing';
      // The route may have changed while devices were listed; the newer refresh owns it.
      else if (version !== outputVersion || route?.output !== wanted) return;
      else {
        for (const ref of sinks) if (!ref.deref()) sinks.delete(ref);
        const targets = [...sinks].map(ref => ref.deref()).filter(sink => sink !== undefined);
        const results = await Promise.allSettled(targets.map(applySink));
        if (results.some((result, index) => result.status === 'rejected' && !silent(targets[index]))) state = 'error';
      }
    } catch { state = 'error'; }
    if (version !== outputVersion) return;
    outputState = state;
    report();
  };
  /** A new audible target whose sink still differs withdraws the confirmation until it is routed.
   * @param {unknown} target */
  const register = target => {
    if (!target) return;
    const sink = /** @type {Sink} */ (target);
    if (!knownSinks.has(sink)) { knownSinks.add(sink); sinks.add(new WeakRef(sink)); }
    if (!route || outputState === 'missing' || unresolved() || sinkMatches(sink)) return;
    const quiet = silent(sink) || (sink instanceof NativeAudioContext && typeof sink.sinkId === 'object');
    if (!quiet && outputState === 'ok') { outputState = 'pending'; report(); }
    void refreshOutput();
  };
  /** @type {WeakMap<HTMLMediaElement, {cancel(): void}>} */
  const pendingPlays = new WeakMap();
  /** @this {HTMLMediaElement} */
  const gatedPlay = function play() {
    const target = /** @type {Sink} */ (/** @type {unknown} */ (this));
    register(this);
    // A player without audio starts at once, even before the first route.
    if (silent(target) || sinkMatches(target)) return nativePlay.call(this);
    // Start only on the selected speaker, following route changes while waiting; never on the system default.
    /** @type {() => void} */
    let cancel = () => {};
    const cancelled = new Promise(resolve => { cancel = () => resolve(undefined); });
    const token = { cancel };
    pendingPlays.get(this)?.cancel();
    pendingPlays.set(this, token);
    return (async () => {
      await Promise.race([firstRoute, cancelled]);
      if (pendingPlays.get(this) !== token) throw new DOMException('The play() request was interrupted by a call to pause().', 'AbortError');
      try {
        while (!silent(target) && !sinkMatches(target)) {
          // An initial or superseding unresolved route keeps the window muted,
          // but must not let the player start on the system default either.
          await Promise.race([route?.output === null ? nextRoute : applySink(target), cancelled]);
          if (pendingPlays.get(this) !== token) throw new DOMException('Playback was cancelled.', 'AbortError');
        }
      } catch {
        if (pendingPlays.get(this) !== token) throw new DOMException('Playback was cancelled.', 'AbortError');
        if (pendingPlays.get(this) === token) pendingPlays.delete(this);
        throw new DOMException('The selected speaker could not be used.', 'NotAllowedError');
      }
      if (pendingPlays.get(this) !== token) throw new DOMException('The play() request was interrupted by a call to pause().', 'AbortError');
      pendingPlays.delete(this);
      return nativePlay.call(this);
    })();
  };
  HTMLMediaElement.prototype.play = gatedPlay;
  HTMLMediaElement.prototype.pause = function pause() { pendingPlays.get(this)?.cancel(); pendingPlays.delete(this); return nativePause.call(this); };
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    ...srcObject,
    set(value) { /** @type {(value: unknown) => void} */ (srcObject.set).call(this, value); register(this); },
  });
  // A player gains audio when the page adds a remote audio track to its stream.
  const nativeAddTrack = MediaStream.prototype.addTrack;
  MediaStream.prototype.addTrack = function addTrack(track) {
    nativeAddTrack.call(this, track);
    if (track?.kind === 'audio') for (const ref of sinks) {
      const sink = ref.deref();
      if (sink instanceof HTMLMediaElement && srcObject.get?.call(sink) === this) register(sink);
    }
  };
  if (NativeAudioContext) {
    // New contexts render to no device until the selected speaker is applied.
    const RoutedAudioContext = class AudioContext extends NativeAudioContext {
      /** @param {AudioContextOptions} [options] */
      constructor(options) {
        const direct = route?.output === '' && outputState === 'ok';
        super(direct ? options : /** @type {AudioContextOptions} */ ({ ...options, sinkId: { type: 'none' } }));
        register(this);
      }
    };
    Object.defineProperty(window, 'AudioContext', { value: RoutedAudioContext, writable: true, configurable: true });
    if ('webkitAudioContext' in window) Object.defineProperty(window, 'webkitAudioContext', { value: RoutedAudioContext, writable: true, configurable: true });
  }
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof HTMLMediaElement) register(node);
      else if (node instanceof Element) node.querySelectorAll('audio, video').forEach(register);
    }
  }).observe(document, { childList: true, subtree: true });
  // A start that bypassed play() (autoplay, another frame's play) while the window is
  // audible waits, paused, until it is on the selected speaker.
  document.addEventListener('play', event => {
    const target = event.target;
    if (!(target instanceof HTMLMediaElement)) return;
    const leaking = outputState === 'ok' && !target.paused && !target.muted && !routed(/** @type {Sink} */ (/** @type {unknown} */ (target)));
    register(target);
    if (leaking) { nativePause.call(target); void gatedPlay.call(target).catch(() => {}); }
  }, true);

  // Input: the vendor receives one stable track (and any clones). Switching devices
  // replaces the source behind it, so its own mute (track.enabled) and sender stay intact.
  /** @typedef {{base: MediaTrackConstraints, context: AudioContext, destination: MediaStreamAudioDestinationNode, tracks: Set<MediaStreamTrack>, stream: MediaStream | null, source: MediaStreamAudioSourceNode | null, applied: string | null | undefined, state: 'live' | 'disabled' | 'missing' | 'denied' | 'error', running: Promise<void> | null, again: boolean, stopped: boolean}} Capture */
  /** @type {Set<Capture>} */
  const captures = new Set();
  /** @type {WeakMap<MediaStreamTrack, Capture>} */
  const owners = new WeakMap();
  /** Device streams that are open, including requests that resolved after being superseded.
   * @type {Set<MediaStream>} */
  const openStreams = new Set();
  /** @type {Capture | null} */
  let latest = null;
  /** The automatic microphone start in progress. Captures the page requests meanwhile report
   * to it, so an older attempt's outcome never counts for a newer one.
   * A capture of another attempt (or none) failing meanwhile marks it foreign: a firmware dialog
   * that appears then is not this attempt's evidence.
   * @type {{capture: Capture | null, failed: 'denied' | 'error' | null, foreign: boolean} | null} */
  let microphoneAttempt = null;
  /** @param {MediaStream} stream */
  const release = stream => { stream.getTracks().forEach(track => nativeStop.call(track)); openStreams.delete(stream); };
  /** @param {Capture} capture */
  const detach = capture => {
    capture.source?.disconnect();
    if (capture.stream) release(capture.stream);
    capture.source = null; capture.stream = null; capture.applied = undefined;
  };
  // An unresolved microphone wants no device, so a pending request for any device is superseded.
  const desiredInput = () => route?.inputAllowed && !route.inputMissing ? route.input : null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let watchdog = null;
  /** @param {Capture} capture */
  const stopCapture = capture => {
    if (capture.stopped) return;
    capture.stopped = true;
    detach(capture);
    for (const track of capture.tracks) nativeStop.call(track);
    capture.tracks.clear();
    void capture.context.close().catch(() => {});
    captures.delete(capture);
    if (latest === capture) latest = [...captures].at(-1) || null;
    if (!captures.size && watchdog) { clearInterval(watchdog); watchdog = null; }
    report();
  };
  // The capture ends when the vendor has stopped every track derived from it,
  // however it stops them (including another frame's MediaStreamTrack.prototype.stop).
  /** @param {Capture} capture */
  const pruneTracks = capture => {
    for (const track of capture.tracks) if (track.readyState === 'ended') capture.tracks.delete(track);
    if (!capture.tracks.size) stopCapture(capture);
  };
  MediaStreamTrack.prototype.stop = function stop() {
    nativeStop.call(this);
    const capture = owners.get(this);
    if (capture) pruneTracks(capture);
  };
  const nativeClone = MediaStreamTrack.prototype.clone;
  /** @param {MediaStreamTrack} track */
  const cloneTrack = track => {
    const copy = nativeClone.call(track);
    const capture = owners.get(track);
    if (capture && !capture.stopped && copy.readyState === 'live') { owners.set(copy, capture); capture.tracks.add(copy); }
    return copy;
  };
  MediaStreamTrack.prototype.clone = function clone() { return cloneTrack(this); };
  // The native stream clone copies tracks without MediaStreamTrack.prototype.clone, so clone them here.
  const nativeGetTracks = MediaStream.prototype.getTracks;
  MediaStream.prototype.clone = function clone() { return new NativeMediaStream(nativeGetTracks.call(this).map(cloneTrack)); };
  /** @param {Capture} capture @param {MediaStream} stream @param {string} deviceId */
  const attach = (capture, stream, deviceId) => {
    const source = capture.context.createMediaStreamSource(stream);
    source.connect(capture.destination);
    detach(capture);
    capture.source = source; capture.stream = stream; capture.applied = deviceId; capture.state = 'live';
    // Unplugging ends the device track; stay silent until the same device returns.
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      release(stream);
      if (capture.stream !== stream) return;
      detach(capture); capture.state = 'missing'; report();
    });
    void capture.context.resume().catch(() => {});
  };
  /** Disabling takes effect at once, even while a device request is still pending.
   * @param {Capture} capture */
  const suspend = capture => { detach(capture); capture.state = 'disabled'; };
  /** Serialize device requests per capture; the newest route always wins.
   * @param {Capture} capture */
  const reconcile = capture => {
    if (capture.running) { capture.again = true; return capture.running; }
    const run = async () => {
      do {
        capture.again = false;
        while (!capture.stopped && route) {
          // An enabled microphone that cannot be resolved stays silent; nothing is opened.
          if (route.inputAllowed && route.inputMissing) { detach(capture); capture.state = 'missing'; break; }
          const wanted = desiredInput();
          if (wanted === null) { suspend(capture); break; }
          if (capture.applied === wanted && capture.stream?.getAudioTracks()[0]?.readyState === 'live') break;
          let stream;
          try {
            stream = await nativeGetUserMedia.call(mediaDevices, { audio: { ...capture.base, ...(wanted ? { deviceId: { exact: wanted } } : {}) } });
            openStreams.add(stream);
          } catch (error) {
            const name = error instanceof DOMException ? error.name : '';
            if (desiredInput() !== wanted) continue;
            // Never keep sending from the previous device when the selected one fails.
            detach(capture);
            capture.state = ['NotFoundError', 'OverconstrainedError', 'NotReadableError'].includes(name) ? 'missing' : ['NotAllowedError', 'SecurityError'].includes(name) ? 'denied' : 'error';
            break;
          }
          // A request superseded while pending must not stay open.
          if (capture.stopped || desiredInput() !== wanted) { release(stream); continue; }
          attach(capture, stream, wanted);
        }
      } while (capture.again && !capture.stopped);
    };
    // Clear only after the run settles; a route that arrived meanwhile runs again.
    capture.running = run().finally(() => {
      capture.running = null;
      if (capture.again && !capture.stopped) void reconcile(capture);
      else report();
    });
    return capture.running;
  };
  /** @param {typeof microphoneAttempt} attempt @param {'denied' | 'error'} state */
  const failedFor = (attempt, state) => {
    if (attempt) attempt.failed ||= state;
    if (microphoneAttempt && microphoneAttempt !== attempt) microphoneAttempt.foreign = true;
  };
  /** @param {boolean | MediaTrackConstraints} audio */
  const createCapture = async audio => {
    const attempt = microphoneAttempt;
    const timeout = new Promise(resolve => setTimeout(resolve, 5000));
    await Promise.race([firstRoute, timeout]);
    if (!route?.inputAllowed) { failedFor(attempt, 'denied'); throw new DOMException('Microphone access is disabled for this connection.', 'NotAllowedError'); }
    const base = audio && typeof audio === 'object' ? { ...audio } : {};
    delete base.deviceId; delete base.groupId;
    const context = new NativeAudioContext(/** @type {AudioContextOptions} */ ({ latencyHint: 'interactive', sinkId: { type: 'none' } }));
    const destination = context.createMediaStreamDestination();
    const track = destination.stream.getAudioTracks()[0];
    /** @type {Capture} */
    const capture = { base, context, destination, tracks: new Set([track]), stream: null, source: null, applied: undefined, state: 'disabled', running: null, again: false, stopped: false };
    owners.set(track, capture);
    captures.add(capture); latest = capture;
    if (attempt) attempt.capture = capture;
    watchdog ||= setInterval(() => { for (const item of captures) pruneTracks(item); }, 1000);
    await reconcile(capture);
    if (capture.state === 'denied' || capture.state === 'error') {
      const state = capture.state;
      failedFor(attempt, state);
      stopCapture(capture);
      throw new DOMException(state === 'denied' ? 'Microphone permission was denied.' : 'The microphone could not be started.', state === 'denied' ? 'NotAllowedError' : 'NotReadableError');
    }
    return new NativeMediaStream([track]);
  };
  MediaDevices.prototype.getUserMedia = function getUserMedia(constraints) {
    // Camera and combined requests keep the native path, which the app denies.
    if (this !== mediaDevices || !constraints || typeof constraints !== 'object' || !constraints.audio || constraints.video) return nativeGetUserMedia.call(this, constraints);
    return createCapture(constraints.audio);
  };

  let lastStatus = '';
  function report() {
    if (!route) return;
    /** @type {import('./audio.cjs').AudioStatus} */
    const status = { input: latest?.state || 'idle', inputDevice: latest?.applied ?? null, openInputs: openStreams.size, generation: route.generation, output: route.output, outputState };
    const key = JSON.stringify(status);
    if (key !== lastStatus) { lastStatus = key; bridge.status(status); }
  }
  const reportDevices = async () => {
    try {
      const list = await nativeEnumerate.call(mediaDevices);
      bridge.devices(list.filter(device => (device.kind === 'audioinput' || device.kind === 'audiooutput') && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
        .map(device => ({ kind: device.kind, deviceId: device.deviceId, label: device.label })));
    } catch {}
  };
  mediaDevices.addEventListener('devicechange', () => {
    void reportDevices();
    void refreshOutput();
    for (const capture of captures) if (capture.state !== 'live' && capture.state !== 'disabled') void reconcile(capture);
  });
  bridge.subscribe(next => {
    if (!Number.isInteger(next.generation) || (route && next.generation <= route.generation)) return;
    const previous = route;
    route = { inputAllowed: next.inputAllowed === true, input: typeof next.input === 'string' ? next.input : null, inputMissing: next.inputMissing === true, output: typeof next.output === 'string' ? next.output : null, generation: next.generation };
    const current = route;
    const updated = routeUpdated;
    nextRoute = new Promise(resolve => { routeUpdated = resolve; });
    updated();
    routeArrived();
    // A different speaker is unconfirmed until applied; the same confirmed speaker stays valid.
    if (!previous || previous.output !== route.output || outputState !== 'ok') { outputState = 'pending'; void refreshOutput(); }
    for (const capture of captures) {
      // Disabled or unresolved takes effect at once, even while a device request is pending.
      if (current.inputAllowed && current.inputMissing) { detach(capture); capture.state = 'missing'; }
      else if (desiredInput() === null) suspend(capture);
      void reconcile(capture);
    }
    // Microphone IDs are only exposed while a microphone is enabled for this connection.
    if (!previous || previous.inputAllowed !== current.inputAllowed) void reportDevices();
    report();
    startupTick();
  }, () => { void reportDevices(); }, next => {
    startup = { speaker: next.speaker === true, microphone: next.microphone === true, microphoneAccess: next.microphoneAccess === true };
    startupTimer ||= setInterval(startupTick, 500);
    startupTick();
  });

  // Startup state for the device page's own Sound and Microphone controls, applied once per
  // video session: a new page, or a new live video track after a reconnect. Buffering, focus,
  // speaker or audio-only changes keep the session, so later manual changes stay untouched.
  // Only the firmware's own setters are used (kvm.setVolumeOn, audioMic.setMicMuted); its USB
  // device configuration and reconnect callback are never touched.
  /** @type {{speaker: boolean, microphone: boolean, microphoneAccess: boolean} | null} */
  let startup = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let startupTimer = null;
  /** The session already handled; marked before any setter runs. @type {object | null} */
  let handledSession = null;
  /** The session waiting to apply, with its early microphone-off result once the stores were usable.
   * @type {{session: object, wanted: {speaker: boolean, microphone: boolean, microphoneAccess: boolean}, since: number, microphone: import('./audio.cjs').StartupState | null} | null} */
  let pendingStartup = null;
  let startupRuns = 0;
  /** When recent sessions started applying: at most five per five seconds. @type {number[]} */
  let startupStarts = [];
  /** One failed microphone start per page: no repeated permission prompts or firmware dialogs.
   * @type {'denied' | 'error' | null} */
  let microphoneBlocked = null;
  /** @param {unknown} value @param {string} key @returns {unknown} */
  const field = (value, key) => value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value)[key] : undefined;
  /** @param {unknown} target @param {string} name @param {boolean} value */
  const invoke = (target, name, value) => { Reflect.apply(/** @type {Function} */ (field(target, name)), target, [value]); };
  /** The firmware's Pinia stores, once the player has mounted them. */
  const firmware = () => {
    const pinia = field(field(field(field(document.querySelector('#app'), '__vue_app__'), 'config'), 'globalProperties'), '$pinia');
    const registry = field(pinia, '_s');
    if (!(registry instanceof Map)) return null;
    const kvm = registry.get('kvm'), mic = registry.get('audioMic'), usb = registry.get('usbManagement');
    const config = field(kvm, 'configState'), micState = field(mic, 'state');
    if (typeof field(kvm, 'setVolumeOn') !== 'function' || typeof field(config, 'volumeOn') !== 'boolean' || typeof field(config, 'initVideoSessionFinished') !== 'boolean'
      || typeof field(mic, 'setMicMuted') !== 'function' || typeof field(micState, 'micMuted') !== 'boolean' || typeof field(usb, 'initLoading') !== 'boolean') return null;
    return { kvm, config, mic, micState, usb };
  };
  /** The live video track, or the Direct H.264 canvas, identifies the current video session. */
  const videoSession = () => {
    const video = document.querySelector('#stream-video');
    if (video instanceof HTMLVideoElement) {
      const stream = srcObject.get?.call(video);
      const track = stream instanceof NativeMediaStream ? stream.getVideoTracks().find(item => item.readyState === 'live') : undefined;
      return track && video.videoWidth > 0 ? track : null;
    }
    const canvas = document.querySelector('#stream-canvas');
    return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0 ? canvas : null;
  };
  /** @param {() => boolean} current @param {boolean} value @param {(value: boolean) => void} set @returns {import('./audio.cjs').StartupState} */
  const apply = (current, value, set) => {
    if (current() === value) return 'unchanged';
    try { set(value); } catch { return 'error'; }
    return current() === value ? 'applied' : 'error';
  };
  /** @param {{speaker: boolean, microphone: boolean}} wanted @param {import('./audio.cjs').StartupState} speakerState @param {import('./audio.cjs').StartupState} microphoneState */
  const reportStartup = (wanted, speakerState, microphoneState) => bridge.startup({ speaker: wanted.speaker, microphone: wanted.microphone, speakerState, microphoneState });
  function startupTick() {
    if (!startup || !route) return;
    const session = videoSession();
    if (!session || session === handledSession) return;
    if (pendingStartup?.session !== session) {
      // A newer setting applies to the next session only; this one keeps its snapshot.
      pendingStartup = { session, wanted: { ...startup }, since: Date.now(), microphone: null };
      reportStartup(pendingStartup.wanted, 'waiting', 'waiting');
    }
    const { wanted, since } = pendingStartup;
    const stores = firmware();
    // A microphone the firmware's audio session kept on across a video-only reconnect transmits
    // until startup applies, so microphone off applies as soon as the stores are usable, before
    // the waits and the rate limit below. Once per session: a manual change afterwards stays.
    if (!wanted.microphone && stores && pendingStartup.microphone === null && field(stores.kvm, 'isDirectMode') !== true) {
      const { mic, micState } = stores;
      pendingStartup.microphone = apply(() => field(micState, 'micMuted') === false, false, on => invoke(mic, 'setMicMuted', !on));
      reportStartup(wanted, 'waiting', pendingStartup.microphone);
    }
    const { microphone } = pendingStartup;
    const signingIn = [...document.querySelectorAll('input[type="password"]')].some(input => input.getBoundingClientRect().width > 0);
    if (signingIn || !stores || field(stores.usb, 'initLoading') !== false || field(stores.config, 'initVideoSessionFinished') !== true) {
      if (Date.now() - since < 30000) return;
      // Bounded: report once and wait for the next session instead of retrying.
      handledSession = session; pendingStartup = null;
      const state = stores ? 'error' : 'unsupported';
      reportStartup(wanted, state, microphone ?? state);
      return;
    }
    // Bounds a firmware that keeps replacing its video track: a session over the limit stays
    // waiting and applies once the limit allows, unless a newer session replaces it first.
    const now = Date.now();
    startupStarts = startupStarts.filter(time => now - time < 5000);
    if (startupStarts.length >= 5) return;
    startupStarts.push(now);
    handledSession = session; pendingStartup = null;
    void applyStartup(stores, session, wanted, ++startupRuns, microphone);
  }
  const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));
  /** @param {NonNullable<ReturnType<typeof firmware>>} stores @param {object} session @param {{speaker: boolean, microphone: boolean, microphoneAccess: boolean}} wanted @param {number} run
   * @param {import('./audio.cjs').StartupState | null} early The session's microphone-off result, already applied. */
  const applyStartup = async ({ kvm, config, mic, micState, usb }, session, wanted, run, early) => {
    const volumeOn = () => field(config, 'volumeOn') === true;
    const micOn = () => field(micState, 'micMuted') === false;
    // Checked after every wait, before anything is changed or reported: a newer session reports for itself.
    const fresh = () => run === startupRuns && videoSession() === session;
    const setMicrophone = (/** @type {boolean} */ on) => invoke(mic, 'setMicMuted', !on);
    // The firmware has no sound or microphone in Direct H.264 mode.
    if (field(kvm, 'isDirectMode') === true) {
      reportStartup(wanted, volumeOn() === wanted.speaker ? 'unchanged' : 'unsupported', early ?? (micOn() === wanted.microphone ? 'unchanged' : 'unsupported'));
      return;
    }
    const speakerState = apply(volumeOn, wanted.speaker, on => invoke(kvm, 'setVolumeOn', on));
    // A saved microphone resolves once the session's device ID salt is readable, up to about 10 s
    // after the page's first device request. Wait for it (bounded) instead of reporting it missing.
    if (wanted.microphone && !micOn() && route?.inputAllowed && route.inputMissing) {
      reportStartup(wanted, speakerState, 'waiting');
      for (let i = 0; i < 200 && !micOn() && route?.inputAllowed && route.inputMissing; i++) {
        await sleep(100);
        if (!fresh()) return;
      }
    }
    /** @type {import('./audio.cjs').StartupState} */
    let microphoneState;
    if (early) microphoneState = early;
    else if (!wanted.microphone || micOn()) microphoneState = apply(micOn, wanted.microphone, setMicrophone);
    // Only with the device's USB microphone on and a microphone selected for the current window state.
    else if (field(usb, 'enableMic') !== true || !route?.inputAllowed || route.input === null || route.inputMissing) microphoneState = 'unavailable';
    else if (!wanted.microphoneAccess) microphoneState = 'denied';
    else if (microphoneBlocked) microphoneState = microphoneBlocked;
    else {
      const attempt = { capture: /** @type {Capture | null} */ (null), failed: /** @type {'denied' | 'error' | null} */ (null), foreign: false };
      // A firmware audio session that outlives the video session keeps its muted microphone track
      // (disabled, still capturing) and unmutes it by enabling it again, without a new request.
      // Only the page's own track changes from disabled to enabled during the attempt.
      const disabled = [...captures].flatMap(capture => [...capture.tracks].filter(track => track.readyState === 'live' && !track.enabled));
      const reenabled = () => [...captures].find(capture => !capture.stopped && [...capture.tracks].some(track => disabled.includes(track) && track.enabled && track.readyState === 'live')) || null;
      microphoneAttempt = attempt;
      try {
        microphoneState = apply(micOn, true, setMicrophone);
        if (microphoneState === 'applied') {
          reportStartup(wanted, speakerState, 'waiting');
          // Wait (bounded) for the page's own capture, requested or re-enabled: live, failed, ended by
          // the firmware, or never started. A pending request, such as the macOS permission prompt, gets longer.
          const started = Date.now();
          // The firmware ends a failed attempt (a failed capture or audio answer) with this dialog,
          // shown before it mutes. Only a dialog opened during this attempt counts: one still open
          // from earlier (a failed manual capture or an older attempt) is no evidence, and the
          // firmware opens no second one meanwhile. Such an ambiguous end counts as turned off on
          // the page: at worst a failure is retried once in the next session, never a false block.
          const openDialogs = () => [...document.querySelectorAll('.mic-permission-error-modal')].filter(dialog => dialog.getClientRects().length > 0);
          const earlier = new Set(openDialogs());
          let dialogShown = false;
          const failureShown = () => {
            const open = openDialogs();
            // A closed earlier dialog that opens again belongs to this attempt.
            for (const dialog of earlier) if (!open.includes(dialog)) earlier.delete(dialog);
            dialogShown ||= !attempt.foreign && open.some(dialog => !earlier.has(dialog));
            return dialogShown;
          };
          /** @type {'applied' | 'denied' | 'error' | 'cancelled' | null} */
          let outcome = null;
          while (!outcome) {
            await sleep(100);
            if (!fresh()) return;
            // A capture requested during the attempt replaces a re-enabled one.
            const capture = attempt.capture ||= reenabled();
            failureShown();
            if (attempt.failed) outcome = attempt.failed;
            else if (capture?.state === 'live' && !capture.stopped) outcome = 'applied';
            else if (!micOn()) {
              // Turned off without a failure or the firmware's dialog (given a moment to appear):
              // turned off on the page, which ends the attempt for this session only.
              for (let i = 0; i < 5 && !attempt.failed && !failureShown(); i++) {
                await sleep(100);
                if (!fresh()) return;
              }
              outcome = attempt.failed || (failureShown() ? 'error' : 'cancelled');
            }
            else if (Date.now() - started > (capture?.running ? 60000 : 15000)) outcome = 'error';
          }
          if (outcome === 'denied' || outcome === 'error') {
            microphoneBlocked = outcome;
            // End an attempt the firmware left on; a microphone it already turned off is not touched.
            if (micOn()) try { setMicrophone(false); } catch {}
          }
          // The startup setting was applied; a later session applies it again.
          microphoneState = outcome === 'cancelled' ? 'applied' : outcome;
        }
      } finally {
        if (microphoneAttempt === attempt) microphoneAttempt = null;
      }
    }
    reportStartup(wanted, speakerState, microphoneState);
  };
}

/** @type {((route: unknown) => void) | null} */
let audioRouteListener = null;
/** @type {(() => void) | null} */
let audioRefreshListener = null;
/** @type {((startup: unknown) => void) | null} */
let audioStartupListener = null;
try {
  contextBridge.executeInMainWorld({
    func: installAudioRouting,
    args: [{
      subscribe: (/** @type {(route: unknown) => void} */ onRoute, /** @type {() => void} */ onRefresh, /** @type {(startup: unknown) => void} */ onStartup) => { audioRouteListener = onRoute; audioRefreshListener = onRefresh; audioStartupListener = onStartup; },
      devices: (/** @type {unknown} */ list) => ipcRenderer.send('glkvm:audio-devices', list),
      status: (/** @type {unknown} */ status) => ipcRenderer.send('glkvm:audio-status', status),
      startup: (/** @type {unknown} */ status) => ipcRenderer.send('glkvm:audio-startup-status', status),
    }],
  });
  ipcRenderer.on('glkvm:audio-route', (_event, route) => audioRouteListener?.(route));
  ipcRenderer.on('glkvm:audio-refresh', () => audioRefreshListener?.());
  ipcRenderer.on('glkvm:audio-startup', (_event, startup) => audioStartupListener?.(startup));
  ipcRenderer.send('glkvm:audio-ready');
} catch {
  // Without the adapter, the main process keeps this window muted.
}
