const { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, safeStorage, globalShortcut, clipboard, systemPreferences, autoUpdater, shell } = require('electron');
if (process.platform === 'darwin' && !app.isPackaged) {
  console.error('Use bun start to run the signed GLKVM app. Generic Electron cannot access app credentials.');
  app.exit(1);
}
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createCover } = require('./connection-cover.cjs');
const { isDeviceURL } = require('./devices.cjs');
const { defaults, readConfig, writeConfig, partitionFor } = require('./config.cjs');
const { publicConfig, prepareConfig, readPassword } = require('./credentials.cjs');
const { fingerprint, isPinned } = require('./certificates.cjs');
const { scales, windowSize } = require('./window-sizes.cjs');
const { defaultAudio, resolveDevice, routeFor, mediaPermission, validateDeviceReport, validateAudioStatus, validateStartupStatus, nextRoute, routeChanged, outputRouted } = require('./audio.cjs');
const { watchCatalog, catalogPath, deviceLabels } = require('./audio-catalog.cjs');
const { browserDeviceId, readDeviceIdSalt, supportedRuntime } = require('./device-ids.cjs');

const { keyboardAction, matchesBinding } = require('./keyboard.cjs');
const { setupUpdates } = require('./updates.cjs');
/** @type {ReturnType<typeof setupUpdates>} */
let updates = null;
app.setName('GLKVM Clean');
/** @typedef {import('./config.cjs').Device} Device */
/** @typedef {{window: Electron.BrowserWindow, device: Device, controlEnabled: boolean, moving: boolean, streaming: boolean, playerFocused?: boolean, needsLogin: boolean, loginStatus: string, loginTimer: ReturnType<typeof setTimeout> | null, cover: ReturnType<typeof createCover> | null, pageReady: boolean, pageLoaded: boolean, manualLogin: boolean, revealActive: boolean, revealMinimized: boolean, pausedForeground: boolean | null, background: boolean, options: boolean, cleanBounds: Electron.Rectangle | null, selectedScale: number | null, chrome: {width: number, height: number} | null, videoSize: {width: number, height: number} | null, audio: import('./audio.cjs').RouteState & {ready: boolean, devices: import('./audio.cjs').AudioDevices | null, status: import('./audio.cjs').AudioStatus | null, startup: import('./audio.cjs').StartupStatus | null, salt: string | null, saltAttempts: number, saltTimer: ReturnType<typeof setTimeout> | null}}} Entry */
/** @type {Map<string, Entry>} */
const windows = new Map();
/** @type {Map<string, Entry>} */
const consoles = new Map();
const configuredSessions = new Set();
const certificatePrompts = new Map();
/** @type {Record<string, string>} */
let pins = {};
let pinPath = '';
let configPath = '';
let config = defaults();
/** @type {Electron.BrowserWindow | null} */
let settingsWindow = null;
let lastDeviceId = '';
/** Paused audio switching is app-wide and in memory only, so it ends with the process. */
let audioSwitchingPaused = false;
let settingsRecording = false;
const settingsURL = pathToFileURL(path.join(__dirname, 'settings.html')).href;

function allEntries() { return [...windows.values(), ...consoles.values()]; }
function focusedEntry() {
  const focused = BrowserWindow.getFocusedWindow();
  return allEntries().find(entry => entry.window === focused || entry.cover?.window === focused);
}
function currentDevice() { return focusedEntry()?.device || config.devices.find(device => device.id === lastDeviceId) || config.devices[0]; }
/** @param {Entry} entry */
function sendMode(entry) {
  entry.cover?.update(entry.loginStatus, entry.device.name);
  entry.window.webContents.send('glkvm:mode', { controlEnabled: entry.controlEnabled, moving: entry.moving, options: entry.options, keyboard: config.keyboard, videoPoints: entry.options && entry.selectedScale != null && entry.videoSize ? windowSize(entry.videoSize, entry.selectedScale, screen.getDisplayMatching(entry.window.getBounds()).workArea, screen.getDisplayMatching(entry.window.getBounds()).scaleFactor) : null, name: entry.device.name, loginStatus: entry.loginStatus });
}
/** @param {Entry} entry */
function dismissCover(entry) {
  const cover = entry.cover;
  entry.cover = null;
  cover?.close();
}
/** @param {Entry} entry */
function ensureCover(entry) {
  if (entry.manualLogin || !isViewer(entry)) return;
  if (!entry.cover) entry.revealMinimized = entry.window.isMinimized();
  if (entry.window.isVisible() && !entry.window.isMinimized()) {
    if (!entry.cover) entry.revealActive = entry.window.isFocused();
    entry.window.hide();
  }
  if (entry.cover) return;
  entry.cover = createCover(entry.window, entry.device.name, action => {
    if (action === 'manual') setDeviceOptions(entry, true);
    else if (action === 'close') entry.window.close();
    else if (action === 'minimize') entry.window.minimize();
    else if (action === 'focus') { lastDeviceId = entry.device.id; installMenu(); }
  });
  handleAppShortcuts(entry.cover.window.webContents, false);
}
/** @param {Entry} entry */
function revealDevice(entry) {
  if (!entry.pageLoaded || !entry.pageReady || entry.needsLogin) return;
  if (entry.loginTimer) clearTimeout(entry.loginTimer);
  entry.loginTimer = null;
  entry.loginStatus = '';
  entry.manualLogin = false;
  const focused = BrowserWindow.getFocusedWindow();
  const active = entry.cover?.window.isFocused() || (entry.revealActive && app.isActive() && (!focused || focused === entry.window));
  dismissCover(entry);
  sendMode(entry);
  if (!entry.background && !entry.revealMinimized && !entry.window.isVisible()) {
    if (active) entry.window.show();
    else {
      // Frameless macOS windows can activate asynchronously even with showInactive.
      entry.window.setFocusable(false);
      entry.window.showInactive();
      setImmediate(() => { if (!entry.window.isDestroyed()) entry.window.setFocusable(true); });
      if (focused && !focused.isDestroyed()) focused.focus();
    }
  }
}
/** @param {Entry} entry @param {string} [status] */
function beginLogin(entry, status = 'Signing in…') {
  if (entry.loginTimer) clearTimeout(entry.loginTimer);
  entry.loginStatus = status;
  ensureCover(entry);
  // Start before loading the helper: unreachable devices never install a preload.
  entry.loginTimer = setTimeout(() => {
    entry.loginTimer = null;
    if (entry.window.isDestroyed() || !entry.loginStatus) return;
    entry.loginStatus = entry.needsLogin
      ? 'Sign-in did not complete. Check your password or connection, or continue in Device Settings (⌘⇧O).'
      : 'Connection did not complete. Check the device and network connection. Use Device → Reload to retry.';
    sendMode(entry);
  }, 20000);
  sendMode(entry);
}
/** @param {Entry} entry */
function releaseInput(entry) { entry.window.webContents.send('glkvm:release-input'); }
/** @param {Entry} entry */
function toggleMode(entry) {
  releaseInput(entry);
  entry.moving = entry.controlEnabled && !entry.moving;
  entry.controlEnabled = true;
  entry.window.webContents.setIgnoreMenuShortcuts(false);
  entry.window.webContents.focus();
  sendMode(entry);
  installMenu();
}
/** @returns {Map<string, () => void>} */
function appShortcuts() {
  const shortcuts = new Map();
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused) return shortcuts;
  shortcuts.set('CommandOrControl+W', () => {
    const entry = focusedEntry();
    if (entry) releaseInput(entry);
    focused.close();
  });
  shortcuts.set('CommandOrControl+Q', () => {
    for (const entry of allEntries()) releaseInput(entry);
    app.quit();
  });
  config.devices.slice(0, 9).forEach((device, index) => shortcuts.set(`CommandOrControl+${index + 1}`, () => showDevice(device)));
  shortcuts.set('CommandOrControl+Shift+O', toggleDeviceSettings);
  const entry = focusedEntry();
  if (entry && windows.get(entry.device.id) === entry && !entry.options) {
    shortcuts.set('CommandOrControl+Shift+M', () => toggleMode(entry));
  }
  return shortcuts;
}
const registeredShortcuts = new Set();
function updateModeShortcuts() {
  const wanted = appShortcuts();
  for (const accelerator of registeredShortcuts) {
    if (!wanted.has(accelerator)) { globalShortcut.unregister(accelerator); registeredShortcuts.delete(accelerator); }
  }
  for (const accelerator of wanted.keys()) {
    if (registeredShortcuts.has(accelerator)) continue;
    if (globalShortcut.register(accelerator, () => appShortcuts().get(accelerator)?.())) registeredShortcuts.add(accelerator);
  }
}
/** The audio switching shortcut works in every app window and mode. A connection page consumes
 * it itself (see preload.cjs), so held modifiers never reach the remote computer; other windows
 * drop the key here, except while Settings records a shortcut.
 * @param {Electron.WebContents} contents @param {boolean} [pageConsumes] */
