const { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, safeStorage, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isDeviceURL } = require('./devices.cjs');
const { defaults, readConfig, writeConfig, partitionFor } = require('./config.cjs');
const { publicConfig, prepareConfig, readPassword } = require('./credentials.cjs');
const { fingerprint, isPinned } = require('./certificates.cjs');
const { scales, windowSize } = require('./window-sizes.cjs');

app.setName('GLKVM Clean');
/** @typedef {import('./config.cjs').Device} Device */
/** @typedef {{window: Electron.BrowserWindow, device: Device, controlEnabled: boolean, moving: boolean, streaming: boolean, needsLogin: boolean, background: boolean, videoSize: {width: number, height: number} | null}} Entry */
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
const settingsURL = pathToFileURL(path.join(__dirname, 'settings.html')).href;

function allEntries() { return [...windows.values(), ...consoles.values()]; }
function focusedEntry() {
  const focused = BrowserWindow.getFocusedWindow();
  return allEntries().find(entry => entry.window === focused);
}
function currentDevice() { return focusedEntry()?.device || config.devices.find(device => device.id === lastDeviceId) || config.devices[0]; }
/** @param {Entry} entry */
function sendMode(entry) {
  entry.window.webContents.send('glkvm:mode', { controlEnabled: entry.controlEnabled, moving: entry.moving });
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
const modeShortcut = 'CommandOrControl+Shift+M';
function updateModeShortcuts() {
  const entry = focusedEntry();
  const clean = entry && windows.get(entry.device.id) === entry;
  if (!clean) globalShortcut.unregister(modeShortcut);
  else if (!globalShortcut.isRegistered(modeShortcut)) {
    // Native drag regions can take focus away from Chromium. Register only
    // while a clean window is focused, and resolve the target at invocation.
    globalShortcut.register(modeShortcut, () => {
      const target = focusedEntry();
      if (target && windows.get(target.device.id) === target) toggleMode(target);
    });
  }
}
/** @param {Entry} entry @param {{width: number, height: number}} size @param {number} scale */
function resizeWindow(entry, size, scale) {
  const win = entry.window;
  if (win.isFullScreen()) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const fitted = windowSize(size, scale, display.workArea, display.scaleFactor);
  if (!fitted.fits) return;
  win.setAspectRatio(0);
  win.setContentSize(fitted.width, fitted.height);
  win.setAspectRatio(fitted.width / fitted.height);
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

/** @param {Device} device @param {boolean} [consoleWindow] @param {boolean} [background] */
function showDevice(device, consoleWindow = false, background = false) {
  const collection = consoleWindow ? consoles : windows;
  const existing = collection.get(device.id);
  if (existing) {
    if (!background) {
      existing.background = false;
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.show(); existing.window.focus();
    }
    return existing;
  }
  const partition = partitionFor(device);
  const ses = session.fromPartition(partition);
  if (!configuredSessions.has(partition)) {
    configuredSessions.add(partition);
    ses.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'pointerLock'));
    ses.setPermissionCheckHandler((_contents, permission) => permission === 'pointerLock');
    ses.setCertificateVerifyProc((request, callback) => {
      callback(request.hostname === new URL(device.origin).hostname && isPinned(pins, request.hostname, request.certificate.data) ? 0 : -3);
    });
    ses.on('will-download', event => event.preventDefault());
  }
  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.round(Math.min(1280, work.width - 100, consoleWindow ? 1280 : (work.height - 100) * 16 / 9));
  const height = consoleWindow ? Math.min(850, work.height - 100) : Math.round(width * 9 / 16);
  const win = new BrowserWindow({
    title: consoleWindow ? `${device.name} — Device Settings` : `GLKVM ${device.name}`,
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
  const entry = { window: win, device, controlEnabled: config.controlEnabled, moving: false, streaming: false, needsLogin: false, background, videoSize: null };
  collection.set(device.id, entry);
  win.webContents.setAudioMuted(consoleWindow || config.muted);
  win.on('closed', () => { collection.delete(device.id); installMenu(); });
  win.on('focus', () => { lastDeviceId = device.id; installMenu(); });
  win.on('blur', () => { if (!consoleWindow) releaseInput(entry); });
  win.on('resized', installMenu);
  win.on('moved', installMenu);
  win.on('enter-full-screen', installMenu);
  win.on('leave-full-screen', installMenu);
  win.on('page-title-updated', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!isDeviceURL(url, entry.device)) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, url) => { if (!isDeviceURL(url, entry.device)) event.preventDefault(); });
  win.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase();
    const modeKey = !consoleWindow && input.shift && !input.alt && (process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta) && key === 'm';
    if (modeKey) {
      // Also handle synthetic input and native registration conflicts. Prevent
      // both renderer delivery and the menu accelerator from toggling twice.
      event.preventDefault();
      if (input.type === 'keyDown' && !input.isAutoRepeat) toggleMode(entry);
      return;
    }
    // Editing shortcuts belong to the remote computer while its player is focused.
    // App/window commands keep their explicit, documented shortcuts.
    const remoteEdit = !consoleWindow && entry.streaming && entry.controlEnabled && !entry.moving && input.meta && !input.alt && ['a', 'c', 'v', 'x', 'z'].includes(input.key.toLowerCase()) && !(input.shift && input.key.toLowerCase() === 'c');
    win.webContents.setIgnoreMenuShortcuts(remoteEdit);
  });
  win.once('ready-to-show', () => { if (!entry.background) win.show(); });
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || win.isDestroyed()) return;
    if (entry.background) return;
    win.show();
    if (code <= -200 && code >= -299) return;
    void dialog.showMessageBox(win, { type: 'error', message: `Could not connect to ${device.name}`, detail: `Check the device and Tailscale connection. Use Device → Reload to retry.\n\nError code: ${code}` });
  });
  void win.loadURL(`${device.origin}/`).catch(() => {});
  return entry;
}

