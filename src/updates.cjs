const { plainReleaseNotes } = require('./release-notes.cjs');
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
  let notes = '';
  let releaseName = '';
  let prompting = false;
  let stopUpdates = () => {};
  async function promptUpdate() {
    if (prompting) return;
    prompting = true;
    try {
      const { response } = await dialog.showMessageBox({
        type: 'info', title: 'GLKVM Clean Update', message: releaseName || 'An update is ready.',
        detail: `Restart GLKVM Clean to install it.\n\nWhat's changed\n\n${notes || 'Release notes are unavailable for this version.'}`,
        buttons: ['Restart', 'Later'], defaultId: 1, cancelId: 1,
      });
      if (response === 0) autoUpdater.quitAndInstall();
    } finally { prompting = false; }
  }
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
  autoUpdater.on('update-downloaded', (_event, releaseNotes, name) => {
    busy = false; manual = false; downloaded = true;
    notes = plainReleaseNotes(releaseNotes);
    releaseName = typeof name === 'string' ? name.slice(0, 200) : '';
    stopUpdates();
    void promptUpdate();
  });
  autoUpdater.on('before-quit-for-update', releaseInput);
  const updater = updateElectronApp({
    updateSource: { type: require('update-electron-app').UpdateSourceType.ElectronPublicUpdateService, repo: 'layernine-dev/glkvm' },
    updateInterval: '1 hour',
    // Squirrel handles download and signature validation. The app's native
    // dialog includes release notes and never forces a restart during a session.
    notifyUser: false,
  });
  stopUpdates = updater.stopUpdates;
  app.on('will-quit', stopUpdates);
  return {
    check() {
      if (downloaded) {
        void promptUpdate();
      } else if (!busy) {
        manual = true;
        try { autoUpdater.checkForUpdates(); }
        catch { busy = false; manual = false; void dialog.showMessageBox({ type: 'error', message: 'Could not check for updates.' }); }
      }
    },
  };
}
module.exports = { updatesEnabled, setupUpdates };
