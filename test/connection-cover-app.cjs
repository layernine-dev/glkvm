require('./runtime.cjs');
const { app, BrowserWindow, safeStorage } = require('electron');
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
const failureServer = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(fixture); });
const server = createServer((_request, response) => {
  setTimeout(() => { response.setHeader('content-type', 'text/html'); response.end(fixture); }, 1500);
});
/** @param {() => unknown | Promise<unknown>} condition */
async function waitFor(condition) {
  for (let attempt = 0; attempt < 200; attempt++) {
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
    const config = defaults();
    config.devices = ['clean', 'options'].map(id => ({ id, name: id, origin: `http://${id === 'options' ? 'localhost' : '127.0.0.1'}:${address.port}`, openAtStartup: true, startMode: id === 'options' ? 'options-enabled' : 'window-decoration-less' }));
    config.devices.push({ id: 'failed', name: 'failed', origin: `http://127.0.0.1:${failureAddress.port}`, openAtStartup: true, startMode: 'options-enabled' });
    const saved = await prepareConfig({ ...config, devices: config.devices.map(device => ({ ...device, password: device.id === 'failed' ? 'incorrect-fixture-secret' : 'fixture-secret' })) }, config, safeStorage);
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(saved));
    require('../src/main.cjs');
    await waitFor(() => BrowserWindow.getAllWindows().filter(window => ['clean', 'options'].includes(window.getTitle())).length === 2);
    const viewers = BrowserWindow.getAllWindows().filter(window => ['clean', 'options'].includes(window.getTitle()));
    await waitFor(() => viewers.every(window => coverFor(window)));
    const covers = viewers.map(window => coverFor(window));
    for (const [index, window] of viewers.entries()) {
      const cover = covers[index];
      assert.ok(cover, 'Local progress exists before the device page loads');
      assert.equal(window.isVisible(), false, 'Never show the device login page');
      window.webContents.on('did-start-navigation', details => {
        if (!details.isMainFrame || details.isSameDocument) return;
        assert.equal(coverFor(window), cover, 'The same progress window survives the authenticated reload');
        assert.equal(window.isVisible(), false, 'Reload stays hidden');
      });
    }
    await waitFor(() => covers.every(progress => progress?.isVisible()));
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
    const failed = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'failed');
    assert.ok(failed);
    const errorWindow = coverFor(failed);
    assert.ok(errorWindow);
    assert.equal(failed.isVisible(), false, 'Rejected login remains concealed');
    await waitFor(() => errorWindow.webContents.executeJavaScript("document.querySelector('#status').textContent.startsWith('Sign-in did not complete.')"));
    assert.equal(await errorWindow.webContents.executeJavaScript("document.body.classList.contains('busy')"), false, 'Failure stops the animation');
    await errorWindow.webContents.executeJavaScript("document.querySelector('[data-action=manual]').click()");
    await waitFor(() => failed.isVisible() && errorWindow.isDestroyed());
    assert.equal(await failed.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-options')"), true);
    assert.equal(await failed.webContents.executeJavaScript("document.querySelector('input[type=password]').getBoundingClientRect().width > 0"), true, 'Manual login fields are accessible');
    console.log('PASS: local startup progress in both start modes, hidden vendor login, unchanged progress window through session reload, authenticated reveal, bounded failure and manual login');
    failureServer.close(); server.close(); app.exit(0);
  } catch (error) { console.error(error); failureServer.close(); server.close(); app.exit(1); }
});