function handleAppShortcuts(contents, pageConsumes = false) {
  /** @type {Set<string>} */
  const dropped = new Set();
  contents.on('before-input-event', (event, input) => {
    // A dropped key stays dropped until released, even after its modifiers are; a fresh press means its keyUp was missed.
    if (dropped.has(input.code) && (input.type === 'keyUp' || input.isAutoRepeat)) {
      if (input.type === 'keyUp') dropped.delete(input.code);
      event.preventDefault(); return;
    }
    if (input.type === 'keyDown') dropped.delete(input.code);
    const recording = settingsRecording && !!settingsWindow && contents === settingsWindow.webContents;
    if (input.type === 'keyDown' && !recording && matchesBinding(config.keyboard?.pauseAudioSwitching, input)) {
      if (!input.isAutoRepeat) toggleAudioSwitching();
      if (!pageConsumes) { event.preventDefault(); dropped.add(input.code); }
      return;
    }
    const command = process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
    if (!command || input.alt) return;
    const key = input.key.toUpperCase();
    const accelerator = `CommandOrControl+${input.shift ? 'Shift+' : ''}${key}`;
    const action = appShortcuts().get(accelerator);
    if (!action) return;
    event.preventDefault();
    if (input.type === 'keyDown' && !input.isAutoRepeat) action();
  });
}
/** @param {Entry} entry @param {{width: number, height: number}} size @param {number} scale */
function resizeWindow(entry, size, scale) {
  const win = entry.window;
  if (win.isFullScreen()) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const fitted = windowSize(size, scale, display.workArea, display.scaleFactor);
  if (!fitted.fits) return;
  entry.selectedScale = scale;
  if (entry.options && !entry.chrome) { sendMode(entry); return; }
  const width = entry.options ? Math.max(720, fitted.width + (entry.chrome?.width || 0)) : fitted.width;
  const height = entry.options ? Math.max(500, fitted.height + (entry.chrome?.height || 0)) : fitted.height;
  if (width > display.workArea.width || height > display.workArea.height) return;
  win.setAspectRatio(0);
  win.setContentSize(width, height);
  sendMode(entry);
  if (!entry.options) win.setAspectRatio(fitted.width / fitted.height);
  const bounds = win.getBounds();
  const work = display.workArea;
  win.setPosition(Math.round(Math.max(work.x, Math.min(bounds.x, work.x + work.width - bounds.width))),
    Math.round(Math.max(work.y, Math.min(bounds.y, work.y + work.height - bounds.height))));
  installMenu();
}
/** @param {Electron.IpcMainEvent | Electron.IpcMainInvokeEvent} event */
function deviceSender(event) {
  return allEntries().find(entry => entry.window.webContents === event.sender && event.senderFrame === event.sender.mainFrame && isDeviceURL(event.senderFrame.url, entry.device));
}

/** @param {Entry} entry */
function isViewer(entry) { return windows.get(entry.device.id) === entry; }
/** While audio switching is paused, each viewer keeps the profile it had when the pause began.
 * @param {Entry} entry */
function usesForeground(entry) {
  return audioSwitchingPaused ? isViewer(entry) && entry.pausedForeground === true : isForeground(entry);
}
/** Pausing keeps each viewer's selected profile, not its resolved devices: device discovery,
 * permissions and mute continue. Resuming follows native focus again at once. */
