require('./runtime.cjs');
const { app, BrowserWindow, Menu, ipcMain, safeStorage } = require('electron');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaults } = require('../src/config.cjs');
const { prepareConfig } = require('../src/credentials.cjs');
const fakeCatalog = require('./fake-catalog.cjs');

// Chromium's fake capture and output devices: no microphone or speaker hardware is used.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-startup-audio-'));
app.setPath('userData', directory);

// Mirrors the firmware's Pinia stores (see /tmp/glkvm-startup-audio/evidence.md): kvm.configState.volumeOn
// and setVolumeOn, audioMic.state.micMuted and setMicMuted, usbManagement.enableMic and initLoading.
// Unmuting starts the microphone like the firmware's audio session; a failure re-mutes it.
// Nothing is played. Options come from localStorage 'fixture-firmware' and apply on load.
const firmwareScript = `<div id="app"></div><script>
(() => {
  const options = JSON.parse(localStorage.getItem('fixture-firmware') || '{}');
  window.firmwareCalls = []; window.micErrors = 0; window.mic = null; window.manualCall = false;
  window.startMic = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false } });
    const pc = new RTCPeerConnection();
    pc.addTrack(stream.getAudioTracks()[0], stream);
    window.mic = { stream, pc };
  };
  window.stopMic = () => { if (!window.mic) return; window.mic.stream.getTracks().forEach(track => track.stop()); window.mic.pc.close(); window.mic = null; };
  const usb = { enableMic: options.enableMic !== false, initLoading: options.initLoading === true };
  const kvm = { configState: { volumeOn: false, initVideoSessionFinished: false }, isDirectMode: options.direct === true,
    setVolumeOn(on) { window.firmwareCalls.push(['volume', on, window.manualCall ? 'manual' : 'auto']); kvm.configState.volumeOn = on; } };
  const audioMic = { state: { micMuted: true, micUnmuteByKeyPressing: false, micJanusConnected: false },
    setMicMuted(muted) {
      window.firmwareCalls.push(['mic', !muted, window.manualCall ? 'manual' : 'auto']);
      audioMic.state.micMuted = muted;
      if (muted) { window.stopMic(); return; }
      if (!usb.enableMic || kvm.isDirectMode) return;
      window.startMic().catch(() => { window.micErrors++; audioMic.state.micMuted = true; });
    } };
  window.firmware = { kvm, audioMic, usb };
  window.manual = action => { window.manualCall = true; try { action(window.firmware); } finally { window.manualCall = false; } };
  // Like the firmware, a new video session is unfinished until its first remote track.
  const connect = window.connect;
  window.connect = (...args) => { kvm.configState.initVideoSessionFinished = false; connect(...args); setTimeout(() => { kvm.configState.initVideoSessionFinished = true; }, 300); };
  window.connectDirect = () => {
    document.querySelector('#stream-video')?.remove();
    const canvas = document.createElement('canvas'); canvas.id = 'stream-canvas'; canvas.width = 640; canvas.height = 360;
    canvas.getContext('2d').fillRect(0, 0, 640, 360);
    document.querySelector('#stream-box').append(canvas);
    kvm.configState.initVideoSessionFinished = true;
  };
  // Audio transport restart only: the video session is unchanged.
  window.audioReconnect = async () => { if (window.mic) { window.stopMic(); await window.startMic(); } };
  window.mountStores = () => {
    document.querySelector('#app').__vue_app__ = { config: { globalProperties: { $pinia: { _s: new Map([['kvm', kvm], ['audioMic', audioMic], ['usbManagement', usb]]) } } } };
    if (options.direct && document.querySelector('#stream-video')) window.connectDirect();
    else if (document.querySelector('#stream-video')) setTimeout(() => { kvm.configState.initVideoSessionFinished = true; }, 300);
  };
  if (!options.manualStores) window.mountStores();
})();
</script></body>`;
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8').replace('</body>', firmwareScript));
});
/** @param {() => unknown | Promise<unknown>} condition @param {string} [label] @param {number} [tries] */
async function waitFor(condition, label = 'application state', tries = 150) {
  for (let i = 0; i < tries; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
const sleep = (/** @type {number} */ ms) => new Promise(resolve => setTimeout(resolve, ms));

/** @type {Map<number, import('../src/audio.cjs').AudioStatus>} */
const statuses = new Map();
/** @type {Map<number, import('../src/audio.cjs').StartupStatus>} */
const startups = new Map();
/** @type {Map<number, {kind: string, deviceId: string, label: string}[]>} */
const reports = new Map();
/** Window titles that received the private startup setting or reported a startup status. @type {string[]} */
const startupPeers = [];
const titleOf = (/** @type {Electron.WebContents} */ contents) => BrowserWindow.fromWebContents(contents)?.getTitle() || '';
ipcMain.on('glkvm:audio-status', (event, status) => statuses.set(event.sender.id, status));
ipcMain.on('glkvm:audio-devices', (event, list) => reports.set(event.sender.id, list));
ipcMain.on('glkvm:audio-startup-status', (event, status) => { startups.set(event.sender.id, status); startupPeers.push(titleOf(event.sender)); });
app.on('web-contents-created', (_event, contents) => {
  const send = contents.send;
  contents.send = (channel, ...args) => {
    if (channel === 'glkvm:audio-startup') startupPeers.push(titleOf(contents));
    return send.call(contents, channel, ...args);
  };
});

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const microphoneProfiles = { foreground: { input: 'default', output: 'default' }, background: { input: 'default', output: 'default' } };
  const config = defaults();
  // Globally muted throughout: nothing is audible even when device sound turns on.
  config.muted = true;
  config.devices = [
    { id: 'first', name: 'First', origin: `http://127.0.0.1:${address.port}`, openAtStartup: true, audio: { ...microphoneProfiles, startup: { speaker: false, microphone: false } } },
    { id: 'second', name: 'Second', origin: `http://localhost:${address.port}`, openAtStartup: true, audio: { ...microphoneProfiles, startup: { speaker: false, microphone: false } } },
  ];
  fakeCatalog.setDevices(fakeCatalog.fakeDevices());
  await app.whenReady();
  // Both connections sign in through the hidden login helper with the fixture password.
  const stored = await prepareConfig({ ...config, devices: config.devices.map(device => ({ ...device, password: 'fixture-secret' })) }, config, safeStorage);
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(stored));
  require('../src/main.cjs');
  try {
    await waitFor(() => ['First', 'Second'].every(title => BrowserWindow.getAllWindows().some(win => win.getTitle() === title)));
    const first = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'First'));
    const second = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Second'));
    /** @param {Electron.BrowserWindow} win @param {string} script */
    const run = (win, script) => win.webContents.executeJavaScript(script);
    const live = (/** @type {Electron.BrowserWindow} */ win) => run(win, "document.querySelector('#stream-video')?.videoWidth === 640 && !document.querySelector('#login')");
    const startup = (/** @type {Electron.BrowserWindow} */ win) => startups.get(win.webContents.id);
    const settled = (/** @type {Electron.BrowserWindow} */ win) => { const value = startup(win); return !!value && value.speakerState !== 'waiting' && value.microphoneState !== 'waiting'; };
    /** @param {Electron.BrowserWindow} win @returns {Promise<{volumeOn: boolean, micMuted: boolean, calls: [string, boolean, string][], micErrors: number}>} */
    const firmware = win => run(win, '({ volumeOn: window.firmware.kvm.configState.volumeOn, micMuted: window.firmware.audioMic.state.micMuted, calls: window.firmwareCalls, micErrors: window.micErrors })');
    const autoCalls = async (/** @type {Electron.BrowserWindow} */ win) => (await firmware(win)).calls.filter(call => call[2] === 'auto');
    /** @param {Electron.BrowserWindow} win @param {Record<string, unknown>} [options] */
    const reload = async (win, options = {}) => {
      await run(win, `localStorage.setItem('fixture-firmware', ${JSON.stringify(JSON.stringify(options))})`);
      startups.delete(win.webContents.id);
      win.webContents.reload();
      await waitFor(() => !win.webContents.isLoading() && live(win), 'reloaded live video');
    };
    const helpersGone = () => !BrowserWindow.getAllWindows().some(win => win.getTitle().endsWith('— Device Settings'));

    // Sign-in: the helper authenticates, the visible windows reload with live video.
    await waitFor(async () => await live(first) && await live(second) && helpersGone(), 'authenticated live video', 300);
    assert.equal(await run(first, 'typeof window.settings'), 'undefined', 'No bridge is exposed to the page');

    // Defaults (both off) match the firmware's own defaults: no setter is called.
    await waitFor(() => settled(first) && settled(second), 'default startup');
    for (const win of [first, second]) {
      assert.deepEqual(startup(win), { speaker: false, microphone: false, speakerState: 'unchanged', microphoneState: 'unchanged' });
      assert.deepEqual((await firmware(win)).calls, [], 'Already matching: idempotent');
    }

    // Safety gate before any automatic microphone start: only Chromium's fake devices.
    for (const win of [first, second]) {
      await waitFor(() => reports.get(win.webContents.id)?.some(device => device.kind === 'audioinput'), 'microphone names');
      const devices = /** @type {{kind: string, label: string}[]} */ (reports.get(win.webContents.id));
      if (!devices.every(device => /^Fake /.test(device.label))) throw new Error(`Refusing to test with real devices: ${devices.map(device => device.label).join(', ')}`);
    }

    Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []).find(item => item.label === 'Settings…')?.click();
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'GLKVM Clean Settings'));
    const settings = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'GLKVM Clean Settings'));
    await waitFor(() => !settings.webContents.isLoading() && run(settings, "document.querySelector('.audio-startup-microphone') !== null"));
    /** @param {(value: any) => void} edit */
    const save = async edit => {
      const value = await run(settings, 'window.settings.load()');
      edit(value);
      const result = await run(settings, `window.settings.save(${JSON.stringify(value)}).then(result => { if (result.ok) { config = result.config; render(); } return result; })`);
      assert.equal(result.ok, true, result.error);
    };
    /** @param {{speaker: boolean, microphone: boolean}} a @param {{speaker: boolean, microphone: boolean}} b */
    const setStartup = (a, b) => save(value => { value.devices[0].audio.startup = a; value.devices[1].audio.startup = b; });

    // The switches are saved through the Settings form.
    await run(settings, "document.querySelectorAll('.audio-startup-speaker')[0].click(); document.querySelector('#settings-form').requestSubmit()");
    await waitFor(async () => (await run(settings, "document.querySelector('#save-status').textContent")) === 'Changes saved', 'switch saved');
    assert.deepEqual((await run(settings, 'window.settings.load()')).devices.map((/** @type {any} */ device) => device.audio.startup), [{ speaker: true, microphone: false }, { speaker: false, microphone: false }]);

    // Round 1: (sound on, microphone off) and (sound off, microphone on). Saving changes nothing now.
    await setStartup({ speaker: true, microphone: false }, { speaker: false, microphone: true });
    await sleep(1500);
    assert.deepEqual([(await firmware(first)).calls, (await firmware(second)).calls], [[], []], 'Saving does not change the running session');
    assert.equal(statuses.get(second.webContents.id)?.input, 'idle', 'No microphone starts on save');
    await reload(first); await reload(second);
    await waitFor(() => settled(first) && settled(second), 'round 1 applied');
    assert.deepEqual(startup(first), { speaker: true, microphone: false, speakerState: 'applied', microphoneState: 'unchanged' });
    assert.deepEqual(await autoCalls(first), [['volume', true, 'auto']]);
    assert.equal((await firmware(first)).micMuted, true);
    assert.deepEqual(startup(second), { speaker: false, microphone: true, speakerState: 'unchanged', microphoneState: 'applied' });
    assert.deepEqual(await autoCalls(second), [['mic', true, 'auto']]);
    await waitFor(() => statuses.get(second.webContents.id)?.input === 'live', 'second microphone live');
    assert.equal((await firmware(second)).volumeOn, false);
    assert.equal(first.webContents.isAudioMuted(), true, 'Global mute still applies');
    assert.equal(statuses.get(first.webContents.id)?.outputState, 'ok', 'Speaker routing is unchanged');

    // Round 2: (both on) and (both off).
    await setStartup({ speaker: true, microphone: true }, { speaker: false, microphone: false });
    await reload(first); await reload(second);
    await waitFor(() => settled(first) && settled(second), 'round 2 applied');
    assert.deepEqual(startup(first), { speaker: true, microphone: true, speakerState: 'applied', microphoneState: 'applied' });
    await waitFor(() => statuses.get(first.webContents.id)?.input === 'live', 'first microphone live');
    assert.deepEqual(startup(second), { speaker: false, microphone: false, speakerState: 'unchanged', microphoneState: 'unchanged' });
    assert.deepEqual((await firmware(second)).calls, []);
    assert.equal(statuses.get(second.webContents.id)?.input, 'idle');

    // Once per session: manual changes survive focus, routes, saves and audio-only reconnects.
    const applied = (await autoCalls(first)).length;
    await run(first, 'window.manual(({ kvm }) => kvm.setVolumeOn(false))');
    settings.focus(); await waitFor(() => settings.isFocused());
    first.focus(); await waitFor(() => first.isFocused());
    await save(value => { value.devices[0].audio.background.output = { uid: 'fake_audio_output_2', label: 'Fake Audio Output 2' }; });
    settings.focus(); await waitFor(() => statuses.get(first.webContents.id)?.outputState === 'ok', 'background speaker routed');
    await run(first, 'window.audioReconnect()');
    await run(first, "(async () => { const video = document.querySelector('#stream-video'); video.pause(); await new Promise(r => setTimeout(r, 300)); await video.play(); })()");
    await sleep(2000);
    assert.equal((await autoCalls(first)).length, applied, 'No startup again within the session');
    assert.deepEqual([(await firmware(first)).volumeOn, (await firmware(first)).micMuted], [false, false], 'Manual sound off and the microphone stay as they are');

    // A new video session (reconnect) applies the startup setting again.
    await run(first, 'window.connect()');
    await waitFor(async () => (await firmware(first)).volumeOn, 'reapplied after a new video session');
    assert.deepEqual((await autoCalls(first)).slice(applied), [['volume', true, 'auto']], 'The microphone already matched');

    // Replacing the video transport rapidly applies at most once per session, without a loop.
    await run(first, 'window.manual(({ kvm }) => kvm.setVolumeOn(false))');
    const beforeBurst = (await autoCalls(first)).length;
    await run(first, '(async () => { for (let i = 0; i < 3; i++) { window.connect(); await new Promise(r => setTimeout(r, 100)); } })()');
    await waitFor(async () => (await firmware(first)).volumeOn, 'applied after the burst');
    await sleep(2500);
    const burst = (await autoCalls(first)).length - beforeBurst;
    assert.ok(burst >= 1 && burst <= 3, `Bounded applications: ${burst}`);
    const settledCount = (await autoCalls(first)).length;
    await sleep(1500);
    assert.equal((await autoCalls(first)).length, settledCount, 'No startup loop');

    // Logout: the login helper signs in again and the reloaded page applies startup again.
    startups.delete(first.webContents.id);
    await run(first, "localStorage.removeItem('fixture-auth'); window.logout(); setTimeout(() => location.reload(), 0)");
    await waitFor(async () => !first.webContents.isLoading() && await live(first) && helpersGone(), 'signed in again', 300);
    await waitFor(() => settled(first), 'startup after sign-in');
    assert.deepEqual(await autoCalls(first), [['volume', true, 'auto'], ['mic', true, 'auto']]);
    assert.ok(startupPeers.length > 0 && startupPeers.every(title => title === 'First' || title === 'Second'), `Only viewers take part: ${startupPeers.join(', ')}`);

    // Delayed stores and USB initialization: nothing happens until both are ready.
    await setStartup({ speaker: true, microphone: true }, { speaker: true, microphone: false });
    await reload(second, { manualStores: true });
    await waitFor(() => startup(second)?.speakerState === 'waiting', 'waiting for stores');
    await sleep(1500);
    await run(second, 'window.firmware.usb.initLoading = true; window.mountStores()');
    await sleep(1500);
    assert.equal(startup(second)?.speakerState, 'waiting');
    assert.deepEqual((await firmware(second)).calls, [], 'Stores and USB initialization are awaited');
    await run(second, 'window.firmware.usb.initLoading = false');
    await waitFor(() => settled(second), 'applied once ready');
    assert.deepEqual(await autoCalls(second), [['volume', true, 'auto']]);

    // The microphone needs the device's USB microphone and a selected microphone for this window state.
    await setStartup({ speaker: false, microphone: false }, { speaker: false, microphone: true });
    await reload(second, { enableMic: false });
    await waitFor(() => settled(second), 'USB microphone off');
    assert.equal(startup(second)?.microphoneState, 'unavailable');
    assert.deepEqual((await firmware(second)).calls, []);
    for (const input of ['disabled', { uid: 'AppleUSBAudioEngine:Unplugged:1', label: 'Unplugged' }]) {
      await save(value => { value.devices[1].audio.foreground.input = input; value.devices[1].audio.background.input = input; });
      await reload(second);
      await waitFor(() => settled(second), `profile ${JSON.stringify(input)}`);
      assert.equal(startup(second)?.microphoneState, 'unavailable');
      assert.deepEqual([(await firmware(second)).calls, statuses.get(second.webContents.id)?.openInputs ?? 0], [[], 0], 'No capture');
    }
    await save(value => { value.devices[1].audio.foreground.input = 'default'; value.devices[1].audio.background.input = 'default'; });

    // Direct H.264 has no sound or microphone in the firmware.
    await setStartup({ speaker: false, microphone: false }, { speaker: true, microphone: true });
    await run(second, `localStorage.setItem('fixture-firmware', '{"direct":true}')`);
    startups.delete(second.webContents.id);
    second.webContents.reload();
    await waitFor(() => !second.webContents.isLoading() && run(second, "!!document.querySelector('#stream-canvas')"), 'direct canvas');
    await waitFor(() => settled(second), 'direct mode');
    assert.deepEqual(startup(second), { speaker: true, microphone: true, speakerState: 'unsupported', microphoneState: 'unsupported' });
    assert.deepEqual((await firmware(second)).calls, []);

    // Permission denied: one attempt, ended, and not repeated for a new video session.
    // This replaces the app's permission handler for this connection, so it runs last.
    let requests = 0;
    second.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => { if (permission === 'media') requests++; callback(permission === 'pointerLock'); });
    await setStartup({ speaker: false, microphone: false }, { speaker: false, microphone: true });
    await reload(second);
    await waitFor(() => settled(second), 'denied microphone');
    assert.equal(startup(second)?.microphoneState, 'denied');
    const denied = await firmware(second);
    assert.deepEqual([denied.micMuted, denied.micErrors, requests], [true, 1, 1], 'The attempt ended after one request');
    await run(second, 'window.connect()');
    await waitFor(async () => settled(second) && (await run(second, 'window.firmware.kvm.configState.initVideoSessionFinished')), 'new session after denial');
    await sleep(1500);
    assert.deepEqual([(await autoCalls(second)).length, requests, startup(second)?.microphoneState], [1, 1, 'denied'], 'No repeated prompt');

    assert.equal(first.webContents.isAudioMuted() && second.webContents.isAudioMuted(), true, 'Global mute held throughout');
    console.log('PASS: startup audio defaults and idempotence, fake-device gate, settings switches, all four combinations on two connections, no change on save, once per session, manual changes across focus/routes/audio-only reconnect/buffering, reapply after a new video session and after sign-in, bounded transport replacement, viewers only, delayed stores and USB initialization, USB microphone off, disabled and missing microphone, Direct mode, single denied attempt, global mute and routing preserved');
    app.exit(0);
  } catch (error) {
    console.error(error); console.error('Startups:', JSON.stringify([...startups]), 'Statuses:', JSON.stringify([...statuses]));
    app.exit(1);
  }
  finally { server.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