function toggleDeviceSettings() {
  const device = currentDevice();
  if (!device) return;
  const existing = consoles.get(device.id);
  if (existing?.window.isFocused()) { existing.window.close(); windows.get(device.id)?.window.focus(); }
  else showDevice(device, true);
}

function showSettings() {
  if (settingsWindow) { if (settingsWindow.isMinimized()) settingsWindow.restore(); settingsWindow.show(); settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    title: 'GLKVM Clean Settings', width: 800, height: 660, minWidth: 620, minHeight: 500,
    show: false, minimizable: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'settings-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.on('focus', installMenu);
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  void settingsWindow.loadURL(settingsURL);
}

function installMenu() {
  const entry = focusedEntry();
  const clean = entry && windows.get(entry.device.id) === entry;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: showSettings }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Device', submenu: [
      ...config.devices.map((device, i) => ({ label: `Open ${device.name}`, ...(i < 9 ? { accelerator: `CmdOrCtrl+${i + 1}` } : {}), click: () => showDevice(device) })),
      { label: 'Manage Connections…', click: showSettings }, { type: 'separator' },
      { label: 'Device Settings…', accelerator: 'CmdOrCtrl+Shift+O', enabled: !!config.devices.length, click: toggleDeviceSettings },
      { label: 'Move Window Mode', accelerator: 'CmdOrCtrl+Shift+M', type: 'checkbox', enabled: !!clean, checked: !!clean && (!entry.controlEnabled || entry.moving), click: () => {
        if (clean) toggleMode(entry);
      } }, { type: 'separator' },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', enabled: !!entry, click: () => { if (entry) { releaseInput(entry); entry.window.webContents.reload(); } } }, { role: 'close' },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', role: 'windowMenu', submenu: [
      { role: 'minimize' },
      { label: 'Center', accelerator: 'CmdOrCtrl+Shift+C', click: () => BrowserWindow.getFocusedWindow()?.center() },
      { label: 'Window Size', enabled: !!clean && !!entry.videoSize, submenu: scales.map(scale => {
        const size = clean ? entry.videoSize : null;
        const display = screen.getDisplayMatching(entry?.window.getBounds() || screen.getPrimaryDisplay().bounds);
        const target = size ? windowSize(size, scale, display.workArea, display.scaleFactor) : null;
        const current = clean ? entry.window.getContentSize() : [];
        const pixels = size ? ` — ${Math.round(size.width * scale)} × ${Math.round(size.height * scale)} px` : '';
        const native = scale === 1 ? ' (1:1 pixels)' : '';
        const unavailable = target && !target.fits ? ' — does not fit' : '';
        return {
          label: `${scale}×${pixels}${native}${unavailable}`, type: /** @type {'checkbox'} */ ('checkbox'),
          enabled: !!target?.fits && !!clean && !entry.window.isFullScreen(),
          checked: !!target && current[0] === target.width && current[1] === target.height,
          click: () => { if (clean && entry.videoSize) resizeWindow(entry, entry.videoSize, scale); },
        };
      }) },
      { label: 'Toggle Always on Top', click: () => { const win = BrowserWindow.getFocusedWindow(); if (win) win.setAlwaysOnTop(!win.isAlwaysOnTop()); } },
      { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'front' },
    ] },
    { label: 'Help', submenu: [{ label: 'Using GLKVM Clean', click: () => {
      void dialog.showMessageBox({ type: 'info', message: 'A clean window for each remote screen', detail: 'Share the “GLKVM <name>” window in your meeting app. Settings always open in separate windows.\n\nClick the video to use the remote keyboard and mouse. ⌘⇧M switches between controlling the desktop and dragging the window. Use ⌘, for app settings and ⌘⇧O for device settings.\n\nApp shortcuts stay local. Other keys go to the focused remote player. Camera and microphone access are unavailable. No screen-sharing session is started by this app.' });
    } }] },
  ]));
}