function toggleAudioSwitching() {
  audioSwitchingPaused = !audioSwitchingPaused;
  for (const entry of windows.values()) entry.pausedForeground = audioSwitchingPaused ? isForeground(entry) : null;
  installMenu();
  syncAudio();
}
/** The focused, visible, non-minimized viewer uses the foreground profile; all others use background.
 * @param {Entry} entry */
function isForeground(entry) {
  const win = entry.window;
  return isViewer(entry) && !win.isDestroyed() && win.isFocused() && win.isVisible() && !win.isMinimized();
}
/** @type {import('./audio-catalog.cjs').NativeDevice[] | null} */
let catalog = null;
const catalogWatcher = watchCatalog(catalogPath(process.resourcesPath), devices => {
  catalog = devices;
  for (const entry of windows.values()) entry.audio.saltAttempts = 0;
  migrateLegacyChoices();
  syncAudio();
});
/** The catalog runs only while settings or a connection window is open. */
function updateCatalog() {
  if (settingsWindow || windows.size) catalogWatcher.start(); else catalogWatcher.stop();
}
/** Reads the connection session's device ID salt (see device-ids.cjs); never written or logged.
 * @param {Electron.Session} ses */
function sessionSalt(ses) {
  const storage = ses.getStoragePath();
  return storage && supportedRuntime(process.versions) ? readDeviceIdSalt(storage) : null;
}
/** @param {Entry} entry @returns {import('./audio.cjs').AudioRoute} */
function currentRoute(entry) {
  const resolution = { origin: entry.device.origin, salt: entry.audio.salt, reported: entry.audio.devices, catalog: catalog || [] };
  return routeFor(entry.device.audio || defaultAudio(), usesForeground(entry), (choice, kind) => resolveDevice(choice, kind, resolution));
}
/** Settings from older versions stored a page deviceId. Replace it with the native device
 * whose hash it exactly is; otherwise keep it, unresolved. Saved with the next settings change. */
function migrateLegacyChoices() {
  if (!catalog) return;
  for (const device of config.devices) {
    const audio = device.audio;
    const choices = audio ? [audio.foreground, audio.background].flatMap(profile => [profile.input, profile.output]) : [];
    if (!audio || !choices.some(choice => typeof choice === 'object' && 'deviceId' in choice)) continue;
    const salt = sessionSalt(session.fromPartition(partitionFor(device)));
    if (!salt) continue;
    const hashes = new Map(catalog.map(item => [browserDeviceId(device.origin, item.uid, salt), item]));
    /** @param {import('./audio.cjs').InputChoice} choice */
    const migrate = choice => {
      if (typeof choice !== 'object' || !('deviceId' in choice)) return choice;
      const match = hashes.get(choice.deviceId);
      return match ? { uid: match.uid, label: choice.label } : choice;
    };
    for (const profile of [audio.foreground, audio.background]) {
      profile.input = migrate(profile.input);
      profile.output = /** @type {import('./audio.cjs').OutputChoice} */ (migrate(profile.output));
    }
  }
}
/** @param {'check' | 'request'} kind @param {Electron.WebContents | null} contents @param {string} permission @param {Electron.PermissionCheckHandlerHandlerDetails | Electron.MediaAccessPermissionRequest} details */
function mediaAllowed(kind, contents, permission, details) {
  const entry = contents ? allEntries().find(item => !item.window.isDestroyed() && item.window.webContents === contents) : undefined;
  const viewer = !!entry && isViewer(entry);
  return mediaPermission({ kind, permission, details, viewer, origin: entry?.device.origin, route: entry && viewer ? currentRoute(entry) : undefined });
}
/** Mute until the page confirms the selected output, so a missing or unresolved speaker stays silent.
 * @param {Entry} entry */
function applyMute(entry) {
  if (entry.window.isDestroyed()) return;
  const routed = isViewer(entry) && outputRouted(entry.audio, entry.audio.status);
  entry.window.webContents.setAudioMuted(config.muted || !routed);
}
/** A new session's salt reaches its Preferences file up to 10 seconds after the page's
 * first device request, and clearing cookies replaces it. While a choice is unresolved,
 * re-read it a bounded number of times; the choice stays silent meanwhile.
 * @param {Entry} entry @param {import('./audio.cjs').AudioRoute} route */
function retrySalt(entry, route) {
  const unresolved = route.inputMissing || route.output === null;
  if (!unresolved || !entry.audio.devices || entry.audio.saltTimer || entry.audio.saltAttempts >= 30) return;
  entry.audio.saltTimer = setTimeout(() => {
    entry.audio.saltTimer = null;
    if (entry.window.isDestroyed() || !isViewer(entry)) return;
    entry.audio.saltAttempts++;
    entry.audio.salt = sessionSalt(entry.window.webContents.session);
    syncAudio();
  }, 1000);
}
// Monotonic across pages, so a report from a replaced page never matches a new route.
let audioGeneration = 0;
function syncAudio() {
  for (const entry of windows.values()) {
    if (entry.window.isDestroyed()) continue;
    const route = currentRoute(entry);
    if (entry.audio.ready && routeChanged(entry.audio, route)) {
      Object.assign(entry.audio, nextRoute(entry.audio, route, ++audioGeneration));
      entry.window.webContents.send('glkvm:audio-route', entry.audio.route);
    }
    if (entry.audio.ready) retrySalt(entry, route);
    applyMute(entry);
  }
  for (const entry of consoles.values()) applyMute(entry);
  sendSettingsAudio();
}
/** Settings lists every native device, whether or not a connection is open. */
function audioSnapshot() {
  /** @type {Record<string, {foreground: boolean, preparing: boolean, status: import('./audio.cjs').AudioStatus | null, startup: import('./audio.cjs').StartupStatus | null}>} */
  const connections = {};
  for (const entry of windows.values()) {
    if (entry.window.isDestroyed()) continue;
    const route = currentRoute(entry);
    connections[entry.device.id] = { foreground: usesForeground(entry), preparing: (route.inputMissing || route.output === null) && !entry.audio.salt, status: entry.audio.status, startup: entry.audio.startup };
  }
  /** @param {'input' | 'output'} kind */
  const list = kind => {
    const devices = (catalog || []).filter(device => device[kind]);
    const labels = deviceLabels(devices);
    return devices.map(device => ({ uid: device.uid, label: labels.get(device.uid) || device.name, alive: device.alive }));
  };
  return { catalog: catalog ? { inputs: list('input'), outputs: list('output') } : null, microphoneAccess: systemPreferences.getMediaAccessStatus('microphone'), audioSwitchingPaused, connections };
}
let settingsAudioQueued = false;
function sendSettingsAudio() {
  if (settingsAudioQueued) return;
  settingsAudioQueued = true;
  setImmediate(() => {
    settingsAudioQueued = false;
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('glkvm:settings-audio', audioSnapshot());
  });
}
/** Startup state for the device page's own Sound and Microphone controls. The page applies it
 * once per video session; a newer value only applies to the next one. Sent only to a viewer's
 * page with a ready audio adapter, never to login helpers.
 * @param {Entry} entry */
