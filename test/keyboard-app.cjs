const { app, BrowserWindow, clipboard } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { defaults } = require('../src/config.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-keyboard-'));
app.setPath('userData', directory);
/** @type {string[]} */
const pastes = [];
const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/hid/print')) {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => { pastes.push(text); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  } else {
    res.setHeader('content-type', 'text/html');
    res.end(fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8').replace('<script>', '<script>localStorage.setItem("fixture-auth", "true");'));
  }
});
/** @param {() => Promise<unknown> | unknown} check */
async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for keyboard test state.');
}
server.listen(0, '127.0.0.1', async () => {
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = defaults();
  config.devices = [{ id: 'keyboard', name: 'Keyboard Fixture', origin: `http://127.0.0.1:${address.port}`, openAtStartup: true, startMode: 'options-enabled' }];
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(config));
  await app.whenReady();
  const originalRead = clipboard.readText;
  clipboard.readText = async () => 'Notes test\nÄÖÜ';
  require('../src/main.cjs');
  let streaming = false;
  require('electron').ipcMain.on('glkvm:stream-state', (_event, value) => { streaming = value; });
  try {
    await waitFor(() => BrowserWindow.getAllWindows().some(w => w.getTitle() === 'Keyboard Fixture'));
    const win = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Keyboard Fixture'); assert.ok(win);
    await waitFor(() => !win.webContents.isLoading());
    await waitFor(() => win.webContents.executeJavaScript("document.querySelector('#stream-video')?.videoWidth > 0 && document.documentElement.hasAttribute('data-glkvm-options')"));
    await waitFor(() => streaming);
    app.focus({ steal: true }); win.focus();
    await waitFor(() => win.isFocused());
    await win.webContents.executeJavaScript("document.querySelector('#stream-box').focus(); window.keyLog = []");
    await new Promise(resolve => setTimeout(resolve, 150));
    /** @param {string} key @param {Electron.KeyboardInputEvent['modifiers']} modifiers */
    function press(key, modifiers) {
      if (modifiers?.includes('meta')) win?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Meta', modifiers: ['meta'] });
      if (modifiers?.includes('alt')) win?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Alt', modifiers });
      win?.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
      win?.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
      if (modifiers?.includes('alt')) win?.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Alt', modifiers: ['meta'] });
      if (modifiers?.includes('meta')) win?.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Meta' });
    }
    press('=', ['meta']);
    await waitFor(() => win.webContents.executeJavaScript("window.keyLog.some(e => e[1] === 'Insert')"));
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [['keydown', 'Insert'], ['keyup', 'Insert']]);
    await win.webContents.executeJavaScript('window.keyLog = []');
    press('Backspace', ['meta', 'alt']);
    await waitFor(() => win.webContents.executeJavaScript('window.keyLog.length === 6'));
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [['keydown', 'ControlLeft'], ['keydown', 'AltLeft'], ['keydown', 'Delete'], ['keyup', 'Delete'], ['keyup', 'AltLeft'], ['keyup', 'ControlLeft']]);
    await win.webContents.executeJavaScript('window.keyLog = []');
    press('V', ['meta']);
    await waitFor(() => pastes.length === 1);
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [], 'Paste must never forward the physical Command key');
    assert.equal(pastes[0], 'Notes test\nÄÖÜ');
    await win.webContents.executeJavaScript('window.keyLog = []');
    press('C', ['meta']);
    await waitFor(() => win.webContents.executeJavaScript('window.keyLog.length === 4'));
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [['keydown', 'MetaLeft'], ['keydown', 'KeyC'], ['keyup', 'KeyC'], ['keyup', 'MetaLeft']], 'Ordinary remote chords retain their modifiers');
    await win.webContents.executeJavaScript('window.keyLog = []');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Meta', modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Meta' });
    await waitFor(() => win.webContents.executeJavaScript('window.keyLog.length === 2'));
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [['keydown', 'MetaLeft'], ['keyup', 'MetaLeft']], 'An intentional Command tap is preserved');
    await win.webContents.executeJavaScript("document.querySelector('#stream-box').dispatchEvent(new KeyboardEvent('keydown', {key:'v',code:'KeyV',metaKey:true,bubbles:true}));");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(pastes.length, 1, 'Page-generated events cannot read the local clipboard');
    // A local Toolbox text field must retain normal keys, even with the stream live.
    await win.webContents.executeJavaScript("const input = document.createElement('textarea'); input.id = 'local-input'; document.body.append(input); input.focus(); window.keyLog = [];");
    await new Promise(resolve => setTimeout(resolve, 150));
    press('=', ['meta']); press('Backspace', ['meta', 'alt']); press('V', ['meta']);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(pastes.length, 1);
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), []);
    // Losing the stream in options mode must disable actions as well.
    await win.webContents.executeJavaScript("document.querySelector('#stream-box').focus(); window.disconnect();");
    await new Promise(resolve => setTimeout(resolve, 1200));
    press('V', ['meta']);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(pastes.length, 1);
    console.log('PASS: options-enabled startup, Insert, Ctrl+Alt+Delete, text paste, local-field isolation, disconnected stream gate');
    clipboard.readText = originalRead; server.close(); app.exit(0);
  } catch (error) { console.error(error); const failedWindow = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Keyboard Fixture'); if (failedWindow) console.error('Keyboard fixture state:', failedWindow.isFocused(), await failedWindow.webContents.executeJavaScript('({active:document.activeElement.id,log:window.keyLog})')); clipboard.readText = originalRead; server.close(); app.exit(1); }
});
