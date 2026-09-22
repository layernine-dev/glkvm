const { app, BrowserWindow, Menu, safeStorage, globalShortcut, screen, clipboard } = require('electron');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareConfig } = require('../src/credentials.cjs');
const { defaults } = require('../src/config.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-app-'));
app.setPath('userData', directory);
/** @type {{url: string, body: string}[]} */
const pastes = [];
const server = createServer((_req, res) => {
  if (_req.url?.startsWith('/api/hid/print')) {
    let body = '';
    _req.on('data', chunk => { body += chunk; });
    _req.on('end', () => { pastes.push({ url: _req.url || '', body }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); });
    return;
  }
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
  config.devices.push({ id: 'second', name: 'Second', origin: config.devices[0].origin.replace('127.0.0.1', 'localhost'), openAtStartup: false });
  await app.whenReady();
  const stored = await prepareConfig({ ...config, devices: [{ ...config.devices[0], password: 'incorrect-fixture-secret' }, config.devices[1]] }, config, safeStorage);
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(stored));
  require('../src/main.cjs');
  try {
    await app.whenReady();
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'Fixture'));
    const clean = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Fixture');
    assert.ok(clean);
    await waitFor(() => !clean.webContents.isLoading());
    assert.equal(await clean.webContents.executeJavaScript('getComputedStyle(document.body).visibility'), 'hidden');
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'Fixture — Device Settings'));
    const login = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Fixture — Device Settings');
    assert.ok(login);
    await waitFor(() => !login.webContents.isLoading());
    assert.equal(login.isVisible(), false);
    assert.deepEqual(BrowserWindow.getAllWindows().filter(win => win.isVisible()).map(win => win.getTitle()), ['Fixture']);

    await waitFor(() => login.webContents.executeJavaScript("document.querySelector('#password')?.value === 'incorrect-fixture-secret'"));
    command('Settings…');
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'GLKVM Clean Settings'));
    const passwordSettings = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'GLKVM Clean Settings');
    assert.ok(passwordSettings);
    await waitFor(() => !passwordSettings.webContents.isLoading());
    await waitFor(() => passwordSettings.webContents.executeJavaScript("document.querySelector('#keyboard-bindings button') !== null"));
    await passwordSettings.webContents.executeJavaScript("document.querySelector('#keyboard-tab').click()");
    assert.equal(await passwordSettings.webContents.executeJavaScript("document.querySelector('#keyboard').hidden"), false);
    await passwordSettings.webContents.executeJavaScript(`
      const record = document.querySelector('#keyboard-bindings button');
      record.click(); record.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', altKey: true, bubbles: true }));
      document.querySelector('#settings-form').requestSubmit();
    `);
    await waitFor(() => passwordSettings.webContents.executeJavaScript("document.querySelector('#save-status').textContent === 'Changes saved'"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8')).keyboard.insert.code, 'KeyI');
    await passwordSettings.webContents.executeJavaScript(`(async () => {
      const value = await settings.load(); value.keyboard.insert = ${JSON.stringify(defaults().keyboard?.insert)};
      config = (await settings.save(value)).config;
      render();
    })()`);
    await waitFor(() => passwordSettings.webContents.executeJavaScript("document.querySelector('#keyboard-bindings button')?.textContent === '⌘´'"));
    await passwordSettings.webContents.executeJavaScript("document.querySelector('#keyboard-tab').click()");
    fs.writeFileSync('/tmp/glkvm-keyboard-settings.png', (await passwordSettings.webContents.capturePage()).toPNG());
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
    app.focus({ steal: true });
    clean.focus();
    await waitFor(() => clean.isFocused());
    await clean.webContents.executeJavaScript("document.querySelector('#stream-box').focus(); window.keyLog = []");
    await new Promise(resolve => setTimeout(resolve, 150));
    clean.webContents.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['meta'] });
    clean.webContents.sendInputEvent({ type: 'keyUp', keyCode: '=', modifiers: ['meta'] });
    await waitFor(() => clean.webContents.executeJavaScript("window.keyLog.some(e => e[1] === 'Insert')"));
    assert.deepEqual(await clean.webContents.executeJavaScript("window.keyLog.filter(e => ['Insert', 'Equal'].includes(e[1]))"), [['keydown', 'Insert'], ['keyup', 'Insert']]);
    await clean.webContents.executeJavaScript('window.keyLog = []');
    clean.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace', modifiers: ['meta', 'alt'] });
    clean.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace', modifiers: ['meta', 'alt'] });
    await waitFor(() => clean.webContents.executeJavaScript("window.keyLog.filter(e => ['ControlLeft', 'AltLeft', 'Delete', 'Backspace'].includes(e[1])).length === 6"));
    assert.deepEqual(await clean.webContents.executeJavaScript("window.keyLog.filter(e => ['ControlLeft', 'AltLeft', 'Delete', 'Backspace'].includes(e[1]))"), [['keydown', 'ControlLeft'], ['keydown', 'AltLeft'], ['keydown', 'Delete'], ['keyup', 'Delete'], ['keyup', 'AltLeft'], ['keyup', 'ControlLeft']]);
    // Exercise native shortcut dispatch without modifying the system clipboard.
    const readClipboard = clipboard.readText;
    try {
      clipboard.readText = async () => 'Grüße aus Notes\nSecond line';
      clean.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['meta'] });
      clean.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['meta'] });
      await waitFor(() => pastes.length === 1);
      clean.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['meta', 'isautorepeat'] });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(pastes.length, 1, 'Auto-repeat never resends clipboard text');
      assert.deepEqual(pastes[0], { url: '/api/hid/print?limit=0&keymap=de', body: 'Grüße aus Notes\nSecond line' });
    } finally {
      clipboard.readText = readClipboard;
    }
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
    const originalId = clean.id;
    const originalContents = clean.webContents.id;
    const documentToken = await clean.webContents.executeJavaScript('window.documentToken = Math.random()');
    for (let cycle = 0; cycle < 2; cycle++) {
      clean.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'O', modifiers: ['meta', 'shift'] });
      clean.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'O', modifiers: ['meta', 'shift'] });
      await waitFor(() => clean.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-options')"));
      assert.equal(await clean.webContents.executeJavaScript("getComputedStyle(document.querySelector('#toolbar')).visibility"), 'visible');
      assert.equal(clean.hasShadow(), true);
      assert.equal(await clean.webContents.executeJavaScript("document.querySelectorAll('#glkvm-title-bar button').length"), 3);
      assert.equal(clean.id, originalId);
      assert.equal(clean.webContents.id, originalContents);
      assert.equal(BrowserWindow.getAllWindows().some(win => win.getTitle().endsWith('— Device Settings')), false);
      assert.ok(Menu.getApplicationMenu()?.items.some(item => item.label === 'Device — Fixture'));
      clean.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'O', modifiers: ['meta', 'shift'] });
      clean.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'O', modifiers: ['meta', 'shift'] });
      await waitFor(() => clean.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-clean')"));
      assert.equal(await clean.webContents.executeJavaScript("getComputedStyle(document.querySelector('#toolbar')).visibility"), 'hidden');
      assert.equal(clean.hasShadow(), false);
      assert.deepEqual(clean.getBounds(), bounds);
      assert.equal(await clean.webContents.executeJavaScript('window.documentToken'), documentToken);
    }
    command('Device Settings…');
    await waitFor(() => clean.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-options')"));
    await clean.webContents.executeJavaScript("document.querySelector('#glkvm-title-bar button[aria-label=\"Minimize window\"]').click()");
    await waitFor(() => clean.isMinimized());
    clean.restore();
    await waitFor(() => !clean.isMinimized());
    app.focus({ steal: true });
    clean.focus();
    await waitFor(() => clean.isFocused());
    command('Device Settings…');
    await waitFor(() => clean.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-clean')"));
    // App shortcuts also work after remote editing has disabled menu accelerators.
    clean.webContents.setIgnoreMenuShortcuts(true);
    clean.webContents.sendInputEvent({ type: 'keyDown', keyCode: '2', modifiers: ['meta'] });
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'Second'));
    const second = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Second');
    assert.ok(second);
    await waitFor(() => second.isFocused() && !second.webContents.isLoading());
    assert.ok(Menu.getApplicationMenu()?.items.some(item => item.label === 'Device — Second'));
    second.webContents.sendInputEvent({ type: 'keyDown', keyCode: '1', modifiers: ['meta'] });
    await waitFor(() => clean.isFocused());
    assert.ok(globalShortcut.isRegistered('CommandOrControl+1'));
    assert.ok(globalShortcut.isRegistered('CommandOrControl+2'));
    second.focus();
    await waitFor(() => second.isFocused());
    second.webContents.setIgnoreMenuShortcuts(true);
    second.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers: ['meta', 'shift'] });
    await waitFor(() => second.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-drag')"));
    second.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
    await waitFor(() => second.isDestroyed());
    assert.equal(clean.isDestroyed(), false);
    clean.focus();
    await waitFor(() => clean.isFocused());
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
    assert.equal(clean.getTitle(), 'Renamed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8')).devices[0].name, 'Renamed');
    clean.focus();
    await waitFor(() => clean.isFocused());
    clean.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers: ['meta', 'shift'] });
    clean.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'M', modifiers: ['meta', 'shift'] });
    await waitFor(() => clean.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-control')"));
    settings.focus();
    await waitFor(() => settings.isFocused());
    await settings.webContents.executeJavaScript(`(async () => {
      const value = await window.settings.load();
      value.devices[0].startMode = 'options-enabled';
      value.devices[0].windowScale = 2;
      const result = await window.settings.save(value);
      if (!result.ok) throw new Error(result.error);
    })()`);
    await clean.webContents.session.clearStorageData({ storages: ['localstorage'] });
    clean.close();
    await waitFor(() => clean.isDestroyed());
    await settings.webContents.executeJavaScript("window.settings.open('fixture')");
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'Renamed'));
    const reopened = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Renamed');
    assert.ok(reopened);
    await waitFor(() => !reopened.webContents.isLoading());
    await waitFor(() => reopened.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-options')"));
    assert.equal(reopened.hasShadow(), true);
    assert.equal(await reopened.webContents.executeJavaScript("document.querySelector('#glkvm-title-bar span').textContent"), 'Renamed');
    await waitFor(() => reopened.webContents.executeJavaScript("document.querySelector('video')?.videoWidth === 640"));
    await waitFor(() => reopened.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-sized')"));
    const optionsDensity = screen.getDisplayMatching(reopened.getBounds()).scaleFactor;
    await waitFor(async () => {
      const rect = await reopened.webContents.executeJavaScript("(() => { const r = document.querySelector('video').getBoundingClientRect(); return { width: r.width, height: r.height }; })()");
      return rect.width === 640 * 2 / optionsDensity && rect.height === 360 * 2 / optionsDensity;
    });
    reopened.focus();
    await waitFor(() => reopened.isFocused());
    await waitFor(() => Menu.getApplicationMenu()?.items.find(item => item.label === 'Window')?.submenu?.items.find(item => item.label === 'Window Size')?.enabled);
    const optionsSizes = Menu.getApplicationMenu()?.items.find(item => item.label === 'Window')?.submenu?.items.find(item => item.label === 'Window Size');
    assert.ok(optionsSizes?.enabled);
    // Reproduce the vendor's nested full-height, vertically centered player layout.
    await reopened.webContents.executeJavaScript(`(() => {
      const style = document.createElement('style');
      style.textContent = 'html,body{height:100%}.kvm-page-container,.kvm-page-content,.player-outer,.player-container{height:100%}.player-content{height:100%;display:flex;align-items:center}.ant-spin-nested-loading,.ant-spin-container{height:100%;width:100%;display:flex;align-items:center;justify-content:center}.kvm-video-info{height:32px}';
      document.head.append(style);
      style.textContent += '#stream-window.is-fixed-scale.stream-window-inited[data-v-fixture]{width:auto!important;height:auto!important}#stream-window.is-fixed-scale #stream-box[data-v-fixture]{max-width:100%;max-height:100%}#stream-window.is-fixed-scale #stream-video[data-v-fixture]{width:unset!important;height:unset!important;position:static!important;max-width:100%;max-height:100%}';
      const frame = document.querySelector('#stream-window');
      frame.className = 'is-fixed-scale stream-window-inited'; frame.setAttribute('data-v-fixture', '');
      document.querySelector('#stream-box').setAttribute('data-v-fixture', '');
      const host = document.createElement('div'); host.className = 'kvm-page-container';
      host.innerHTML = '<div class="kvm-page-content"><div class="player-outer"><div class="player-container"><div class="player-content"><div class="ant-spin-nested-loading"><div class="ant-spin-container"></div></div></div></div></div></div>';
      frame.before(host); host.querySelector('.ant-spin-container').append(frame);
      const footer = document.createElement('div'); footer.className = 'kvm-video-info'; footer.textContent = 'Status'; host.append(footer);
      window.connect(1280, 720);
      document.querySelector('#stream-video').setAttribute('data-v-fixture', '');
    })()`);
    await waitFor(() => reopened.webContents.executeJavaScript("document.querySelector('video').videoWidth === 1280"));
    for (const scale of [1, 1.5, 2]) {
      await waitFor(() => Menu.getApplicationMenu()?.items.find(item => item.label === 'Window')?.submenu?.items.find(item => item.label === 'Window Size')?.submenu?.items.find(item => item.label.startsWith(`${scale}×`))?.enabled);
      const item = Menu.getApplicationMenu()?.items.find(item => item.label === 'Window')?.submenu?.items.find(item => item.label === 'Window Size')?.submenu?.items.find(item => item.label.startsWith(`${scale}×`));
      assert.ok(item?.enabled, `Scale ${scale}: ${item?.label}`);
      item.click(undefined, reopened, undefined);
      await waitFor(async () => {
        const rect = await reopened.webContents.executeJavaScript("(() => { const r = document.querySelector('video').getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top }; })()");
        return rect.width === 1280 * scale / optionsDensity && rect.height === 720 * scale / optionsDensity
          && reopened.getContentSize()[1] >= rect.top + rect.height;
      });
    }
    const layout = await reopened.webContents.executeJavaScript(`(() => {
      const video = document.querySelector('video').getBoundingClientRect();
      const toolbar = document.querySelector('#toolbar').getBoundingClientRect();
      const footer = document.querySelector('.kvm-video-info').getBoundingClientRect();
      return { videoTop: video.top, videoBottom: video.bottom, toolbarBottom: toolbar.bottom, footerTop: footer.top, footerBottom: footer.bottom, viewport: innerHeight };
    })()`);
    assert.equal(layout.videoTop, layout.toolbarBottom, 'No empty band above the video');
    assert.equal(layout.footerTop, layout.videoBottom, 'Status follows the video without an empty band');
    assert.ok(Math.abs(layout.footerBottom - layout.viewport) < 1, 'Window ends after status content, rounded to a whole window point');
    const beforeSidebar = reopened.getBounds();
    await reopened.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('.kvm-page-content');
      const row = document.createElement('div'); row.style.display = 'flex';
      const sidebar = document.createElement('aside'); sidebar.id = 'test-sidebar';
      sidebar.style.cssText = 'width:260px;flex:none'; sidebar.textContent = 'Session Settings';
      content.before(row); row.append(sidebar, content);
      content.style.cssText = 'width:100%;flex-shrink:1';
    })()`);
    await waitFor(async () => {
      const metrics = await reopened.webContents.executeJavaScript(`(() => {
        const video = document.querySelector('video').getBoundingClientRect();
        const content = document.querySelector('.player-content').getBoundingClientRect();
        return { width: video.width, height: video.height, available: content.width, right: video.right, viewport: innerWidth };
      })()`);
      return Math.abs(metrics.width - (1280 * 2 / optionsDensity - 260)) < 1
        && Math.abs(metrics.width / metrics.height - 1280 / 720) < 0.001
        && metrics.right <= metrics.viewport + 1;
    });
    assert.deepEqual(reopened.getBounds(), beforeSidebar, 'Opening a sidebar does not resize the window');
    await reopened.webContents.executeJavaScript("document.querySelector('#test-sidebar').remove()");
    await waitFor(async () => {
      const width = await reopened.webContents.executeJavaScript("document.querySelector('video').getBoundingClientRect().width");
      return width === 1280 * 2 / optionsDensity;
    });
    assert.deepEqual(reopened.getBounds(), beforeSidebar, 'Closing a sidebar restores video size in the same window');
    command('Device Settings…');
    await waitFor(() => reopened.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-clean')"));
    const reopenedDensity = screen.getDisplayMatching(reopened.getBounds()).scaleFactor;
    assert.deepEqual(reopened.getContentSize(), [Math.round(1280 * 2 / reopenedDensity), Math.round(720 * 2 / reopenedDensity)]);
    const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'));
    assert.equal(persisted.devices[0].startMode, 'options-enabled');
    assert.equal(persisted.devices[0].windowScale, 2);
    const invalid = { ...edited, devices: [{ ...edited.devices[0], origin: 'file:///etc' }] };
    assert.equal((await settings.webContents.executeJavaScript(`window.settings.save(${JSON.stringify(invalid)})`)).ok, false);
    assert.equal(reopened.isDestroyed(), false);
    const empty = { ...edited, devices: [] };
    assert.equal((await settings.webContents.executeJavaScript(`window.settings.save(${JSON.stringify(empty)})`)).ok, true);
    await waitFor(() => reopened.isDestroyed());
    assert.equal(settings.isDestroyed(), false);
    settings.focus();
    await waitFor(() => settings.isFocused());
    assert.ok(globalShortcut.isRegistered('CommandOrControl+W'));
    assert.ok(globalShortcut.isRegistered('CommandOrControl+Q'));
    const quitting = new Promise(resolve => app.once('will-quit', event => { event.preventDefault(); resolve(undefined); }));
    settings.webContents.setIgnoreMenuShortcuts(true);
    settings.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Q', modifiers: ['meta'] });
    await quitting;
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    assert.equal(globalShortcut.isRegistered('CommandOrControl+Q'), false);
    console.log('PASS: local close and quit shortcuts, app startup, separate login and automatic clean reconnect, isolated settings bridge, integrated options without reload or window replacement, restored bounds, local connection shortcuts, saved settings, live mode/name changes, rejected invalid save, connection removal');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { server.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
