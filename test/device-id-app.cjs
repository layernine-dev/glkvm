require('./runtime.cjs');
const { app, BrowserWindow, ipcMain, session, systemPreferences } = require('electron');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaults, partitionFor } = require('../src/config.cjs');
const fakeCatalog = require('./fake-catalog.cjs');
const { browserDeviceId, readDeviceIdSalt, supportedRuntime } = require('../src/device-ids.cjs');

// Native UID -> per-connection deviceId, proven against each page's enumerateDevices()
// with Chromium's fake devices. No microphone is enabled and nothing is captured.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-ids-'));
const evidence = process.env.GLKVM_AUDIO_EVIDENCE;
app.setPath('userData', directory);
const page = (/** @type {import('node:http').IncomingMessage} */ _req, /** @type {import('node:http').ServerResponse} */ res) => {
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8').replace('<script>', '<script>localStorage.setItem("fixture-auth", "true");'));
};
const server = createServer(page);
const moved = createServer(page);
/** @param {() => unknown | Promise<unknown>} condition @param {string} label @param {number} [tries] */
async function waitFor(condition, label, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
/** @type {Map<number, import('../src/audio.cjs').AudioStatus>} */
const statuses = new Map();
/** @type {Map<number, {kind: string, deviceId: string, label: string}[]>} */
const reports = new Map();
ipcMain.on('glkvm:audio-status', (event, status) => statuses.set(event.sender.id, status));
ipcMain.on('glkvm:audio-devices', (event, list) => reports.set(event.sender.id, list));
/** @type {string[]} */
const log = [];
const note = (/** @type {string} */ line) => { log.push(line); console.log(line); };

const listen = (/** @type {import('node:http').Server} */ target) => new Promise(resolve => target.listen(0, '127.0.0.1', () => resolve(/** @type {import('node:net').AddressInfo} */ (target.address()).port)));
void (async () => {
  const port = await listen(server);
  const movedPort = await listen(moved);
  const config = defaults();
  config.muted = false;
  const origins = { a: `http://127.0.0.1:${port}`, b: `http://localhost:${port}` };
  config.devices = [
    { id: 'alpha', name: 'Alpha', origin: origins.a, openAtStartup: false },
    { id: 'beta', name: 'Beta', origin: origins.b, openAtStartup: false },
  ];
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(config));
  const duplicate = fakeCatalog.device('AppleUSBAudioEngine:Dup:Fake:0001:1', 'Fake Audio Input 1', { input: true, output: false, transport: 'USB' });
  const offline = fakeCatalog.device('Offline-Speaker-UID', 'Desk Speaker', { input: false, output: true, alive: false });
  fakeCatalog.setDevices([...fakeCatalog.fakeDevices(), duplicate, offline]);
  const access = systemPreferences.getMediaAccessStatus('microphone');
  await app.whenReady();
  // Media permission requests from the connections (none are expected).
  /** @type {string[]} */
  const requests = [];
  require('../src/main.cjs');
  try {
    assert.ok(supportedRuntime(process.versions), `Mapping verified for Electron 44.5.1 / Chromium 152.0.7977.130, running ${process.versions.electron} / ${process.versions.chrome}`);

    // 1. Settings with zero connection windows lists every catalog device; the microphone stays disabled.
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'GLKVM Clean Settings'), 'settings at startup');
    const settings = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'GLKVM Clean Settings'));
    const run = (/** @type {Electron.BrowserWindow} */ win, /** @type {string} */ script) => win.webContents.executeJavaScript(script);
    await waitFor(() => !settings.webContents.isLoading() && run(settings, "document.querySelectorAll('.audio-foreground-output option').length > 1"), 'settings device list');
    assert.deepEqual(BrowserWindow.getAllWindows().map(win => win.getTitle()), ['GLKVM Clean Settings'], 'No connection window is open');
    const options = (/** @type {string} */ selector) => run(settings, `[...document.querySelectorAll(${JSON.stringify(selector)})].map(select => [...select.options].map(option => [option.value, option.textContent]))`);
    const inputs = await options('.audio-foreground-input');
    assert.equal(inputs.length, 2, 'One focused microphone list per connection');
    assert.deepEqual(inputs[0], [['disabled', 'Microphone disabled'], ['default', 'System default'],
      ['uid:fake_audio_input_1', 'Fake Audio Input 1 (Virtual, …nput_1)'], ['uid:fake_audio_input_2', 'Fake Audio Input 2'],
      [`uid:${duplicate.uid}`, 'Fake Audio Input 1 (USB, …0001:1)']], 'All inputs, duplicates disambiguated');
    assert.deepEqual((await options('.audio-background-output'))[1], [['default', 'System default'],
      ['uid:fake_audio_output_1', 'Fake Audio Output 1'], ['uid:fake_audio_output_2', 'Fake Audio Output 2'], [`uid:${offline.uid}`, 'Desk Speaker — not available']], 'All outputs, offline marked');
    assert.deepEqual(await run(settings, "[...document.querySelectorAll('.audio-foreground-input, .audio-background-input')].map(select => select.value)"), ['disabled', 'disabled', 'disabled', 'disabled']);
    assert.equal(session.fromPartition(partitionFor(config.devices[0])).getStoragePath() && readDeviceIdSalt(/** @type {string} */ (session.fromPartition(partitionFor(config.devices[0])).getStoragePath())), null, 'Listing created no connection salt');
    note(`settings without connections: ${inputs[0].length - 2} inputs, ${(await options('.audio-background-output'))[1].length - 1} outputs`);

    // Hotplug: the open list follows the catalog.
    fakeCatalog.setDevices([...fakeCatalog.fakeDevices(), duplicate, offline, fakeCatalog.device('Hotplug-Mic-UID', 'Hotplugged Mic', { input: true, output: false })]);
    await waitFor(async () => (await options('.audio-foreground-input'))[1].some((/** @type {string[]} */ [value]) => value === 'uid:Hotplug-Mic-UID'), 'hotplugged device listed');
    fakeCatalog.setDevices([...fakeCatalog.fakeDevices(), duplicate, offline]);
    await waitFor(async () => !(await options('.audio-foreground-input'))[1].some((/** @type {string[]} */ [value]) => value === 'uid:Hotplug-Mic-UID'), 'unplugged device removed');

    // A catalog change while a dropdown is focused waits until focus leaves the group, then
    // updates all four lists; the unsaved choice survives, even for a removed device.
    const hotSpeaker = fakeCatalog.device('Hotplug-Speaker-UID', 'Hotplug Speaker', { input: false, output: true });
    fakeCatalog.setDevices([...fakeCatalog.fakeDevices(), duplicate, offline, hotSpeaker]);
    await waitFor(async () => (await options('.audio-foreground-output'))[0].some((/** @type {string[]} */ [value]) => value === `uid:${hotSpeaker.uid}`), 'hotplugged speaker listed');
    settings.focus(); await waitFor(() => settings.isFocused(), 'settings focused');
    await run(settings, `(() => { const select = document.querySelector('.audio-foreground-output'); window.focusedSelect = select; select.focus(); select.value = 'uid:${hotSpeaker.uid}'; select.dispatchEvent(new Event('change')); })()`);
    const lateMic = fakeCatalog.device('Late-Mic-UID', 'Late Mic', { input: true, output: false });
    fakeCatalog.setDevices([...fakeCatalog.fakeDevices(), duplicate, offline, lateMic]);
    await waitFor(async () => (await options('.audio-foreground-input'))[1].some((/** @type {string[]} */ [value]) => value === 'uid:Late-Mic-UID'), 'unfocused connection updated');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(await run(settings, "[document.activeElement === window.focusedSelect, window.focusedSelect.isConnected, window.focusedSelect.value]"), [true, true, `uid:${hotSpeaker.uid}`], 'The focused dropdown is not rebuilt');
    await run(settings, "document.querySelector('#name-0').focus()");
    const group = (/** @type {number} */ index) => run(settings, `[...document.querySelectorAll('.audio')[${index}].querySelectorAll('select')].map(select => [select.className, select.value, [...select.options].map(option => option.value + '=' + option.textContent)])`);
    await waitFor(async () => (await group(0)).every((/** @type {[string, string, string[]]} */ [name, , values]) => name.endsWith('-input') ? values.includes('uid:Late-Mic-UID=Late Mic') : !values.includes(`uid:${hotSpeaker.uid}=Hotplug Speaker`)), 'deferred refresh applied after focus left');
    for (const index of [0, 1]) {
      for (const [name, value, values] of await group(index)) {
        assert.equal(values.includes('uid:Late-Mic-UID=Late Mic'), name.endsWith('-input'), `${index} ${name} lists the current inputs`);
        assert.equal(values.includes('uid:fake_audio_output_2=Fake Audio Output 2'), name.endsWith('-output'), `${index} ${name} lists the current outputs`);
        if (index === 0 && name === 'audio-foreground-output') {
          assert.equal(value, `uid:${hotSpeaker.uid}`, 'The unsaved choice is kept');
          assert.ok(values.includes(`uid:${hotSpeaker.uid}=Hotplug Speaker — not available`), 'The removed device is retained as unavailable');
        } else assert.equal(value, name.endsWith('-input') ? 'disabled' : 'default', `${index} ${name} keeps its value`);
      }
    }
    assert.equal(await run(settings, "document.querySelector('#save-status').textContent"), 'Unsaved changes');
    note('focused dropdown: catalog change deferred until focus left, then all four lists current with the unsaved removed device retained');
    fakeCatalog.setDevices([...fakeCatalog.fakeDevices(), duplicate, offline]);
    await waitFor(async () => !(await options('.audio-foreground-input'))[0].some((/** @type {string[]} */ [value]) => value === 'uid:Late-Mic-UID'), 'late microphone removed');

    // 2. Choose the same native speaker for both connections in the UI, then save.
    await run(settings, `(() => {
      for (const select of document.querySelectorAll('.audio-foreground-output, .audio-background-output')) { select.value = 'uid:fake_audio_output_2'; select.dispatchEvent(new Event('change')); }
      document.querySelector('#settings-form').requestSubmit();
    })()`);
    await waitFor(() => run(settings, "document.querySelector('#save-status').textContent === 'Changes saved'"), 'saved choices');
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'));
    assert.deepEqual(saved.devices.map((/** @type {any} */ device) => device.audio), [0, 1].map(() => ({ foreground: { input: 'disabled', output: { uid: 'fake_audio_output_2', label: 'Fake Audio Output 2' } }, background: { input: 'disabled', output: { uid: 'fake_audio_output_2', label: 'Fake Audio Output 2' } }, startup: { speaker: false, microphone: false } })), 'Saved by native UID');

    // 3. Open both: each fresh session creates and persists its own salt.
    const opened = Date.now();
    await run(settings, "window.settings.open('alpha')"); await run(settings, "window.settings.open('beta')");
    await waitFor(() => ['Alpha', 'Beta'].every(title => BrowserWindow.getAllWindows().some(win => win.getTitle() === title)), 'connection windows');
    const alpha = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Alpha'));
    const beta = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Beta'));
    for (const win of [alpha, beta]) {
      win.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => { requests.push(permission); callback(false); });
    }
    const storage = (/** @type {Electron.BrowserWindow} */ win) => /** @type {string} */ (win.webContents.session.getStoragePath());
    const status = (/** @type {Electron.BrowserWindow} */ win) => statuses.get(win.webContents.id);
    /** @type {string[]} */
    const leaks = [];
    const watchLeaks = setInterval(() => {
      for (const win of [alpha, beta]) {
        const current = status(win);
        if (current && current.output === '') leaks.push(`${win.getTitle()} sent the system default`);
        if (!win.isDestroyed() && !win.webContents.isAudioMuted() && current?.outputState !== 'ok') leaks.push(`${win.getTitle()} audible while ${current?.outputState}`);
      }
    }, 5);
    for (const win of [alpha, beta]) {
      await waitFor(() => readDeviceIdSalt(storage(win)), 'persisted salt', 250);
      note(`${win.getTitle()}: salt persisted ${Date.now() - opened} ms after opening (JsonPrefStore commit interval is 10 s)`);
    }
    assert.equal(await run(alpha, "typeof window.settings"), 'undefined');
    const proven = async (/** @type {Electron.BrowserWindow} */ win, /** @type {string} */ origin) => {
      await waitFor(() => status(win)?.outputState === 'ok' && !win.webContents.isAudioMuted(), `${win.getTitle()} routed`, 100);
      const salt = /** @type {string} */ (readDeviceIdSalt(storage(win)));
      const listed = /** @type {{kind: string, deviceId: string, label: string}[]} */ (reports.get(win.webContents.id));
      // Every fake raw ID maps to exactly the ID this page enumerates for that device.
      for (const [uid, label] of [['fake_audio_output_1', 'Fake Audio Output 1'], ['fake_audio_output_2', 'Fake Audio Output 2']]) {
        assert.equal(listed.find(device => device.label === label)?.deviceId, browserDeviceId(origin, uid, salt), `${win.getTitle()}: ${uid}`);
      }
      assert.equal(status(win)?.output, browserDeviceId(origin, 'fake_audio_output_2', salt));
      assert.deepEqual(await run(win, `navigator.mediaDevices.enumerateDevices().then(list => list.filter(device => device.kind === 'audioinput').map(device => device.deviceId))`), [''], 'Microphone IDs stay hidden while disabled');
      return /** @type {string} */ (status(win)?.output);
    };
    const alphaId = await proven(alpha, origins.a);
    const betaId = await proven(beta, origins.b);
    assert.notEqual(alphaId, betaId, 'The same native speaker has a different ID per connection');
    assert.notEqual(readDeviceIdSalt(storage(alpha)), readDeviceIdSalt(storage(beta)), 'Each partition has its own salt');
    note(`mapping proven: fake_audio_output_1/2 -> ${origins.a} and ${origins.b} enumerated IDs`);

    // 4. Rotation: clearing cookies replaces the salt; the old route is withdrawn and the
    // window stays muted until the new salt is persisted and proven.
    const oldSalt = readDeviceIdSalt(storage(alpha));
    const rotated = Date.now();
    await alpha.webContents.session.clearStorageData({ storages: ['cookies'] });
    await run(settings, 'window.settings.audio()');
    await waitFor(() => reports.get(alpha.webContents.id)?.every(device => device.deviceId !== alphaId), 'rotated page IDs');
    await waitFor(() => readDeviceIdSalt(storage(alpha)) !== oldSalt, 'rotated salt persisted', 250);
    const rotatedId = await proven(alpha, origins.a);
    assert.notEqual(rotatedId, alphaId);
    note(`salt rotation recovered after ${Date.now() - rotated} ms`);

    // 5. A missing native device is kept and silent; it never falls back.
    await run(settings, `window.settings.load().then(value => { value.devices[0].audio.foreground.output = { uid: ${JSON.stringify(offline.uid)}, label: 'Desk Speaker' }; value.devices[0].audio.background.output = value.devices[0].audio.foreground.output; return window.settings.save(value); })`);
    await waitFor(() => status(alpha)?.outputState === 'missing' && status(alpha)?.output === null && alpha.webContents.isAudioMuted(), 'missing native speaker muted');

    // 6. Legacy page device IDs migrate only when exactly the hash of a native device.
    const betaSalt = /** @type {string} */ (readDeviceIdSalt(storage(beta)));
    const legacy = { deviceId: browserDeviceId(origins.b, 'fake_audio_output_1', betaSalt), label: 'Old speaker' };
    const unknown = { deviceId: 'e'.repeat(64), label: 'Fake Audio Output 2' };
    await run(settings, `window.settings.load().then(value => { value.devices[1].audio.foreground.output = ${JSON.stringify(legacy)}; value.devices[1].audio.background.output = ${JSON.stringify(unknown)}; return window.settings.save(value); })`);
    const migrated = await run(settings, 'window.settings.load()');
    assert.deepEqual(migrated.devices[1].audio.foreground.output, { uid: 'fake_audio_output_1', label: 'Old speaker' }, 'Exact hash match migrates');
    assert.deepEqual(migrated.devices[1].audio.background.output, unknown, 'No label guessing: kept unresolved');
    beta.blur(); alpha.focus();
    await waitFor(() => !beta.isFocused() && status(beta)?.outputState === 'missing' && status(beta)?.output === null && beta.webContents.isAudioMuted(), 'unresolved legacy choice silent');

    // 7. Origin change: the native choice is kept and re-resolved in the new partition.
    clearInterval(watchLeaks);
    const movedOrigin = `http://127.0.0.1:${movedPort}`;
    await run(settings, `window.settings.load().then(value => { value.devices[1].origin = ${JSON.stringify(movedOrigin)}; value.devices[1].audio.background.output = { uid: 'fake_audio_output_2', label: 'Fake Audio Output 2' }; value.devices[1].audio.foreground.output = value.devices[1].audio.background.output; return window.settings.save(value); }).then(result => { if (result.ok) { config = result.config; render(); } return result; })`);
    await waitFor(() => beta.isDestroyed(), 'old connection closed');
    await run(settings, "window.settings.open('beta')");
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'Beta' && win.webContents.getURL().startsWith(movedOrigin)), 'moved connection');
    const movedWindow = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Beta'));
    movedWindow.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => { requests.push(permission); callback(false); });
    await waitFor(() => readDeviceIdSalt(storage(movedWindow)), 'moved partition salt', 250);
    assert.notEqual(await proven(movedWindow, movedOrigin), betaId, 'Re-resolved for the new origin');

    assert.deepEqual(leaks, [], 'Never routed to the system default and never audible while unresolved');
    assert.deepEqual(requests, [], 'No media permission was requested');
    assert.equal(systemPreferences.getMediaAccessStatus('microphone'), access, 'Microphone access status unchanged');
    if (evidence) {
      fs.writeFileSync(path.join(evidence, 'device-id-app.log'), `${log.join('\n')}\n`);
      fs.writeFileSync(path.join(evidence, 'settings-all-devices-fake.png'), (await settings.webContents.capturePage()).toPNG());
    }
    console.log('PASS: settings list all native devices with zero connection windows and disabled microphones, duplicate names disambiguated, offline marked, hotplug refresh, catalog change during a focused dropdown applied after focus leaves with the unsaved removed choice retained, saved by UID, fresh-session salt persistence, exact UID->deviceId mapping across two origins/partitions, salt rotation recovery, missing device retained and silent, legacy migration only on exact hash, origin change re-resolution, no default fallback, no permission requests');
    app.exit(0);
  } catch (error) {
    console.error(error); console.error('Statuses:', JSON.stringify([...statuses]));
    app.exit(1);
  } finally { server.close(); moved.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); }
})();