function sendStartup(entry) {
  if (entry.window.isDestroyed() || !isViewer(entry) || !entry.audio.ready || !config.devices.includes(entry.device) || !isDeviceURL(entry.window.webContents.getURL(), entry.device)) return;
  const startup = (entry.device.audio || defaultAudio()).startup;
  const microphoneAccess = !['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('microphone'));
  entry.window.webContents.send('glkvm:audio-startup', { speaker: startup.speaker, microphone: startup.microphone, microphoneAccess });
}

/** @param {Device} device @param {boolean} [consoleWindow] @param {boolean} [background] */
function showDevice(device, consoleWindow = false, background = false) {
  const collection = consoleWindow ? consoles : windows;
  const existing = collection.get(device.id);
  if (existing) {
    if (!background) {
      existing.background = false;
      if (existing.cover) {
        existing.revealMinimized = false;
        existing.window.hide();
      } else if (existing.window.isMinimized()) existing.window.restore();
      const target = existing.cover?.window || existing.window;
      target.show(); target.focus();
    }
    return existing;
  }
  const partition = partitionFor(device);
  const ses = session.fromPartition(partition);
  if (!configuredSessions.has(partition)) {
    configuredSessions.add(partition);
    ses.setPermissionRequestHandler((contents, permission, callback, details) => callback(permission === 'pointerLock' || mediaAllowed('request', contents, permission, details)));
    ses.setPermissionCheckHandler((contents, permission, _origin, details) => permission === 'pointerLock' || mediaAllowed('check', contents, permission, details));
    ses.setCertificateVerifyProc((request, callback) => {
      callback(request.hostname === new URL(device.origin).hostname && isPinned(pins, request.hostname, request.certificate.data) ? 0 : -3);
    });
    ses.on('will-download', event => event.preventDefault());
  }
  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.round(Math.min(1280, work.width - 100, consoleWindow ? 1280 : (work.height - 100) * 16 / 9));
  const height = consoleWindow ? Math.min(850, work.height - 100) : Math.round(width * 9 / 16);
  const win = new BrowserWindow({
    title: consoleWindow ? `${device.name} — Device Settings` : device.name,
    width, height, x: work.x + 40 + (windows.size % 5) * 40, y: work.y + 40 + (windows.size % 5) * 40,
    minWidth: consoleWindow ? 720 : 160, minHeight: consoleWindow ? 500 : 90,
    frame: consoleWindow, roundedCorners: consoleWindow, hasShadow: consoleWindow,
    backgroundColor: '#000000', show: false,
    webPreferences: {
      preload: path.join(__dirname, consoleWindow ? 'console-preload.cjs' : 'preload.cjs'), partition,
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // A viewer opened while audio switching is paused uses the background profile until resumed.
  /** @type {Entry} */
  const entry = { window: win, device, controlEnabled: config.controlEnabled, moving: false, streaming: false, playerFocused: false, needsLogin: false, loginStatus: '', loginTimer: null, cover: null, pageReady: false, pageLoaded: false, manualLogin: false, revealActive: true, revealMinimized: false, pausedForeground: audioSwitchingPaused && !consoleWindow ? false : null, background, options: false, selectedScale: device.windowScale ?? null, chrome: null, cleanBounds: null, videoSize: null, audio: { ready: false, route: null, outputGeneration: 0, devices: null, status: null, startup: null, salt: null, saltAttempts: 0, saltTimer: null } };
  collection.set(device.id, entry);
  updateCatalog();
  if (!consoleWindow && device.startMode === 'options-enabled') setDeviceOptions(entry, true, false);
  applyMute(entry);
  win.on('closed', () => {
    dismissCover(entry);
    if (entry.loginTimer) clearTimeout(entry.loginTimer);
    if (entry.audio.saltTimer) clearTimeout(entry.audio.saltTimer);
    collection.delete(device.id);
    const helper = !consoleWindow && consoles.get(device.id);
    if (helper && helper.background) helper.window.close();
    installMenu(); updateCatalog(); syncAudio();
  });
  // Audio profiles follow native window focus and visibility, not player focus.
  if (!consoleWindow) for (const name of /** @type {const} */ (['focus', 'blur', 'show', 'hide', 'minimize', 'restore'])) win.on(/** @type {'focus'} */ (name), () => syncAudio());
  win.on('focus', () => { lastDeviceId = device.id; installMenu(); });
  win.on('blur', () => { if (!consoleWindow) releaseInput(entry); });
  win.on('restore', () => {
    if (!entry.cover) return;
    entry.revealMinimized = false;
    win.hide();
    entry.cover.window.show(); entry.cover.window.focus();
  });
  win.on('resized', installMenu);
  win.on('moved', installMenu);
  win.on('enter-full-screen', installMenu);
  win.on('leave-full-screen', installMenu);
  win.on('page-title-updated', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!isDeviceURL(url, entry.device)) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, url) => { if (!isDeviceURL(url, entry.device)) event.preventDefault(); });
  let navigationFailed = false;
  if (!consoleWindow) {
    // A reload or sign-in replaces the page: mute until the new page confirms its speaker,
    // and ignore late reports from the old page. Same-document changes keep the page.
    /** @type {{ready: boolean, pageReady: boolean, pageLoaded: boolean} | null} */
    let leaving = null;
    win.webContents.on('did-start-navigation', details => {
      if (!details.isMainFrame || details.isSameDocument) return;
      navigationFailed = false;
      leaving ||= { ready: entry.audio.ready, pageReady: entry.pageReady, pageLoaded: entry.pageLoaded };
      entry.audio.ready = false;
      entry.audio.status = null;
      applyMute(entry);
      if (!entry.loginTimer) beginLogin(entry, 'Connecting to video…');
      else ensureCover(entry);
      entry.pageReady = false;
      entry.pageLoaded = false;
    });
    win.webContents.on('did-navigate', () => { leaving = null; });
    // A navigation that never committed (blocked, aborted, no content) keeps the old page; route it again.
    win.webContents.on('did-stop-loading', () => {
      const previous = leaving;
      leaving = null;
      if (!previous || navigationFailed || win.isDestroyed()) return;
      entry.pageReady = previous.pageReady;
      entry.pageLoaded = previous.pageLoaded;
      entry.audio.ready = previous.ready;
      revealDevice(entry);
      if (previous.ready) { entry.audio.route = null; syncAudio(); }
    });
  }
  handleAppShortcuts(win.webContents, !consoleWindow);
  win.webContents.on('before-input-event', (_event, input) => {
    const action = keyboardAction(config.keyboard, input);
    const localAction = !!action && !consoleWindow && entry.streaming && entry.playerFocused && entry.controlEnabled && !entry.moving;
    if (win.isDestroyed()) return;
    // Editing shortcuts belong to the remote computer while its player is focused.
    // App/window commands keep their explicit, documented shortcuts.
    const remoteEdit = !consoleWindow && !entry.options && entry.streaming && entry.controlEnabled && !entry.moving && input.meta && !input.alt && ['a', 'c', 'v', 'x', 'z'].includes(input.key.toLowerCase()) && !(input.shift && input.key.toLowerCase() === 'c');
    win.webContents.setIgnoreMenuShortcuts(localAction || remoteEdit);
  });
  win.webContents.on('did-finish-load', () => {
    entry.pageLoaded = true;
    if (!consoleWindow) revealDevice(entry);
  });
  win.once('ready-to-show', () => { if (!entry.background && (consoleWindow || entry.manualLogin)) win.show(); });
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || win.isDestroyed()) return;
    navigationFailed = true;
    if (!consoleWindow) {
      if (entry.loginTimer) clearTimeout(entry.loginTimer);
      entry.loginTimer = null;
      entry.loginStatus = 'Could not connect to the device. Check the network connection. Use Device → Reload to retry.';
      sendMode(entry);
    }
    if (entry.background) return;
    entry.cover?.update(`Could not connect to ${device.name}. Check the device and network connection.`);
    if (!entry.cover) win.show();
    if (entry.cover || (code <= -200 && code >= -299)) return;
    void dialog.showMessageBox(win, { type: 'error', message: `Could not connect to ${device.name}`, detail: `Check the device and network connection. Use Device → Reload to retry.\n\nError code: ${code}` });
  });
  if (!consoleWindow) beginLogin(entry, 'Connecting…');
  void win.loadURL(`${device.origin}/`).catch(() => {});
  return entry;
}

