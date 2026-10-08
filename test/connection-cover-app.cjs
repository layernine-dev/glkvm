require('./runtime.cjs');
const { app, BrowserWindow, Menu, safeStorage } = require('electron');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaults } = require('../src/config.cjs');
const { prepareConfig } = require('../src/credentials.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-cover-'));
app.setPath('userData', directory);
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
// Hold both the login page and authenticated reload so visibility races are observable.
const failureServer = createServer((request, response) => {
  if (request.headers.host?.startsWith('localhost:')) { response.destroy(); return; }
  response.setHeader('content-type', 'text/html'); response.end(fixture);
});
let manualDelay = 0;
const manualServer = createServer((_request, response) => {
  setTimeout(() => { response.setHeader('content-type', 'text/html'); response.end(fixture); }, manualDelay);
});
let unavailable = false;
let responseDelay = 1500;
const server = createServer((_request, response) => {
  if (unavailable) { response.destroy(); return; }
  setTimeout(() => { response.setHeader('content-type', 'text/html'); response.end(fixture); }, responseDelay);
});
/** @param {() => unknown | Promise<unknown>} condition */
async function waitFor(condition) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for connection cover.');
}
/** @param {Electron.BrowserWindow} window */
function coverFor(window) {
  return BrowserWindow.getAllWindows().find(progress => progress.getTitle() === `${window.getTitle()} — Connecting`);
}

