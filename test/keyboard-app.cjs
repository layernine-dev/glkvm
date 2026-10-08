require('./runtime.cjs');
const { app, BrowserWindow, Menu, clipboard, ipcMain } = require('electron');
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
  // Saved before audio switching could be paused: the shortcut gets its default.
  delete (/** @type {Partial<import('../src/keyboard.cjs').KeyboardSettings>} */ (config.keyboard)).pauseAudioSwitching;
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(config));
  await app.whenReady();
  const originalRead = clipboard.readText;
  clipboard.readText = async () => 'Notes test\nÄÖÜ';
  require('../src/main.cjs');
  let streaming = false;
  ipcMain.on('glkvm:stream-state', (_event, value) => { streaming = value; });
  let recordingReported = false;
  ipcMain.on('glkvm:settings-recording', (_event, value) => { recordingReported = value; });
  const pauseItem = () => Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []).find(item => item.label.startsWith('Pause Audio Switching'));
  const paused = () => !!pauseItem()?.checked;
  /** Physical ⇧⌘A with optional auto-repeat, sent as separate modifier and key events.
   * @param {Electron.BrowserWindow} target @param {number} [repeats] */
  function pressPause(target, repeats = 0) {
    /** @param {'keyDown' | 'keyUp'} type @param {string} keyCode @param {Electron.KeyboardInputEvent['modifiers']} modifiers */
    const send = (type, keyCode, modifiers) => target.webContents.sendInputEvent({ type, keyCode, modifiers });
    send('keyDown', 'Meta', ['meta']); send('keyDown', 'Shift', ['meta', 'shift']);
    send('keyDown', 'A', ['meta', 'shift']);
    for (let i = 0; i < repeats; i++) send('keyDown', 'A', ['meta', 'shift', 'isautorepeat']);
    send('keyUp', 'A', ['meta', 'shift']); send('keyUp', 'Shift', ['meta']); send('keyUp', 'Meta', []);
  }
  /** @param {boolean} expected @param {string} message */
  async function expectPaused(expected, message) {
    await waitFor(() => paused() === expected);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(paused(), expected, message);
  }
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
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [], 'Command alone never becomes a remote Windows-key tap, including when macOS consumes the shortcut key');
    for (const keyCode of ['Shift', 'Control', 'Alt']) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Meta', modifiers: ['meta'] });
      const modifier = /** @type {'shift' | 'control' | 'alt'} */ (keyCode.toLowerCase());
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['meta', modifier] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['meta'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Meta' });
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [], 'Modifier transitions around a consumed macOS shortcut never flush Command');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Meta', modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Meta' });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [], 'Command+Tab forwards neither Command nor Tab');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Meta', modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift', modifiers: ['meta', 'shift'] });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['meta', 'shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['meta', 'shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift', modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Meta' });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [], 'The local Center shortcut never becomes a remote Command tap');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Meta', modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift', modifiers: ['meta', 'shift'] });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'H', modifiers: ['meta', 'shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'H', modifiers: ['meta', 'shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift', modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Meta' });
    press('H', []);
    await waitFor(() => win.webContents.executeJavaScript('window.keyLog.length >= 2'));
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [['keydown', 'KeyH'], ['keyup', 'KeyH']], 'A release dropped by the native shortcut handler never swallows the next plain key');
    await win.webContents.executeJavaScript("window.keyLog = []; window.mouseReleases = 0; document.querySelector('#video-wrapper').dispatchEvent(new MouseEvent('mousedown', {button:0,bubbles:true})); document.body.dispatchEvent(new MouseEvent('mouseup', {button:0,bubbles:true}));");
    assert.equal(await win.webContents.executeJavaScript('window.mouseReleases'), 1, 'A drag ending outside the player releases the remote mouse button');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift', modifiers: ['shift'] });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [], 'An outside release clears the drag state, so shortcut modifiers remain pending');
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
    await waitFor(() => win.webContents.executeJavaScript('window.keyLog.length === 2'));
    await win.webContents.executeJavaScript('window.keyLog = []');
    await win.webContents.executeJavaScript("document.querySelector('#stream-box').dispatchEvent(new KeyboardEvent('keydown', {key:'v',code:'KeyV',metaKey:true,bubbles:true}));");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(pastes.length, 1, 'Page-generated events cannot read the local clipboard');
    // Pausing audio switching: one toggle per press, nothing reaches the remote computer.
    assert.equal(pauseItem()?.label, 'Pause Audio Switching (⇧⌘A)', 'Older settings gain the default shortcut');
    assert.equal(paused(), false);
    await win.webContents.executeJavaScript('window.keyLog = []');
    pressPause(win, 3);
    await expectPaused(true, 'Auto-repeat does not toggle again');
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [], 'No modifier or key of the shortcut is forwarded');
    pressPause(win);
    await expectPaused(false, 'A second press resumes');
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), []);
    press('A', ['meta']);
    await waitFor(() => win.webContents.executeJavaScript('window.keyLog.length === 4'));
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [['keydown', 'MetaLeft'], ['keydown', 'KeyA'], ['keyup', 'KeyA'], ['keyup', 'MetaLeft']], 'Select All without Shift stays a remote chord');
    assert.equal(paused(), false);
    await win.webContents.executeJavaScript('window.keyLog = []');
    // A local Toolbox text field must retain normal keys, even with the stream live.
    await win.webContents.executeJavaScript("const input = document.createElement('textarea'); input.id = 'local-input'; document.body.append(input); input.focus(); window.keyLog = [];");
    await new Promise(resolve => setTimeout(resolve, 150));
    press('=', ['meta']); press('Backspace', ['meta', 'alt']); press('V', ['meta']);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(pastes.length, 1);
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), []);
    await win.webContents.executeJavaScript("window.fieldKeys = []; document.querySelector('#local-input').addEventListener('keydown', event => window.fieldKeys.push(event.code))");
    pressPause(win);
    await expectPaused(true, 'The shortcut works while a local field has focus');
    assert.deepEqual(await win.webContents.executeJavaScript('window.fieldKeys.filter(code => code === "KeyA")'), [], 'The local field does not receive the shortcut key');
    // Modifiers released before the key: its auto-repeats stay consumed until the key is released.
    /** @param {'keyDown' | 'keyUp'} type @param {string} keyCode @param {Electron.KeyboardInputEvent['modifiers']} modifiers */
    const sendKey = (type, keyCode, modifiers) => win.webContents.sendInputEvent({ type, keyCode, modifiers });
    sendKey('keyDown', 'Meta', ['meta']); sendKey('keyDown', 'Shift', ['meta', 'shift']); sendKey('keyDown', 'A', ['meta', 'shift']);
    sendKey('keyUp', 'Shift', ['meta']); sendKey('keyUp', 'Meta', []);
    for (let i = 0; i < 3; i++) sendKey('keyDown', 'A', ['isautorepeat']);
    sendKey('keyUp', 'A', []);
    await expectPaused(false, 'One toggle for the press');
    assert.deepEqual(await win.webContents.executeJavaScript("[window.fieldKeys.filter(code => code === 'KeyA'), document.querySelector('#local-input').value]"), [[], ''], 'Auto-repeats after releasing the modifiers do not reach the local field');
    press('A', []);
    await waitFor(() => win.webContents.executeJavaScript("window.fieldKeys.includes('KeyA')"));
    pressPause(win);
    await expectPaused(true, 'The next shortcut press toggles again');
    assert.deepEqual(await win.webContents.executeJavaScript("window.fieldKeys.filter(code => code === 'KeyA')"), ['KeyA'], 'Only the plain press reaches the local field');
    // The key stays consumed when focus moves between a local field and the player before it is released.
    for (const [from, to] of [['#local-input', '#stream-box'], ['#stream-box', '#local-input']]) {
      const wasPaused = paused();
      await win.webContents.executeJavaScript(`document.querySelector('#local-input').value = ''; window.fieldKeys = []; document.querySelector('${from}').focus(); window.keyLog = []`);
      await new Promise(resolve => setTimeout(resolve, 150));
      sendKey('keyDown', 'Meta', ['meta']); sendKey('keyDown', 'Shift', ['meta', 'shift']); sendKey('keyDown', 'A', ['meta', 'shift']);
      sendKey('keyUp', 'Shift', ['meta']); sendKey('keyUp', 'Meta', []);
      await expectPaused(!wasPaused, `The shortcut toggles once from ${from}`);
      await win.webContents.executeJavaScript(`document.querySelector('${to}').focus()`);
      await new Promise(resolve => setTimeout(resolve, 150));
      for (let i = 0; i < 3; i++) sendKey('keyDown', 'A', ['isautorepeat']);
      sendKey('keyUp', 'A', []);
      await expectPaused(!wasPaused, `Auto-repeats after moving focus from ${from} to ${to} do not toggle again`);
      assert.deepEqual(await win.webContents.executeJavaScript("[window.keyLog.filter(entry => entry[1] === 'KeyA'), window.fieldKeys.filter(code => code === 'KeyA'), document.querySelector('#local-input').value]"), [[], [], ''], `Auto-repeats and the release after moving focus from ${from} to ${to} reach neither the remote computer nor the local field`);
      press('A', []);
      if (to === '#stream-box') {
        await waitFor(() => win.webContents.executeJavaScript('window.keyLog.length >= 2'));
        assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [['keydown', 'KeyA'], ['keyup', 'KeyA']], 'The next plain press reaches the remote computer');
      } else {
        await waitFor(() => win.webContents.executeJavaScript("window.fieldKeys.includes('KeyA')"));
        assert.deepEqual(await win.webContents.executeJavaScript("[window.fieldKeys.filter(code => code === 'KeyA'), window.keyLog]"), [['KeyA'], []], 'The next plain press reaches only the local field');
      }
    }
    assert.equal(paused(), true, 'Both transitions toggled exactly once each');
    await win.webContents.executeJavaScript("document.querySelector('#local-input').value = ''");
    // Shortcut modifiers released in a local field are not replayed to the remote computer later.
    await win.webContents.executeJavaScript("document.querySelector('#stream-box').focus(); window.keyLog = []");
    sendKey('keyDown', 'Meta', ['meta']); sendKey('keyDown', 'Shift', ['meta', 'shift']); sendKey('keyDown', 'A', ['meta', 'shift']); sendKey('keyUp', 'A', ['meta', 'shift']);
    await expectPaused(false, 'The shortcut resumes from the player');
    await win.webContents.executeJavaScript("document.querySelector('#local-input').focus()");
    sendKey('keyUp', 'Shift', ['meta']); sendKey('keyUp', 'Meta', []);
    await new Promise(resolve => setTimeout(resolve, 150));
    await win.webContents.executeJavaScript("document.querySelector('#stream-box').focus()");
    press('B', []);
    await waitFor(() => win.webContents.executeJavaScript('window.keyLog.length >= 2'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), [['keydown', 'KeyB'], ['keyup', 'KeyB']], 'No stale shortcut modifier reaches the remote computer');
    // Move mode and view-only input gates still toggle the pause, with the stream live.
    /** @param {string} label */
    const menuItem = label => Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []).find(item => item.label === label);
    /** @param {string} label */
    const command = label => menuItem(label)?.click();
    command('Device Settings…');
    await waitFor(() => win.webContents.executeJavaScript("!document.documentElement.hasAttribute('data-glkvm-options')"));
    command('Move Window Mode');
    await waitFor(() => menuItem('Move Window Mode')?.checked);
    await win.webContents.executeJavaScript("document.querySelector('#stream-box').focus(); window.keyLog = []");
    pressPause(win);
    await expectPaused(true, 'Move mode pauses audio switching');
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), []);
    command('Move Window Mode');
    await waitFor(() => !menuItem('Move Window Mode')?.checked);
    // Settings: the shortcut works there, except while its recorder takes the next key.
    command('Settings…');
    await waitFor(() => BrowserWindow.getAllWindows().some(w => w.getTitle() === 'GLKVM Clean Settings'));
    const settings = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'GLKVM Clean Settings'); assert.ok(settings);
    await waitFor(() => !settings.webContents.isLoading() && settings.webContents.executeJavaScript("document.querySelectorAll('#keyboard-bindings button').length === 8"));
    settings.focus(); await waitFor(() => settings.isFocused());
    pressPause(settings);
    await expectPaused(false, 'The shortcut works in Settings');
    await settings.webContents.executeJavaScript("document.querySelector('#keyboard-tab').click(); const record = document.querySelector('[aria-label^=\"Pause audio switching shortcut\"]'); record.focus(); record.click();");
    await waitFor(() => recordingReported);
    pressPause(settings);
    await waitFor(() => !recordingReported);
    await expectPaused(false, 'Recording takes the shortcut instead of toggling');
    assert.equal(await settings.webContents.executeJavaScript("document.querySelector('[aria-label^=\"Pause audio switching shortcut\"]').textContent"), '⇧⌘A');
    await settings.webContents.executeJavaScript("document.querySelector('#settings-form').requestSubmit()");
    await waitFor(() => settings.webContents.executeJavaScript("document.querySelector('#save-status').textContent === 'Changes saved'"));
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8')).keyboard;
    assert.deepEqual([saved.insert, saved.pauseAudioSwitching.code, saved.pauseAudioSwitching.label], [defaults().keyboard?.insert, 'KeyA', '⇧⌘A'], 'Saving keeps prior bindings and stores the new one');
    pressPause(settings);
    await expectPaused(true, 'The shortcut works again after recording');
    // Modifiers released before the key: its auto-repeats stay consumed until the key is released.
    await settings.webContents.executeJavaScript("const field = document.createElement('input'); field.id = 'repeat-field'; document.body.append(field); window.fieldKeys = []; field.addEventListener('keydown', event => window.fieldKeys.push(event.code)); field.focus()");
    /** @param {'keyDown' | 'keyUp'} type @param {string} keyCode @param {Electron.KeyboardInputEvent['modifiers']} modifiers */
    const sendSettingsKey = (type, keyCode, modifiers) => settings.webContents.sendInputEvent({ type, keyCode, modifiers });
    sendSettingsKey('keyDown', 'Meta', ['meta']); sendSettingsKey('keyDown', 'Shift', ['meta', 'shift']); sendSettingsKey('keyDown', 'A', ['meta', 'shift']);
    sendSettingsKey('keyUp', 'Shift', ['meta']); sendSettingsKey('keyUp', 'Meta', []);
    for (let i = 0; i < 3; i++) sendSettingsKey('keyDown', 'A', ['isautorepeat']);
    sendSettingsKey('keyUp', 'A', []);
    await expectPaused(false, 'One toggle for the press');
    assert.deepEqual(await settings.webContents.executeJavaScript("[window.fieldKeys.filter(code => code === 'KeyA'), document.querySelector('#repeat-field').value]"), [[], ''], 'Auto-repeats after releasing the modifiers do not type into Settings');
    await settings.webContents.executeJavaScript("document.querySelector('#repeat-field').remove()");
    pressPause(settings);
    await expectPaused(true, 'The next press toggles again');
    /** Saves from Settings, then focuses the viewer: Move Window Mode is only checked there.
     * @param {boolean} enabled */
    async function saveControl(enabled) {
      // The change event shows 'Unsaved changes', so only this save can report 'Changes saved'.
      await settings?.webContents.executeJavaScript(`document.querySelector('#control-enabled').checked = ${enabled}; document.querySelector('#control-enabled').dispatchEvent(new Event('change')); document.querySelector('#settings-form').requestSubmit()`);
      await waitFor(() => settings?.webContents.executeJavaScript("document.querySelector('#save-status').textContent === 'Changes saved'"));
      app.focus({ steal: true }); win?.focus(); await waitFor(() => win?.isFocused());
      await waitFor(() => menuItem('Move Window Mode')?.checked === !enabled);
    }
    await saveControl(false);
    await win.webContents.executeJavaScript("document.querySelector('#stream-box').focus(); window.keyLog = []");
    pressPause(win);
    await expectPaused(false, 'View-only resumes audio switching');
    assert.deepEqual(await win.webContents.executeJavaScript('window.keyLog'), []);
    await saveControl(true);
    // Losing the stream in options mode must disable actions as well.
    command('Device Settings…');
    await waitFor(() => win.webContents.executeJavaScript("document.documentElement.hasAttribute('data-glkvm-options')"));
    await win.webContents.executeJavaScript("document.querySelector('#stream-box').focus(); window.disconnect();");
    await new Promise(resolve => setTimeout(resolve, 1200));
    press('V', ['meta']);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(pastes.length, 1);
    console.log('PASS: no remote Command tap, Command+Tab or Center shortcut keys, modifier-only transitions, ordinary remote chords, options-enabled startup, Insert, Ctrl+Alt+Delete, text paste, local-field isolation, disconnected stream gate, pause audio switching shortcut (migrated default, one toggle per press, no remote keys, local field, no stale modifiers after a local-field release, live move mode and view-only, Settings and its recorder)');
    clipboard.readText = originalRead; server.close(); app.exit(0);
  } catch (error) { console.error(error); const failedWindow = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Keyboard Fixture'); if (failedWindow) console.error('Keyboard fixture state:', failedWindow.isFocused(), await failedWindow.webContents.executeJavaScript('({active:document.activeElement.id,log:window.keyLog})')); clipboard.readText = originalRead; server.close(); app.exit(1); }
});