function toggleDeviceSettings() {
  const device = currentDevice();
  if (!device) return;
  const entry = showDevice(device);
  setDeviceOptions(entry, entry.cover ? true : !entry.options);
}
/** @param {Entry} entry @param {boolean} enabled @param {boolean} [manual] */
function setDeviceOptions(entry, enabled, manual = true) {
  if (manual) {
    entry.manualLogin = enabled && !entry.pageReady;
    if (enabled) entry.revealMinimized = false;
    if (!enabled && entry.device.encryptedPassword && (!entry.pageReady || entry.needsLogin)) ensureCover(entry);
    else { dismissCover(entry); if (!entry.background) entry.window.show(); }
  }
  const win = entry.window;
  releaseInput(entry);
  entry.options = enabled;
  entry.chrome = null;
  win.webContents.setIgnoreMenuShortcuts(false);
  win.setAspectRatio(0);
  if (entry.options) {
    entry.cleanBounds = win.getBounds();
    win.setMinimumSize(720, 500);
    if (!win.isFullScreen()) {
      const work = screen.getDisplayMatching(win.getBounds()).workArea;
      win.setSize(Math.min(work.width, Math.max(1000, entry.cleanBounds.width)), Math.min(work.height, Math.max(750, entry.cleanBounds.height)));
    }
  } else {
    win.setMinimumSize(160, 90);
    if (entry.cleanBounds && !win.isFullScreen()) win.setBounds(entry.cleanBounds);
    if (entry.videoSize) win.setAspectRatio(entry.videoSize.width / entry.videoSize.height);
  }
  win.setHasShadow(entry.options);
  sendMode(entry);
  win.webContents.focus();
  installMenu();
  updateModeShortcuts();
}

