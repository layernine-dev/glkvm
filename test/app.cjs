const { app, BrowserWindow, Menu, safeStorage, globalShortcut, screen } = require('electron');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareConfig } = require('../src/credentials.cjs');
const { defaults } = require('../src/config.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-app-'));
app.setPath('userData', directory);
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(path.join(__dirname, 'fixture.html')));
});
/** @param {() => unknown | Promise<unknown>} condition */
async function waitFor(condition) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for application state.');
}
/** @param {string} label */
function command(label) {
  const menus = Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []) || [];
  const item = menus.find(item => item.label === label);
  assert.ok(item?.enabled, `${label} is enabled`);
  item.click(undefined, BrowserWindow.getFocusedWindow(), undefined);
}
server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = defaults();
  config.devices = [{ id: 'fixture', name: 'Fixture', origin: `http://127.0.0.1:${address.port}`, openAtStartup: true }];
  await app.whenReady();
  const stored = await prepareConfig({ ...config, devices: [{ ...config.devices[0], password: 'incorrect-fixture-secret' }] }, config, safeStorage);
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(stored));
  require('../src/main.cjs');
  try {
    await app.whenReady();
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'GLKVM Fixture'));
    const clean = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'GLKVM Fixture');
    assert.ok(clean);
    await waitFor(() => !clean.webContents.isLoading());
    assert.equal(await clean.webContents.executeJavaScript('getComputedStyle(document.body).visibility'), 'hidden');
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'Fixture — Device Settings'));
    const login = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Fixture — Device Settings');
    assert.ok(login);
    await waitFor(() => !login.webContents.isLoading());
    assert.equal(login.isVisible(), false);
    assert.deepEqual(BrowserWindow.getAllWindows().filter(win => win.isVisible()).map(win => win.getTitle()), ['GLKVM Fixture']);

    await waitFor(() => login.webContents.executeJavaScript("document.querySelector('#password')?.value === 'incorrect-fixture-secret'"));
    command('Settings…');
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'GLKVM Clean Settings'));
    const passwordSettings = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'GLKVM Clean Settings');
    assert.ok(passwordSettings);
    await waitFor(() => !passwordSettings.webContents.isLoading());
    assert.equal(await passwordSettings.webContents.executeJavaScript(`(async () => {
      const value = await window.settings.load();
      value.devices[0].password = 'fixture-secret';
      return (await window.settings.save(value)).ok;
    })()`), true);
    await waitFor(() => clean.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-control')"));
    await waitFor(() => login.isDestroyed());
    assert.equal(new URL(clean.webContents.getURL()).hash, '');
    assert.equal(BrowserWindow.getAllWindows().some(win => win.getTitle().endsWith('— Device Settings')), false);
    const bounds = clean.getBounds();
    clean.focus();
    await waitFor(() => clean.isFocused());
    // Mode shortcuts must work before/after player focus and native dragging.
    for (let cycle = 0; cycle < 2; cycle++) {
      /** @type {Electron.KeyboardInputEvent['modifiers']} */
      const modifiers = ['meta', 'shift'];
      await clean.webContents.executeJavaScript("document.querySelector('#stream-box').focus()");
      const inputBefore = await clean.webContents.executeJavaScript('window.inputEvents');
      clean.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers });
      clean.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'M', modifiers });
      await waitFor(() => clean.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-drag')"));
      clean.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers: [...modifiers, 'isautorepeat'] });
      assert.equal(await clean.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-drag')"), true);
      clean.setPosition(bounds.x + 20, bounds.y + 20);
      clean.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers });
      clean.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'M', modifiers });
      await waitFor(() => clean.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-control')"));
      assert.equal(await clean.webContents.executeJavaScript('window.inputEvents'), inputBefore);
    }
    assert.ok(globalShortcut.isRegistered('CommandOrControl+Shift+M'));
    const windowMenu = Menu.getApplicationMenu()?.items.find(item => item.label === 'Window')?.submenu;
    assert.ok(!windowMenu?.items.some(item => ['Video Scale', 'Resolution Presets', '640 px Wide'].includes(item.label)));
    const sizes = windowMenu?.items.find(item => item.label === 'Window Size')?.submenu;
    assert.equal(sizes?.items.length, 6);
    const nativeSize = sizes?.items.find(item => item.label.includes('(1:1 pixels)'));
    assert.ok(nativeSize?.enabled);
    nativeSize.click(undefined, clean, undefined);
    const density = screen.getDisplayMatching(clean.getBounds()).scaleFactor;
    assert.deepEqual(clean.getContentSize(), [Math.round(640 / density), Math.round(360 / density)]);
    clean.setAspectRatio(0);
    clean.setBounds(bounds);
    clean.setAspectRatio(640 / 360);
    command('Device Settings…');
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'Fixture — Device Settings'));
    const consoleWindow = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Fixture — Device Settings');
    assert.ok(consoleWindow);
    consoleWindow.focus();
    await waitFor(() => consoleWindow.isFocused() && !globalShortcut.isRegistered('CommandOrControl+Shift+M'));
    await waitFor(() => !consoleWindow.webContents.isLoading());
    assert.equal(consoleWindow.webContents.session, clean.webContents.session);
    assert.deepEqual(clean.getBounds(), bounds);
    assert.equal(clean.getTitle(), 'GLKVM Fixture');
    assert.equal(await clean.webContents.executeJavaScript("getComputedStyle(document.querySelector('#toolbar')).visibility"), 'hidden');
    assert.equal(await consoleWindow.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-clean')"), false);
    command('Settings…');
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'GLKVM Clean Settings'));
    const settings = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'GLKVM Clean Settings');
    assert.ok(settings);
    await waitFor(() => !settings.webContents.isLoading());
    const loaded = await settings.webContents.executeJavaScript('window.settings.load()');
    assert.equal(loaded.devices[0].name, 'Fixture');
    assert.equal(loaded.devices[0].hasPassword, true);
    assert.equal(loaded.devices[0].encryptedPassword, undefined);
    assert.ok(!JSON.stringify(loaded).includes('fixture-secret'));
    assert.ok(!fs.readFileSync(path.join(directory, 'settings.json'), 'utf8').includes('fixture-secret'));
    assert.equal(await clean.webContents.executeJavaScript('typeof window.settings'), 'undefined');
    const edited = { ...loaded, controlEnabled: false, devices: [{ ...loaded.devices[0], name: 'Renamed' }] };
    const saved = await settings.webContents.executeJavaScript(`window.settings.save(${JSON.stringify(edited)})`);
    assert.equal(saved.ok, true);
    await waitFor(() => clean.webContents.executeJavaScript("!document.documentElement.hasAttribute('data-glkvm-control')"));
    assert.equal(clean.getTitle(), 'GLKVM Renamed');
    assert.equal(consoleWindow.getTitle(), 'Renamed — Device Settings');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8')).devices[0].name, 'Renamed');
    clean.focus();
    await waitFor(() => clean.isFocused());
    clean.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers: ['meta', 'shift'] });
    clean.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'M', modifiers: ['meta', 'shift'] });
    await waitFor(() => clean.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-control')"));
    settings.focus();
    await waitFor(() => settings.isFocused());
    const invalid = { ...edited, devices: [{ ...edited.devices[0], origin: 'file:///etc' }] };
    assert.equal((await settings.webContents.executeJavaScript(`window.settings.save(${JSON.stringify(invalid)})`)).ok, false);
    assert.equal(clean.isDestroyed(), false);
    const empty = { ...edited, devices: [] };
    assert.equal((await settings.webContents.executeJavaScript(`window.settings.save(${JSON.stringify(empty)})`)).ok, true);
    await waitFor(() => clean.isDestroyed() && consoleWindow.isDestroyed());
    assert.equal(settings.isDestroyed(), false);
    console.log('PASS: app startup, separate login and automatic clean reconnect, isolated settings bridge, separate vendor window, preserved sharing bounds/title, shared login session, saved settings, live mode/name changes, rejected invalid save, connection removal');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { server.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
