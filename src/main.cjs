const { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isDeviceURL } = require('./devices.cjs');
const { defaults, readConfig, writeConfig, partitionFor } = require('./config.cjs');
const { publicConfig, prepareConfig, readPassword } = require('./credentials.cjs');
const { fingerprint, isPinned } = require('./certificates.cjs');

app.setName('GLKVM Clean');
/** @typedef {import('./config.cjs').Device} Device */
/** @typedef {{window: Electron.BrowserWindow, device: Device, controlEnabled: boolean, moving: boolean, streaming: boolean, needsLogin: boolean, background: boolean}} Entry */
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
    minWidth: consoleWindow ? 720 : 320, minHeight: consoleWindow ? 500 : 180,
    frame: consoleWindow, roundedCorners: consoleWindow, hasShadow: consoleWindow,
    backgroundColor: '#000000', show: false,
    webPreferences: {
      preload: path.join(__dirname, consoleWindow ? 'console-preload.cjs' : 'preload.cjs'), partition,
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  const entry = { window: win, device, controlEnabled: config.controlEnabled, moving: false, streaming: false, needsLogin: false, background };
  collection.set(device.id, entry);
  win.webContents.setAudioMuted(consoleWindow || config.muted);
  win.on('closed', () => { collection.delete(device.id); installMenu(); });
  win.on('focus', () => { lastDeviceId = device.id; installMenu(); });
  win.on('blur', () => { if (!consoleWindow) releaseInput(entry); });
  win.on('page-title-updated', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!isDeviceURL(url, entry.device)) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, url) => { if (!isDeviceURL(url, entry.device)) event.preventDefault(); });
  win.webContents.on('before-input-event', (_event, input) => {
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
      { label: 'Allow Keyboard and Mouse', accelerator: 'CmdOrCtrl+Shift+I', type: 'checkbox', enabled: !!clean, checked: !!clean && entry.controlEnabled, click: () => {
        if (!clean) return; releaseInput(entry); entry.controlEnabled = !entry.controlEnabled; entry.moving = false; sendMode(entry); installMenu();
      } },
      { label: 'Move Window Mode', accelerator: 'CmdOrCtrl+Shift+M', type: 'checkbox', enabled: !!clean, checked: !!clean && entry.moving, click: () => {
        if (!clean) return; releaseInput(entry); entry.moving = !entry.moving; sendMode(entry); installMenu();
      } }, { type: 'separator' },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', enabled: !!entry, click: () => { if (entry) { releaseInput(entry); entry.window.webContents.reload(); } } }, { role: 'close' },
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', role: 'windowMenu', submenu: [
      { role: 'minimize' },
      { label: 'Center', accelerator: 'CmdOrCtrl+Shift+C', click: () => BrowserWindow.getFocusedWindow()?.center() },
      ...[640, 960, 1280].map(width => ({ label: `${width} px Wide`, enabled: !!clean, click: () => {
        if (!clean || entry.window.isFullScreen()) return;
        const win = entry.window;
        const [oldWidth, oldHeight] = win.getContentSize();
        const ratio = oldWidth / oldHeight;
        const work = screen.getDisplayMatching(win.getBounds()).workArea;
        const fitted = Math.round(Math.min(width, work.width - 40, (work.height - 40) * ratio));
        win.setContentSize(fitted, Math.round(fitted / ratio));
      } })),
      { label: 'Toggle Always on Top', click: () => { const win = BrowserWindow.getFocusedWindow(); if (win) win.setAlwaysOnTop(!win.isAlwaysOnTop()); } },
      { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'front' },
    ] },
    { label: 'Help', submenu: [{ label: 'Using GLKVM Clean', click: () => {
      void dialog.showMessageBox({ type: 'info', message: 'A clean window for each remote screen', detail: 'Share the “GLKVM <name>” window in your meeting app. Settings always open in separate windows.\n\nClick the video to use the remote keyboard and mouse. ⌘⇧I toggles view-only mode; ⌘⇧M lets you drag the window. Use ⌘, for app settings and ⌘⇧O for device settings.\n\nApp shortcuts stay local. Other keys go to the focused remote player. Camera and microphone access are unavailable. No screen-sharing session is started by this app.' });
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
  if (clean?.needsLogin) { clean.needsLogin = false; clean.window.webContents.reload(); }
  if (consoleEntry.background) consoleEntry.window.close();
});
ipcMain.on('glkvm:stream-state', (event, streaming) => { const entry = deviceSender(event); if (entry) entry.streaming = streaming === true; });
ipcMain.on('glkvm:video-size', (event, size) => {
  const entry = deviceSender(event);
  if (!entry || windows.get(entry.device.id) !== entry) return;
  if (!Number.isInteger(size?.width) || !Number.isInteger(size?.height) || size.width < 1 || size.height < 1 || size.width > 16384 || size.height > 16384) return;
  const ratio = size.width / size.height;
  if (ratio < 0.25 || ratio > 8) return;
  const win = entry.window;
  win.setAspectRatio(ratio);
  if (win.isFullScreen()) return;
  const work = screen.getDisplayMatching(win.getBounds()).workArea;
  const [currentWidth] = win.getContentSize();
  const width = Math.round(Math.min(currentWidth, work.width - 40, (work.height - 40) * ratio));
  win.setContentSize(width, Math.round(width / ratio));
});

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
    installMenu(); openStartupDevices();
    app.on('activate', () => { if (!windows.size && !settingsWindow && !consoles.size) openStartupDevices(); });
  });
  app.on('window-all-closed', () => {});
}