server.listen(0, '127.0.0.1', async () => {
  try {
    await app.whenReady();
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise(resolve => failureServer.listen(0, '127.0.0.1', () => resolve(null)));
    const failureAddress = failureServer.address();
    assert.ok(failureAddress && typeof failureAddress !== 'string');
    await new Promise(resolve => manualServer.listen(0, '127.0.0.1', () => resolve(null)));
    const manualAddress = manualServer.address();
    assert.ok(manualAddress && typeof manualAddress !== 'string');
    const config = defaults();
    config.devices = ['clean', 'options'].map(id => ({ id, name: id, origin: `http://${id === 'options' ? 'localhost' : '127.0.0.1'}:${address.port}`, openAtStartup: true, startMode: id === 'options' ? 'options-enabled' : 'window-decoration-less' }));
    config.devices.push({ id: 'failed', name: 'failed', origin: `http://127.0.0.1:${failureAddress.port}`, openAtStartup: true, startMode: 'options-enabled' });
    config.devices.push({ id: 'offline', name: 'offline', origin: `http://localhost:${failureAddress.port}`, openAtStartup: true });
    config.devices.push({ id: 'manual', name: 'manual', origin: `http://127.0.0.1:${manualAddress.port}`, openAtStartup: false, startMode: 'options-enabled' });
    const saved = await prepareConfig({ ...config, devices: config.devices.map(device => ({ ...device, password: device.id === 'manual' ? undefined : device.id === 'failed' ? 'incorrect-fixture-secret' : 'fixture-secret' })) }, config, safeStorage);
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(saved));
    require('../src/main.cjs');
    await waitFor(() => BrowserWindow.getAllWindows().filter(window => ['clean', 'options'].includes(window.getTitle())).length === 2);
    const viewers = BrowserWindow.getAllWindows().filter(window => ['clean', 'options'].includes(window.getTitle()));
    await waitFor(() => viewers.every(window => coverFor(window)));
    const early = viewers.find(window => window.getTitle() === 'clean');
    assert.ok(early);
    const cleanInitialSize = early.getSize();
    const earlyCover = coverFor(early);
    assert.ok(earlyCover);
    await waitFor(() => !earlyCover.webContents.isLoading() && earlyCover.isVisible());
    assert.equal(early.webContents.isLoading(), true, 'Device is still loading before its password DOM can report');
    await earlyCover.webContents.executeJavaScript("document.querySelector('[data-action=manual]').click()");
    await waitFor(() => early.isVisible() && earlyCover.isDestroyed());
    Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []).find(item => item.label === 'Device Settings…')?.click();
    await waitFor(() => !early.isVisible() && coverFor(early));
    const covers = viewers.map(window => coverFor(window));
    for (const [index, window] of viewers.entries()) {
      const cover = covers[index];
      assert.ok(cover, 'Local progress exists before the device page loads');
      assert.equal(window.isVisible(), false, 'Never show the device login page');
      window.webContents.once('did-start-navigation', details => {
        if (!details.isMainFrame || details.isSameDocument) return;
        assert.equal(coverFor(window), cover, 'The same progress window survives the authenticated reload');
        assert.equal(window.isVisible(), false, 'Reload stays hidden');
      });
    }
    await waitFor(() => covers.every(progress => progress?.isVisible()));
    app.emit('second-instance', {}, [], process.cwd());
    await waitFor(() => covers.find(progress => progress?.getTitle() === 'clean — Connecting')?.isFocused());
    assert.equal(viewers.every(window => !window.isVisible()), true, 'Duplicate launch activates progress without exposing the viewer');
    await waitFor(() => viewers.every(window => !window.webContents.isLoading()));
    assert.equal(await viewers.find(window => window.getTitle() === 'options')?.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-options')"), true);
    for (const [index, window] of viewers.entries()) assert.equal(coverFor(window), covers[index], 'Both startup modes hide the vendor login page');
    const screenshot = covers[0];
    assert.ok(screenshot);
    fs.writeFileSync('/tmp/glkvm-native-cover.png', (await screenshot.capturePage()).toPNG());
    await waitFor(() => viewers.every(window => !coverFor(window)));
    for (const window of viewers) {
      assert.equal(await window.webContents.executeJavaScript("document.querySelector('.auth-form-container') === null"), true);
      assert.equal(window.isVisible(), true, 'Show the authenticated device window');
      assert.equal(window.webContents.isLoading(), false, 'Reveal only after the authenticated page finishes loading');
    }
    Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []).find(item => item.label === 'Open manual')?.click();
    await waitFor(() => BrowserWindow.getAllWindows().some(window => window.getTitle() === 'manual'));
    const manual = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'manual');
    assert.ok(manual);
    await waitFor(() => manual.isVisible() && !coverFor(manual));
    manualDelay = 60000;
    manual.webContents.reload();
    await waitFor(() => coverFor(manual));
    const reloading = viewers.find(window => window.getTitle() === 'clean');
    assert.ok(reloading);
    app.focus({ steal: true }); reloading.focus();
    await waitFor(() => reloading.isFocused());
    reloading.webContents.reload();
    await waitFor(() => !reloading.isVisible() && coverFor(reloading));
    app.hide();
    await waitFor(() => !app.isActive());
    await waitFor(() => !reloading.webContents.isLoading());
    assert.equal(app.isHidden(), true, 'Reload completion preserves app hiding');
    assert.equal(reloading.isVisible(), false);
    assert.equal(coverFor(reloading)?.isVisible(), false, 'Progress stays hidden with its app');
    assert.equal(app.isActive(), false, 'Reload completion does not reactivate an inactive app');
    assert.equal(reloading.isFocused(), false, 'Reload completion does not steal focus after app deactivation');
    app.show(); app.focus({ steal: true });
    await waitFor(() => reloading.isVisible() && !coverFor(reloading) && reloading.isFocusable());
    reloading.focus();
    await waitFor(() => reloading.isFocused());
    app.hide();
    await waitFor(() => app.isHidden());
    reloading.webContents.reload();
    await waitFor(() => coverFor(reloading) && !coverFor(reloading)?.webContents.isLoading());
    assert.equal(app.isHidden(), true, 'A navigation begun while hidden keeps the app hidden');
    assert.equal(coverFor(reloading)?.isVisible(), false, 'A newly created cover respects app hiding');
    app.show(); app.focus({ steal: true });
    await waitFor(() => coverFor(reloading)?.isVisible());
    assert.equal(reloading.webContents.isLoading(), true, 'Activation occurs during the delayed navigation');
    assert.equal(reloading.isVisible(), false, 'App unhide never restores the loading remote viewer behind progress');
    await waitFor(() => reloading.isVisible() && !coverFor(reloading) && reloading.isFocusable());
    reloading.focus();
    await waitFor(() => reloading.isFocused());
    reloading.minimize();
    await waitFor(() => reloading.isMinimized());
    reloading.webContents.reload();
    await waitFor(() => coverFor(reloading));
    await waitFor(() => !reloading.webContents.isLoading() && !coverFor(reloading));
    assert.equal(reloading.isMinimized(), true, 'A completed background reload preserves minimization');
    reloading.webContents.reload();
    await waitFor(() => coverFor(reloading));
    app.emit('second-instance', {}, [], process.cwd());
    await waitFor(() => coverFor(reloading)?.isVisible());
    assert.equal(reloading.isVisible(), false, 'Reopening a minimized loading connection never restores the remote page');
    await waitFor(() => reloading.isVisible() && !reloading.isMinimized() && !coverFor(reloading));
    // A returning SPA login must report authenticated readiness again without HDMI video.
    const returning = viewers.find(window => window.getTitle() === 'options');
    assert.ok(returning);
    let loginReported = false;
    let readyReported = false;
    returning.webContents.on('ipc-message', (_event, channel) => {
      if (channel === 'glkvm:login-required') loginReported = true;
      if (channel === 'glkvm:viewer-page-ready') readyReported = true;
    });
    await returning.webContents.executeJavaScript('window.logout()');
    await waitFor(() => loginReported);
    await returning.webContents.executeJavaScript("document.querySelector('#login').remove()");
    await waitFor(() => readyReported);
    assert.equal(await returning.webContents.executeJavaScript("document.querySelector('#stream-video') === null"), true, 'Returning authentication completes without a live video');
    unavailable = true;
    reloading.webContents.reload();
    await waitFor(() => !reloading.webContents.isLoading() && coverFor(reloading)?.isVisible());
    const failedReload = coverFor(reloading);
    assert.ok(failedReload);
    await waitFor(() => failedReload.webContents.executeJavaScript("document.querySelector('#status').textContent.startsWith('Could not connect')"));
    assert.equal(reloading.isVisible(), false, 'A failed reload keeps the stale device page concealed');
    unavailable = false;
    responseDelay = 25000;
    reloading.webContents.reload();
    await waitFor(() => failedReload.webContents.executeJavaScript("document.querySelector('#status').textContent === 'Connecting to video…' && document.body.classList.contains('busy')"));
    await waitFor(() => failedReload.webContents.executeJavaScript("document.querySelector('#status').textContent.startsWith('Connection did not complete.') && !document.body.classList.contains('busy')"));
    assert.equal(reloading.isVisible(), false, 'A stalled retry has its own bounded failure');
    responseDelay = 1500;
    reloading.webContents.reload();
    await waitFor(() => reloading.isVisible() && !coverFor(reloading));
    const manualCover = coverFor(manual);
    assert.ok(manualCover);
    await waitFor(() => manualCover.webContents.executeJavaScript("document.querySelector('#status').textContent.includes('did not complete.') && !document.body.classList.contains('busy')"));
    manualDelay = 0;
    app.hide();
    await waitFor(() => app.isHidden());
    manual.webContents.reload();
    await waitFor(() => !manual.webContents.isLoading() && !coverFor(manual));
    assert.equal(app.isHidden(), true, 'Manual login also honors app hiding');
    assert.equal(manual.isVisible(), false);
    app.show(); app.focus({ steal: true });
    await waitFor(() => manual.isVisible());
    assert.equal(await manual.webContents.executeJavaScript("document.querySelector('input[type=password]').getBoundingClientRect().width > 0"), true, 'Reload returns to usable manual login without saved credentials');
    const failed = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'failed');
    assert.ok(failed);
    const errorWindow = coverFor(failed);
    assert.ok(errorWindow);
    assert.equal(failed.isVisible(), false, 'Rejected login remains concealed');
    await waitFor(() => errorWindow.webContents.executeJavaScript("document.querySelector('#status').textContent.startsWith('Sign-in did not complete.')"));
    assert.equal(await errorWindow.webContents.executeJavaScript("document.body.classList.contains('busy')"), false, 'Failure stops the animation');
    errorWindow.focus();
    await waitFor(() => errorWindow.isFocused());
    const controls = Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []).find(item => item.label === 'Device Settings…');
    assert.ok(controls);
    controls.click();
    await waitFor(() => failed.isVisible() && errorWindow.isDestroyed());
    assert.equal(await failed.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-options')"), true);
    assert.equal(await failed.webContents.executeJavaScript("document.querySelector('input[type=password]').getBoundingClientRect().width > 0"), true, 'Manual login fields are accessible');
    controls.click();
    await waitFor(() => !failed.isVisible() && coverFor(failed)?.isVisible());
    assert.deepEqual(failed.getSize(), cleanInitialSize, 'Repeatedly opening startup-enabled controls preserves clean-view bounds');
    const restored = coverFor(failed);
    assert.ok(restored);
    await restored.webContents.executeJavaScript("document.querySelector('[data-action=manual]').click()");
    await waitFor(() => failed.isVisible() && restored.isDestroyed());
    assert.equal(await failed.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-options')"), true, 'Both shortcut and button expose manual controls');

    const offline = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'offline');
    assert.ok(offline);
    const offlineCover = coverFor(offline);
    assert.ok(offlineCover);
    await waitFor(() => offlineCover.webContents.executeJavaScript("document.querySelector('#status').textContent.startsWith('Could not connect')"));
    Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []).find(item => item.label === 'Settings…')?.click();
    await waitFor(() => BrowserWindow.getAllWindows().some(window => window.getTitle() === 'GLKVM Clean Settings' && !window.webContents.isLoading()));
    const settings = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'GLKVM Clean Settings');
    assert.ok(settings);
    assert.equal(await settings.webContents.executeJavaScript(`(async () => {
      const value = await window.settings.load();
      const offline = value.devices.find(device => device.id === 'offline');
      offline.removePassword = true; offline.name = 'Renamed offline';
      return (await window.settings.save(value)).ok;
    })()`), true);
    assert.equal(coverFor(offline), offlineCover, 'Removing a password preserves network failure feedback');
    assert.equal(offlineCover.isVisible(), true);
    assert.equal(offlineCover.getTitle(), 'Renamed offline — Connecting');
    await waitFor(() => offlineCover.webContents.executeJavaScript("document.querySelector('#name').textContent === 'Renamed offline'"));
    assert.equal(offline.isVisible(), false);

    failed.focus();
    await waitFor(() => failed.isFocused());
    controls.click();
    await waitFor(() => !failed.isVisible() && coverFor(failed)?.isVisible());
    const cancelled = coverFor(failed);
    const failedHelper = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'failed — Device Settings');
    assert.ok(cancelled);
    assert.ok(failedHelper);
    cancelled.close();
    await waitFor(() => failed.isDestroyed() && failedHelper.isDestroyed());

    console.log('PASS: local startup progress in both start modes, hidden vendor login, unchanged progress window through session reload, authenticated reveal, bounded failure and manual login');
    failureServer.close(); manualServer.close(); server.close(); app.exit(0);
  } catch (error) { console.error(error); failureServer.close(); manualServer.close(); server.close(); app.exit(1); }
});
