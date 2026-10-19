const path = require('node:path');

/** @param {typeof Electron.BrowserWindow} BrowserWindow */
function createUpdateProgress(BrowserWindow) {
  /** @type {Electron.BrowserWindow | null} */
  let window = null;
  let message = '';
  function render() {
    if (!window || window.webContents.isLoading()) return;
    // Only app-owned text reaches this local document. No page can send IPC.
    void window.webContents.executeJavaScript(`document.querySelector('h1').textContent = ${JSON.stringify(message)}`).catch(() => {});
  }
  return {
    /** @param {string} value */
    update(value) { message = value; render(); },
    /** @param {string} value */
    show(value) {
      message = value;
      if (window) { render(); window.show(); window.focus(); return; }
      const created = new BrowserWindow({
        title: 'GLKVM Clean Update', width: 440, height: 190, show: false,
        resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      window = created;
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      created.webContents.on('will-navigate', event => event.preventDefault());
      created.webContents.once('did-finish-load', () => { render(); created.show(); });
      created.on('closed', () => { if (window === created) window = null; });
      void created.loadFile(path.join(__dirname, 'update-progress.html')).catch(() => {});
    },
    close() { window?.destroy(); window = null; },
  };
}

module.exports = { createUpdateProgress };
