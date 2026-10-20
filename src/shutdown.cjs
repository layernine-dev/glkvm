/** Unload connection pages and drain HTTP pools while the network service is
 * alive. WebRTC mDNS sockets outlive pages and HTTP pools; their macOS shutdown
 * workaround is applied before startup in network-runtime.cjs.
 * @param {{app: Electron.App, windows: () => Electron.BrowserWindow[],
 * sessions: () => Electron.Session[], prepare: () => void,
 * quitAndInstall: () => void}} options
 */
function setupShutdown({ app, windows, sessions, prepare, quitAndInstall }) {
  let preparing = false;
  let prepared = false;
  let installing = false;

  /** A stalled renderer or network service must not indefinitely veto Quit.
   * @param {Promise<unknown>} operation @param {string} stage */
  async function bounded(operation, stage) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    try {
      await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out.')), 3000);
      })]);
    } catch (error) {
      console.warn(`Could not finish ${stage} before quitting:`, error instanceof Error ? error.message : String(error));
    } finally { clearTimeout(timer); }
  }

  async function drain() {
    prepare();
    // Retain sessions of windows that have already closed: their HTTP pools
    // can outlive the last document using the partition.
    const activeSessions = [...new Set(sessions())];
    await bounded(Promise.all(windows().map(async win => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      const contents = win.webContents;
      // Quit already authorizes leaving the page, including firmware pages
      // with a beforeunload handler. Do not let one veto the drain navigation.
      const allowUnload = (/** @type {Electron.Event} */ event) => event.preventDefault();
      contents.on('will-prevent-unload', allowUnload);
      try {
        contents.stop();
        await contents.loadURL('about:blank');
      } catch {
        // A window closed concurrently has already released its document.
        if (!contents.isDestroyed()) console.warn('Could not unload a connection page before quitting.');
      } finally {
        contents.removeListener('will-prevent-unload', allowUnload);
      }
    })), 'connection page cleanup');
    await bounded(Promise.all(activeSessions.map(async ses => {
      try { await ses.closeAllConnections(); }
      catch { console.warn('Could not close a network session before quitting.'); }
    })), 'network connection cleanup');
  }

  function begin() {
    if (preparing) return;
    preparing = true;
    void drain().catch(error => {
      console.warn('Could not prepare network shutdown:', error instanceof Error ? error.message : String(error));
    }).finally(() => {
      prepared = true;
      // The documents have been unloaded (or their deadline expired). Do not
      // enter another renderer close handshake: it can still veto or stall
      // native Quit even after a successful navigation to about:blank.
      for (const win of windows()) {
        if (!win.isDestroyed()) win.destroy();
      }
      // Leave the native event callback before requesting the final Quit.
      setImmediate(() => { if (installing) quitAndInstall(); else app.quit(); });
    });
  }

  app.on('before-quit', event => {
    if (prepared || !app.isReady()) return;
    event.preventDefault();
    begin();
  });
  return {
    isPreparing: () => preparing,
    // Squirrel closes windows before before-quit: start the drain before
    // invoking it, while connection documents still exist.
    quitAndInstall() { installing = true; begin(); },
  };
}

module.exports = { setupShutdown };