function showSettings() {
  if (settingsWindow) { if (settingsWindow.isMinimized()) settingsWindow.restore(); settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    title: 'GLKVM Clean Settings', width: 800, height: 660, minWidth: 620, minHeight: 500,
    show: false, minimizable: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'settings-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  handleAppShortcuts(settingsWindow.webContents);
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
  settingsWindow.on('closed', () => { settingsWindow = null; settingsRecording = false; updateCatalog(); });
  updateCatalog();
  settingsWindow.on('focus', installMenu);
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  void settingsWindow.loadURL(settingsURL);
}

function installMenu() {
  const entry = focusedEntry();
  const viewer = entry && windows.get(entry.device.id) === entry;
  const clean = viewer && !entry.options;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { label: 'Check for Updates…', enabled: !!updates, click: () => updates?.check() }, { label: 'Open Source Licenses…', click: () => { void shell.openPath(path.join(process.resourcesPath, 'licenses')); } }, { type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: showSettings }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: entry ? `Device — ${entry.device.name}` : 'Device', submenu: [
      ...config.devices.map((device, i) => ({ label: `Open ${device.name}`, ...(i < 9 ? { accelerator: `CmdOrCtrl+${i + 1}` } : {}), click: () => showDevice(device) })),
      { label: 'Manage Connections…', click: showSettings }, { type: 'separator' },
      { label: 'Device Settings…', type: 'checkbox', checked: !!entry?.options, accelerator: 'CmdOrCtrl+Shift+O', enabled: !!config.devices.length, click: toggleDeviceSettings },
      { label: 'Move Window Mode', accelerator: 'CmdOrCtrl+Shift+M', type: 'checkbox', enabled: !!clean, checked: !!clean && (!entry.controlEnabled || entry.moving), click: () => {
        if (clean) toggleMode(entry);
      } },
      // Shown, not registered: the key is handled in every window, including view-only and Settings.
      { label: `Pause Audio Switching${config.keyboard?.pauseAudioSwitching ? ` (${config.keyboard.pauseAudioSwitching.label})` : ''}`, type: 'checkbox', checked: audioSwitchingPaused, click: toggleAudioSwitching },
      { type: 'separator' },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', enabled: !!entry, click: () => { if (entry) { releaseInput(entry); entry.window.webContents.reload(); } } }, { role: 'close' },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', role: 'windowMenu', submenu: [
      { role: 'minimize' },
      { label: 'Center', accelerator: 'CmdOrCtrl+Shift+C', click: () => BrowserWindow.getFocusedWindow()?.center() },
      { label: 'Window Size', enabled: !!viewer && !!entry.videoSize, submenu: scales.map(scale => {
        const size = viewer ? entry.videoSize : null;
        const display = screen.getDisplayMatching(entry?.window.getBounds() || screen.getPrimaryDisplay().bounds);
        const target = size ? windowSize(size, scale, display.workArea, display.scaleFactor) : null;
        const current = viewer ? entry.window.getContentSize() : [];
        if (target && entry?.options) {
          target.width = Math.max(720, target.width + (entry.chrome?.width || 0));
          target.height = Math.max(500, target.height + (entry.chrome?.height || 0));
          target.fits = target.fits && !!entry.chrome && target.width <= display.workArea.width && target.height <= display.workArea.height;
        }
        const pixels = size ? ` — ${Math.round(size.width * scale)} × ${Math.round(size.height * scale)} px` : '';
        const native = scale === 1 ? ' (1:1 pixels)' : '';
        const unavailable = target && !target.fits ? ' — does not fit' : '';
        return {
          label: `${scale}×${pixels}${native}${unavailable}`, type: /** @type {'checkbox'} */ ('checkbox'),
          enabled: !!target?.fits && !!viewer && !entry.window.isFullScreen(),
          checked: !!target && (!entry?.options || entry.selectedScale === scale) && current[0] === target.width && current[1] === target.height,
          click: () => {
            if (viewer && entry.videoSize) {
              if (entry.options && entry.cleanBounds) {
                const video = windowSize(entry.videoSize, scale, display.workArea, display.scaleFactor);
                entry.cleanBounds = { ...entry.cleanBounds, width: video.width, height: video.height };
              }
              resizeWindow(entry, entry.videoSize, scale);
            }
          },
        };
      }) },
      { label: 'Toggle Always on Top', click: () => { const win = BrowserWindow.getFocusedWindow(); if (win) win.setAlwaysOnTop(!win.isAlwaysOnTop()); } },
      { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'front' },
    ] },
    { label: 'Help', submenu: [{ label: 'Using GLKVM Clean', click: () => {
      void dialog.showMessageBox({ type: 'info', message: 'A clean window for each remote screen', detail: 'Share the “GLKVM <name>” window in your meeting app. ⌘⇧O shows or hides device controls in this window, including while sharing.\n\nClick the video to use the remote keyboard and mouse. ⌘⇧M switches between controlling the desktop and dragging the window. Use ⌘, for app settings and ⌘⇧O for device settings.\n\nApp shortcuts stay local. Other keys go to the focused remote player. Camera access is unavailable. Each connection can use its own microphone and speaker in Settings; the app never changes the macOS default devices. The Pause Audio Switching shortcut (⇧⌘A by default, set in Settings → Keyboard) keeps each connection on its current focused or background audio until you press it again. No screen-sharing session is started by this app.' });
    } }] },
  ]));
}

