/** @typedef {{glkvmUpdates?: boolean, [key: string]: unknown}} UpdateManifest */

/** Development and GUI bundles are packaged too: require the release-only marker.
 * @param {UpdateManifest} manifest @param {boolean} packaged @param {string} platform @param {string} arch
 */
function updatesEnabled(manifest, packaged, platform, arch) {
  return manifest.glkvmUpdates === true && packaged && platform === 'darwin' && arch === 'arm64';
}

/** @param {{app: Electron.App, autoUpdater: Electron.AutoUpdater, dialog: Electron.Dialog,
 * manifest: UpdateManifest, releaseInput: () => void}} options
 */
function setupUpdates({ app, autoUpdater, dialog, manifest, releaseInput }) {
  if (!updatesEnabled(manifest, app.isPackaged, process.platform, process.arch)) return null;
  const { updateElectronApp } = require('update-electron-app');
  let busy = false;
  let manual = false;
  let downloaded = false;
  let stopUpdates = () => {};
  autoUpdater.on('checking-for-update', () => { busy = true; });
  autoUpdater.on('update-not-available', () => {
    busy = false;
    if (manual) void dialog.showMessageBox({ type: 'info', message: 'GLKVM Clean is up to date.', detail: `Version ${app.getVersion()}` });
    manual = false;
  });
  autoUpdater.on('error', () => {
    busy = false;
    if (manual) void dialog.showMessageBox({ type: 'error', message: 'Could not check for updates.', detail: 'Please try again later.' });
    manual = false;
  });
  autoUpdater.on('update-downloaded', () => { busy = false; manual = false; downloaded = true; stopUpdates(); });
  autoUpdater.on('before-quit-for-update', releaseInput);
  const updater = updateElectronApp({
    updateSource: { type: require('update-electron-app').UpdateSourceType.ElectronPublicUpdateService, repo: 'layernine-dev/glkvm' },
    updateInterval: '1 hour',
    // The library supplies download, signature validation via Squirrel, and the
    // native Restart / Later dialog. Never force a restart during a KVM session.
    notifyUser: true,
  });
  stopUpdates = updater.stopUpdates;
  app.on('will-quit', stopUpdates);
  return {
    check() {
      if (downloaded) {
        void dialog.showMessageBox({ type: 'info', message: 'An update is ready.', detail: 'Restart GLKVM Clean to install it.', buttons: ['Restart', 'Later'], defaultId: 1, cancelId: 1 }).then(({ response }) => {
          if (response === 0) autoUpdater.quitAndInstall();
        });
      } else if (!busy) {
        manual = true;
        try { autoUpdater.checkForUpdates(); }
        catch { busy = false; manual = false; void dialog.showMessageBox({ type: 'error', message: 'Could not check for updates.' }); }
      }
    },
  };
}
module.exports = { updatesEnabled, setupUpdates };
