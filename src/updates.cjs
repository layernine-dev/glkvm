const { plainReleaseNotes } = require('./release-notes.cjs');
/** @typedef {{glkvmUpdates?: boolean, [key: string]: unknown}} UpdateManifest */

/** Development and GUI bundles are packaged too: require the release-only marker.
 * @param {UpdateManifest} manifest @param {boolean} packaged @param {string} platform @param {string} arch
 */
function updatesEnabled(manifest, packaged, platform, arch) {
  return manifest.glkvmUpdates === true && packaged && platform === 'darwin' && arch === 'arm64';
}

/** @param {{app: Electron.App, autoUpdater: Electron.AutoUpdater, dialog: Electron.Dialog,
 * manifest: UpdateManifest, releaseInput: () => void, quitAndInstall: () => void,
 * progress: {show: (message: string) => void, update: (message: string) => void, close: () => void}}} options
 */
function setupUpdates({ app, autoUpdater, dialog, manifest, releaseInput, quitAndInstall, progress }) {
  if (!updatesEnabled(manifest, app.isPackaged, process.platform, process.arch)) return null;
  const { updateElectronApp } = require('update-electron-app');
  let busy = false;
  let downloading = false;
  let manual = false;
  let downloaded = false;
  let notes = '';
  let releaseName = '';
  let prompting = false;
  let stopping = false;
  let stopUpdates = () => {};
  async function promptUpdate() {
    if (prompting || stopping) return;
    prompting = true;
    try {
      const { response } = await dialog.showMessageBox({
        type: 'info', title: 'GLKVM Clean Update', message: releaseName || 'An update is ready.',
        detail: `Restart GLKVM Clean to install it.\n\nWhat's changed\n\n${notes || 'Release notes are unavailable for this version.'}`,
        buttons: ['Restart', 'Later'], defaultId: 1, cancelId: 1,
      });
      if (response === 0 && !stopping) quitAndInstall();
    } finally { prompting = false; }
  }
  autoUpdater.on('checking-for-update', () => { busy = true; });
  autoUpdater.on('update-available', () => {
    downloading = true;
    if (manual && !stopping) progress.update('Downloading update…');
  });
  autoUpdater.on('update-not-available', () => {
    busy = false; downloading = false;
    progress.close();
    if (manual && !stopping) void dialog.showMessageBox({ type: 'info', message: 'GLKVM Clean is up to date.', detail: `Version ${app.getVersion()}` });
    manual = false;
  });
  autoUpdater.on('error', () => {
    busy = false; downloading = false;
    progress.close();
    if (manual && !stopping) void dialog.showMessageBox({ type: 'error', message: 'Could not check for updates.', detail: 'Please try again later.' });
    manual = false;
  });
  autoUpdater.on('update-downloaded', (_event, releaseNotes, name) => {
    busy = false; downloading = false; manual = false; downloaded = true;
    progress.close();
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
    stop() { stopping = true; manual = false; progress.close(); stopUpdates(); },
    check() {
      if (stopping) return;
      if (downloaded) {
        void promptUpdate();
      } else {
        // A manual request joins the automatic check instead of disappearing.
        manual = true;
        progress.show(downloading ? 'Downloading update…' : 'Checking for updates…');
        if (busy) return;
        busy = true;
        try { autoUpdater.checkForUpdates(); }
        catch { busy = false; manual = false; progress.close(); void dialog.showMessageBox({ type: 'error', message: 'Could not check for updates.' }); }
      }
    },
  };
}
module.exports = { updatesEnabled, setupUpdates };