/** @param {Electron.IpcMainInvokeEvent | Electron.IpcMainEvent} event */
function requireSettingsSender(event) {
  if (!settingsWindow || event.sender !== settingsWindow.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== settingsURL) throw new Error('Settings access denied.');
}
ipcMain.handle('glkvm:settings-load', event => { requireSettingsSender(event); migrateLegacyChoices(); return publicConfig(config); });
let savingSettings = false;
ipcMain.handle('glkvm:settings-save', async (event, value) => {
  requireSettingsSender(event);
  if (savingSettings) return { ok: false, error: 'Settings are already being saved.' };
  savingSettings = true;
  try {
    const previous = config;
    const next = writeConfig(configPath, await prepareConfig(value, previous, safeStorage));
    config = next;
    for (const entry of allEntries()) {
      if (entry.window.isDestroyed()) continue;
      const updated = next.devices.find(device => device.id === entry.device.id);
      if (!updated || updated.origin !== entry.device.origin) {
        releaseInput(entry); entry.window.close();
      } else {
        const passwordChanged = entry.device.encryptedPassword !== updated.encryptedPassword;
        entry.device = updated;
        const clean = windows.get(updated.id) === entry;
        if (clean && passwordChanged && !updated.encryptedPassword) {
          if (entry.needsLogin) {
            if (entry.loginTimer) clearTimeout(entry.loginTimer);
            entry.loginTimer = null;
            entry.loginStatus = '';
            setDeviceOptions(entry, true);
          }
          const helper = consoles.get(updated.id);
          if (helper?.background) helper.window.close();
        }
        entry.window.setTitle(clean ? updated.name : `${updated.name} — Device Settings`);
        if (clean && previous.controlEnabled !== next.controlEnabled) { releaseInput(entry); entry.controlEnabled = next.controlEnabled; entry.moving = false; sendMode(entry); }
        sendMode(entry);
        if (!clean && passwordChanged && updated.encryptedPassword) {
          const viewer = windows.get(updated.id);
          if (viewer?.needsLogin) beginLogin(viewer);
          entry.window.webContents.reload();
        }
      }
    }
    for (const entry of windows.values()) {
      entry.audio.saltAttempts = 0;
      sendStartup(entry);
      if (entry.needsLogin && entry.device.encryptedPassword) {
        if (!consoles.has(entry.device.id)) beginLogin(entry);
        showDevice(entry.device, true, true);
      }
    }
    migrateLegacyChoices();
    installMenu();
    updateModeShortcuts();
    syncAudio();
    return { ok: true, config: publicConfig(config) };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  finally { savingSettings = false; }
});
// The shortcut recorder receives every key, including the audio switching shortcut.
ipcMain.on('glkvm:settings-recording', (event, recording) => {
  try { requireSettingsSender(event); } catch { return; }
  settingsRecording = recording === true;
});
ipcMain.handle('glkvm:settings-audio', event => {
  requireSettingsSender(event);
  for (const entry of windows.values()) if (entry.audio.ready) entry.window.webContents.send('glkvm:audio-refresh');
  return audioSnapshot();
});
ipcMain.handle('glkvm:settings-open', (event, id) => {
  requireSettingsSender(event);
  const device = config.devices.find(item => item.id === id);
  if (!device) throw new Error('Connection not found.');
  showDevice(device);
});

ipcMain.handle('glkvm:login-password', async event => {
  const entry = deviceSender(event);
  if (!entry || consoles.get(entry.device.id) !== entry) return null;
  const device = entry.device;
  try {
    const password = await readPassword(device, safeStorage);
    // Keychain access may outlive navigation or a settings change.
    if (entry.window.isDestroyed() || deviceSender(event) !== entry || entry.device !== device) return null;
    return password;
  } catch { return null; }
});

ipcMain.on('glkvm:window-action', (event, action) => {
  const entry = deviceSender(event);
  if (!entry || windows.get(entry.device.id) !== entry || !entry.options) return;
  if (action === 'close') entry.window.close();
  else if (action === 'minimize') entry.window.minimize();
  else if (action === 'fullscreen') entry.window.setFullScreen(!entry.window.isFullScreen());
});

// A new page installs its audio adapter and needs the current route again.
ipcMain.on('glkvm:audio-ready', event => {
  const entry = deviceSender(event);
  if (!entry || !isViewer(entry)) return;
  if (entry.audio.saltTimer) clearTimeout(entry.audio.saltTimer);
  entry.audio = { ready: true, route: null, outputGeneration: 0, devices: null, status: null, startup: null, salt: null, saltAttempts: 0, saltTimer: null };
  syncAudio();
  sendStartup(entry);
});
ipcMain.on('glkvm:audio-devices', (event, list) => {
  const entry = deviceSender(event);
  const devices = validateDeviceReport(list);
  if (!entry || !isViewer(entry) || !entry.audio.ready || !devices) return;
  entry.audio.devices = devices;
  // The page's device request created the session's salt if it was new.
  entry.audio.salt = sessionSalt(entry.window.webContents.session);
  entry.audio.saltAttempts = 0;
  syncAudio();
});
ipcMain.on('glkvm:audio-status', (event, value) => {
  const entry = deviceSender(event);
  const status = validateAudioStatus(value);
  if (!entry || !isViewer(entry) || !entry.audio.ready || !status) return;
  entry.audio.status = status;
  applyMute(entry);
  sendSettingsAudio();
});
ipcMain.on('glkvm:audio-startup-status', (event, value) => {
  const entry = deviceSender(event);
  const status = validateStartupStatus(value);
  if (!entry || !isViewer(entry) || !entry.audio.ready || !status) return;
  entry.audio.startup = status;
  sendSettingsAudio();
});
ipcMain.on('glkvm:ready', event => { const entry = deviceSender(event); if (entry) sendMode(entry); });
ipcMain.on('glkvm:viewer-page-ready', event => {
  const entry = deviceSender(event);
  if (!entry || !isViewer(entry)) return;
  entry.pageReady = true;
  entry.needsLogin = false;
  revealDevice(entry);
});
ipcMain.on('glkvm:login-required', event => {
  const entry = deviceSender(event);
  if (!entry || windows.get(entry.device.id) !== entry || entry.needsLogin) return;
  entry.needsLogin = true;
  if (!entry.device.encryptedPassword) { dismissCover(entry); entry.loginStatus = ''; sendMode(entry); if (!entry.background) entry.window.show(); return; }
  entry.pageReady = false;
  beginLogin(entry);
  const consoleEntry = showDevice(entry.device, true, true);
  consoleEntry.window.webContents.send('glkvm:check-auth');
});
ipcMain.on('glkvm:console-authenticated', event => {
  const consoleEntry = deviceSender(event);
  if (!consoleEntry || consoles.get(consoleEntry.device.id) !== consoleEntry) return;
  const clean = windows.get(consoleEntry.device.id);
  if (clean?.needsLogin) {
    clean.needsLogin = false;
    beginLogin(clean, 'Connecting to video…');
    void clean.window.loadURL(`${clean.device.origin}/`).catch(() => {});
  }
  if (consoleEntry.background) consoleEntry.window.close();
});
ipcMain.on('glkvm:keyboard-shortcut', (event, /** @type {unknown} */ action) => {
  const entry = deviceSender(event);
  if (!entry || windows.get(entry.device.id) !== entry || !entry.window.isFocused() || !entry.streaming || !entry.playerFocused || !entry.controlEnabled || entry.moving) return;
  if (action !== 'insert' && action !== 'secureAttention' && action !== 'paste') return;
  if (!config.keyboard?.[action]) return;
  const win = entry.window;
  if (action !== 'paste') { win.webContents.send('glkvm:keyboard-action', { action }); return; }
  const url = win.webContents.getURL();
  void clipboard.readText().then(text => {
    if (!win.isDestroyed() && win.isFocused() && win.webContents.getURL() === url && entry.streaming && entry.playerFocused && entry.controlEnabled && !entry.moving) {
      win.webContents.send('glkvm:keyboard-action', { action, text, keymap: config.keyboard?.keymap || 'de' });
    }
  }).catch(() => { if (!win.isDestroyed()) void dialog.showMessageBox(win, { type: 'error', message: 'Could not read clipboard text.' }); });
});
ipcMain.on('glkvm:player-focus', (event, focused) => {
  const entry = deviceSender(event);
  if (entry && windows.get(entry.device.id) === entry) entry.playerFocused = focused === true;
});
ipcMain.on('glkvm:keyboard-error', (event, message) => {
  const entry = deviceSender(event);
  if (entry && windows.get(entry.device.id) === entry && typeof message === 'string') {
    void dialog.showMessageBox(entry.window, { type: 'error', message: 'Keyboard action failed', detail: message.slice(0, 300) });
  }
});
ipcMain.on('glkvm:stream-state', (event, streaming) => {
  const entry = deviceSender(event);
  if (!entry) return;
  entry.streaming = streaming === true;
  if (entry.streaming) {
    entry.needsLogin = false;
    revealDevice(entry);
  }
});
ipcMain.on('glkvm:options-chrome', (event, chrome) => {
  const entry = deviceSender(event);
  if (!entry || windows.get(entry.device.id) !== entry || !entry.options) return;
  if (![chrome?.width, chrome?.height].every(value => Number.isFinite(value) && value >= 0 && value <= 2000)) return;
  entry.chrome = { width: Math.ceil(chrome.width), height: Math.ceil(chrome.height) };
  if (entry.videoSize && entry.selectedScale != null) resizeWindow(entry, entry.videoSize, entry.selectedScale);
  installMenu();
});
ipcMain.on('glkvm:video-size', (event, size) => {
  const entry = deviceSender(event);
  if (!entry || windows.get(entry.device.id) !== entry) return;
  if (!Number.isInteger(size?.width) || !Number.isInteger(size?.height) || size.width < 1 || size.height < 1 || size.width > 16384 || size.height > 16384) return;
  const ratio = size.width / size.height;
  if (ratio < 0.25 || ratio > 8) return;
  entry.videoSize = { width: size.width, height: size.height };
  installMenu();
  const win = entry.window;
  if (entry.selectedScale != null) {
    const display = screen.getDisplayMatching(win.getBounds());
    const target = windowSize(size, entry.selectedScale, display.workArea, display.scaleFactor);
    if (target.fits) {
      if (entry.options && entry.cleanBounds) {
        entry.cleanBounds = { ...entry.cleanBounds, width: target.width, height: target.height };
      }
      resizeWindow(entry, size, entry.selectedScale);
      return;
    }
  }
  if (entry.options) return;
  win.setAspectRatio(ratio);
  if (win.isFullScreen()) return;
  const work = screen.getDisplayMatching(win.getBounds()).workArea;
  const [currentWidth] = win.getContentSize();
  const width = Math.round(Math.min(currentWidth, work.width - 40, (work.height - 40) * ratio));
  win.setContentSize(width, Math.round(width / ratio));
});

app.on('browser-window-focus', () => updateModeShortcuts());
app.on('browser-window-blur', () => setImmediate(updateModeShortcuts));
app.on('will-quit', () => { catalogWatcher.stop(); if (app.isReady()) globalShortcut.unregisterAll(); });
app.on('before-quit', () => { for (const entry of allEntries()) releaseInput(entry); });

app.on('certificate-error', (event, contents, url, error, certificate, callback) => {
  const entry = allEntries().find(({ window, device }) => window.webContents === contents && isDeviceURL(url, device));
  if (!entry) { callback(false); return; }
  event.preventDefault();
  const hostname = new URL(entry.device.origin).hostname;
  if (isPinned(pins, hostname, certificate.data)) { callback(true); return; }
  const hash = fingerprint(certificate.data);
  if (!hash) { callback(false); return; }
  const key = `${hostname}:${hash}`;
  if (!certificatePrompts.has(key)) {
    const viewer = windows.get(entry.device.id);
    const promptWindow = entry.cover?.window || viewer?.cover?.window || viewer?.window || entry.window;
    promptWindow.show();
    const prompt = dialog.showMessageBox(promptWindow, {
      type: 'warning', title: `Certificate for ${entry.device.name}`,
      message: `Trust this certificate for ${entry.device.name}?`,
      detail: `${hostname}\n\nThe device certificate could not be verified (${error}). Only continue if this is your GLKVM on your trusted private network.\n\nSubject: ${certificate.subjectName}\nSHA-256: ${hash}\n\nTrust applies only to this host and this exact certificate, inside GLKVM Clean. A changed certificate requires a new decision.`,
      buttons: ['Cancel', 'Trust This Certificate'], defaultId: 0, cancelId: 0, noLink: true,
    }).then(({ response }) => {
      if (response !== 1) return false;
      pins[hostname] = hash;
      fs.writeFileSync(pinPath, `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
      return true;
    }).catch(() => false);
    certificatePrompts.set(key, prompt);
    void prompt.finally(() => certificatePrompts.delete(key));
  }
  void certificatePrompts.get(key).then(callback);
});

function openStartupDevices() {
  const startup = config.devices.filter(device => device.openAtStartup);
  startup.forEach(device => showDevice(device));
  if (!startup.length) showSettings();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const entry = windows.values().next().value;
    if (entry) showDevice(entry.device); else openStartupDevices();
  });
  app.whenReady().then(async () => {
    // Refresh the running app's Dock icon independently of Launch Services caches.
    app.dock?.setIcon(path.join(__dirname, '../assets/icon.png'));
    pinPath = path.join(app.getPath('userData'), 'trusted-certificates.json');
    configPath = path.join(app.getPath('userData'), 'settings.json');
    try { const saved = JSON.parse(fs.readFileSync(pinPath, 'utf8')); if (saved && typeof saved === 'object' && !Array.isArray(saved)) pins = saved; } catch { pins = {}; }
    try { config = readConfig(configPath); }
    catch (error) {
      await dialog.showMessageBox({ type: 'error', message: 'Could not read saved settings', detail: `${error instanceof Error ? error.message : String(error)}\n\nThe original file has been preserved at ${configPath}. The default connections will be shown until you save settings again.` });
    }
    screen.on('display-metrics-changed', installMenu);
    updates = setupUpdates({ app, autoUpdater, dialog, manifest: require('../package.json'), releaseInput: () => { for (const entry of allEntries()) releaseInput(entry); } });
    installMenu(); openStartupDevices();
    app.on('activate', () => { if (!windows.size && !settingsWindow && !consoles.size) openStartupDevices(); });
  });
  app.on('window-all-closed', () => {});
}