/** @param {Electron.IpcMainInvokeEvent} event */
function requireSettingsSender(event) {
  if (!settingsWindow || event.sender !== settingsWindow.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== settingsURL) throw new Error('Settings access denied.');
}
ipcMain.handle('glkvm:settings-load', event => { requireSettingsSender(event); return publicConfig(config); });
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
      const updated = next.devices.find(device => device.id === entry.device.id);
      if (!updated || updated.origin !== entry.device.origin) {
        releaseInput(entry); entry.window.close();
      } else {
        const passwordChanged = entry.device.encryptedPassword !== updated.encryptedPassword;
        entry.device = updated;
        const clean = windows.get(updated.id) === entry;
        entry.window.setTitle(clean ? `GLKVM ${updated.name}` : `${updated.name} — Device Settings`);
        if (clean && previous.controlEnabled !== next.controlEnabled) { releaseInput(entry); entry.controlEnabled = next.controlEnabled; entry.moving = false; sendMode(entry); }
        entry.window.webContents.setAudioMuted(!clean || next.muted);
        if (!clean && passwordChanged && updated.encryptedPassword) entry.window.webContents.reload();
      }
    }
    for (const entry of windows.values()) {
      if (entry.needsLogin && entry.device.encryptedPassword) showDevice(entry.device, true, true);
    }
    installMenu();
    return { ok: true, config: publicConfig(config) };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  finally { savingSettings = false; }
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

ipcMain.on('glkvm:ready', event => { const entry = deviceSender(event); if (entry) sendMode(entry); });
ipcMain.on('glkvm:login-required', event => {
  const entry = deviceSender(event);
  if (!entry || windows.get(entry.device.id) !== entry || entry.needsLogin) return;
  entry.needsLogin = true;
  if (!entry.device.encryptedPassword) return;
  const consoleEntry = showDevice(entry.device, true, true);
  consoleEntry.window.webContents.send('glkvm:check-auth');
});
ipcMain.on('glkvm:console-connected', event => {
  const consoleEntry = deviceSender(event);
  if (!consoleEntry || consoles.get(consoleEntry.device.id) !== consoleEntry) return;
  const clean = windows.get(consoleEntry.device.id);
  if (clean?.needsLogin) { clean.needsLogin = false; void clean.window.loadURL(`${clean.device.origin}/`).catch(() => {}); }
  if (consoleEntry.background) consoleEntry.window.close();
});
ipcMain.on('glkvm:stream-state', (event, streaming) => { const entry = deviceSender(event); if (entry) entry.streaming = streaming === true; });
ipcMain.on('glkvm:video-size', (event, size) => {
  const entry = deviceSender(event);
  if (!entry || windows.get(entry.device.id) !== entry) return;
  if (!Number.isInteger(size?.width) || !Number.isInteger(size?.height) || size.width < 1 || size.height < 1 || size.width > 16384 || size.height > 16384) return;
  const ratio = size.width / size.height;
  if (ratio < 0.25 || ratio > 8) return;
  entry.videoSize = { width: size.width, height: size.height };
  installMenu();
  const win = entry.window;
  win.setAspectRatio(ratio);
  if (win.isFullScreen()) return;
  const work = screen.getDisplayMatching(win.getBounds()).workArea;
  const [currentWidth] = win.getContentSize();
  const width = Math.round(Math.min(currentWidth, work.width - 40, (work.height - 40) * ratio));
  win.setContentSize(width, Math.round(width / ratio));
});

app.on('browser-window-focus', () => updateModeShortcuts());
app.on('browser-window-blur', () => setImmediate(updateModeShortcuts));
app.on('will-quit', () => globalShortcut.unregisterAll());

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
    entry.window.show();
    const prompt = dialog.showMessageBox(entry.window, {
      type: 'warning', title: `Certificate for ${entry.device.name}`,
      message: `Trust this certificate for ${entry.device.name}?`,
      detail: `${hostname}\n\nThe device certificate could not be verified (${error}). Only continue if this is your GLKVM on your trusted Tailscale network.\n\nSubject: ${certificate.subjectName}\nSHA-256: ${hash}\n\nTrust applies only to this host and this exact certificate, inside GLKVM Clean. A changed certificate requires a new decision.`,
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
  app.on('second-instance', () => { if (windows.size) windows.values().next().value?.window.focus(); else openStartupDevices(); });
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
    installMenu(); openStartupDevices();
    app.on('activate', () => { if (!windows.size && !settingsWindow && !consoles.size) openStartupDevices(); });
  });
  app.on('window-all-closed', () => {});
}
