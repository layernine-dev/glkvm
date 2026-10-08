const { BrowserWindow } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const url = pathToFileURL(path.join(__dirname, 'connection-cover.html')).href;

/** Keep the remote viewer hidden while a separate local progress window stays stable.
 * @param {Electron.BrowserWindow} window
 * @param {string} name
 * @param {(action: string) => void} onAction
 */
function createCover(window, name, onAction) {
  const bounds = window.getBounds();
  const progress = new BrowserWindow({
    title: `${name} — Connecting`, width: 440, height: 300, show: false,
    x: Math.round(bounds.x + (bounds.width - 440) / 2), y: Math.round(bounds.y + (bounds.height - 300) / 2),
    resizable: false, minimizable: false, maximizable: false, backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'connection-cover-preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      partition: `glkvm-cover-${window.id}`,
    },
  });
  progress.on('page-title-updated', event => event.preventDefault());
  progress.on('focus', () => onAction('focus'));
  let closing = false;
  progress.on('closed', () => { if (!closing && !window.isDestroyed()) onAction('close'); });
  progress.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  progress.webContents.session.setPermissionCheckHandler(() => false);
  progress.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  progress.webContents.on('will-navigate', event => event.preventDefault());
  progress.webContents.on('will-redirect', event => event.preventDefault());
  progress.webContents.on('ipc-message', (event, channel, action) => {
    if (channel === 'glkvm:cover-action' && event.senderFrame === progress.webContents.mainFrame && event.senderFrame?.url === url && typeof action === 'string') onAction(action);
  });
  let message = 'Connecting…';
  let busy = true;
  const send = () => {
    if (!progress.webContents.isDestroyed()) progress.webContents.send('glkvm:cover-status', { name, message, busy });
  };
  progress.webContents.on('did-finish-load', send);
  progress.once('ready-to-show', () => { if (!progress.isDestroyed() && !window.isDestroyed() && !window.isMinimized()) progress.show(); });
  void progress.webContents.loadURL(url).catch(() => {
    if (!window.isDestroyed()) onAction('manual');
  });
  return {
    window: progress,
    /** @param {string} text */
    update(text) {
      message = text || 'Connecting…';
      busy = ['Connecting…', 'Signing in…', 'Connecting to video…'].includes(message);
      send();
    },
    close() {
      closing = true;
      if (!progress.isDestroyed()) progress.close();
    },
  };
}
module.exports = { createCover };
