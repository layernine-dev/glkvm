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
// Unmuting starts the microphone like the firmware's audio session; a failure shows the firmware's
// microphone error dialog and re-mutes it, and a capture that resolves after a mute is stale and stopped.
// Nothing is played. Options come from localStorage 'fixture-firmware' and apply on load:
// answerError (the audio answer fails before any microphone request, then re-mutes), answerHang
// (no microphone request at all), micDelay (ms before the request), keepOnFailure (no re-mute),
// earlierDialog (the error dialog is already open from before, as after a failed manual capture),
// retainTrack (like the firmware's audio session, a mute disables the microphone track and an unmute
// enables it again without a new request; window.connect replaces only the video and keeps it).
// window.holdVideoInit keeps a new video session unfinished until it is cleared.
const firmwareScript = `<div id="app"></div><script>
(() => {
  const options = JSON.parse(localStorage.getItem('fixture-firmware') || '{}');
  window.firmwareCalls = []; window.micErrors = 0; window.mic = null; window.manualCall = false; window.staleMics = 0; window.micRequests = 0;
  window.startMic = async () => {
    window.micRequests++;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false } });
    const muted = window.firmware.audioMic.state.micMuted;
    if (muted && !options.retainTrack) { stream.getTracks().forEach(track => track.stop()); window.staleMics++; return; }
    if (muted) stream.getAudioTracks()[0].enabled = false;
    const pc = new RTCPeerConnection();
    pc.addTrack(stream.getAudioTracks()[0], stream);
    window.mic = { stream, pc };
  };
  window.stopMic = () => { if (!window.mic) return; window.mic.stream.getTracks().forEach(track => track.stop()); window.mic.pc.close(); window.mic = null; };
  // Like the firmware, one dialog at a time.
  const showDialog = () => {
    if (document.querySelector('.mic-permission-error-modal')) return;
    const modal = document.createElement('div'); modal.className = 'ant-modal-wrap mic-permission-error-modal'; document.body.append(modal);
  };
  const failed = () => { window.micErrors++; showDialog(); };
  if (options.earlierDialog) showDialog();
  const usb = { enableMic: options.enableMic !== false, initLoading: options.initLoading === true };
  const kvm = { configState: { volumeOn: false, initVideoSessionFinished: false }, isDirectMode: options.direct === true,
    setVolumeOn(on) { window.firmwareCalls.push(['volume', on, window.manualCall ? 'manual' : 'auto']); kvm.configState.volumeOn = on; } };
  const audioMic = { state: { micMuted: true, micUnmuteByKeyPressing: false, micJanusConnected: false },
    setMicMuted(muted) {
      window.firmwareCalls.push(['mic', !muted, window.manualCall ? 'manual' : 'auto']);
      audioMic.state.micMuted = muted;
      const track = options.retainTrack && window.mic?.stream.getAudioTracks()[0];
      if (track && track.readyState === 'live') { track.enabled = !muted; return; }
      if (muted) { window.stopMic(); return; }
      if (!usb.enableMic || kvm.isDirectMode) return;
      if (options.answerError) { setTimeout(() => { failed(); audioMic.state.micMuted = true; }, 300); return; }
      if (options.answerHang) return;
      const start = () => {
        if (audioMic.state.micMuted) return;
        window.startMic().catch(() => { failed(); if (!options.keepOnFailure) audioMic.state.micMuted = true; });
      };
      if (options.micDelay) setTimeout(start, options.micDelay); else start();
    } };
  window.firmware = { kvm, audioMic, usb };
  window.manual = action => { window.manualCall = true; try { action(window.firmware); } finally { window.manualCall = false; } };
  // Like the firmware, a new video session is unfinished until its first remote track.
  const connect = window.connect;
  window.holdVideoInit = false;
  const finish = () => { if (window.holdVideoInit) setTimeout(finish, 100); else kvm.configState.initVideoSessionFinished = true; };
  window.connect = (...args) => { kvm.configState.initVideoSessionFinished = false; connect(...args); setTimeout(finish, 300); };
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
/** @param {boolean} signedIn */
const page = signedIn => createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  const html = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
  res.end((signedIn ? html.replace('<script>', '<script>localStorage.setItem("fixture-auth", "true");') : html).replace('</body>', firmwareScript));
});
const server = page(false);
// Serves an already signed-in page for a connection opened later with a fresh session.
const signedInServer = page(true);
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
/** Routes sent to each page. @type {Map<number, import('../src/audio.cjs').SentRoute[]>} */
const routes = new Map();
/** Every startup report, with whether the page's latest route still had an unresolved microphone, and when.
 * @type {[number, import('../src/audio.cjs').StartupStatus, boolean, number][]} */
const startupLog = [];
const titleOf = (/** @type {Electron.WebContents} */ contents) => BrowserWindow.fromWebContents(contents)?.getTitle() || '';
ipcMain.on('glkvm:audio-status', (event, status) => statuses.set(event.sender.id, status));
ipcMain.on('glkvm:audio-devices', (event, list) => reports.set(event.sender.id, list));
ipcMain.on('glkvm:audio-startup-status', (event, status) => {
  startups.set(event.sender.id, status); startupPeers.push(titleOf(event.sender));
  startupLog.push([event.sender.id, status, routes.get(event.sender.id)?.at(-1)?.inputMissing === true, Date.now()]);
});
app.on('web-contents-created', (_event, contents) => {
  const send = contents.send;
  contents.send = (channel, ...args) => {
    if (channel === 'glkvm:audio-startup') startupPeers.push(titleOf(contents));
    if (channel === 'glkvm:audio-route') routes.set(contents.id, [...(routes.get(contents.id) || []), args[0]]);
    return send.call(contents, channel, ...args);
  };
});

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise(resolve => signedInServer.listen(0, '127.0.0.1', () => resolve(undefined)));
  const signedInAddress = signedInServer.address();
  assert.ok(signedInAddress && typeof signedInAddress !== 'string');
  const thirdOrigin = `http://127.0.0.1:${signedInAddress.port}`;
  /** @type {import('../src/audio.cjs').AudioProfile} */
  const savedMicrophone = { input: { uid: 'fake_audio_input_1', label: 'Fake Audio Input 1' }, output: 'default' };
  // Select the fake device explicitly: Chromium's default-device capture can
  // stall on the macOS runner even with fake media enabled. Never depend on the host default.
  /** @type {{foreground: import('../src/audio.cjs').AudioProfile, background: import('../src/audio.cjs').AudioProfile}} */
  const microphoneProfiles = { foreground: savedMicrophone, background: savedMicrophone };
  const config = defaults();
  // Globally muted throughout: nothing is audible even when device sound turns on.
  config.muted = true;
  config.devices = [
    { id: 'first', name: 'First', origin: `http://127.0.0.1:${address.port}`, openAtStartup: true, audio: { ...microphoneProfiles, startup: { speaker: false, microphone: false } } },
    { id: 'second', name: 'Second', origin: `http://localhost:${address.port}`, openAtStartup: true, audio: { ...microphoneProfiles, startup: { speaker: false, microphone: false } } },
    // Opened later: a saved microphone by native UID in a session whose device ID salt is new.
    { id: 'third', name: 'Third', origin: thirdOrigin, openAtStartup: false, audio: { foreground: savedMicrophone, background: savedMicrophone, startup: { speaker: true, microphone: true } } },
  ];
  fakeCatalog.setDevices(fakeCatalog.fakeDevices());
  await app.whenReady();
  // Both connections sign in through the hidden login helper with the fixture password.
  const stored = await prepareConfig({ ...config, devices: config.devices.map(device => ({ ...device, password: device.id === 'third' ? '' : 'fixture-secret' })) }, config, safeStorage);
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
    assert.deepEqual((await run(settings, 'window.settings.load()')).devices.map((/** @type {any} */ device) => device.audio.startup), [{ speaker: true, microphone: false }, { speaker: false, microphone: false }, { speaker: true, microphone: true }]);

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

    // Replacing the video transport rapidly is rate limited, without a loop: at most five sessions
    // start applying per five seconds, counted by their final reports.
    const burstStart = startupLog.length;
    const finishedTimes = () => startupLog.slice(burstStart).filter(([id, status]) => id === first.webContents.id && status.speakerState !== 'waiting' && status.microphoneState !== 'waiting').map(entry => entry[3]);
    await run(first, 'window.manual(({ kvm }) => kvm.setVolumeOn(false))');
    await run(first, '(async () => { for (let i = 0; i < 20; i++) { window.connect(); await new Promise(r => setTimeout(r, 400)); } })()');
    await waitFor(async () => (await firmware(first)).volumeOn, 'applied after the burst');
    await sleep(5500);
    const settledCount = finishedTimes().length;
    assert.ok(settledCount >= 1, 'The burst applied');
    await sleep(1500);
    assert.equal(finishedTimes().length, settledCount, 'No startup loop');
    // The limit recovers: every later reconnect applies, well past twenty sessions in one page.
    for (let i = 0; i < 22; i++) {
      await run(first, 'window.manual(({ kvm }) => kvm.setVolumeOn(false))');
      await run(first, 'window.connect()');
      await waitFor(async () => (await firmware(first)).volumeOn, `reconnect ${i + 1} applied`);
    }
    const times = finishedTimes();
    assert.ok(times.length >= settledCount + 22, `Every reconnect reported: ${times.length}`);
    // Reports follow the start within milliseconds; the margin covers IPC delivery.
    times.forEach((time, i) => assert.ok(i < 5 || time - times[i - 5] >= 4500, `At most five per five seconds: ${times.join(', ')}`));

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
      const begun = Date.now();
      await reload(second);
      // A disabled profile is reported at once; a missing device after the bounded wait for its mapping.
      await waitFor(() => settled(second), `profile ${JSON.stringify(input)}`, 300);
      if (input === 'disabled') assert.ok(Date.now() - begun < 10000, 'A disabled microphone is not awaited');
      else assert.ok(Date.now() - begun < 28000, `A missing microphone is reported within the bound: ${Date.now() - begun} ms`);
      assert.equal(startup(second)?.microphoneState, 'unavailable');
      assert.deepEqual([(await firmware(second)).calls, statuses.get(second.webContents.id)?.openInputs ?? 0], [[], 0], 'No capture');
    }
    await save(value => { value.devices[1].audio.foreground.input = savedMicrophone.input; value.devices[1].audio.background.input = savedMicrophone.input; });

    // Direct H.264 has no sound or microphone in the firmware.
    await setStartup({ speaker: false, microphone: false }, { speaker: true, microphone: true });
    await run(second, `localStorage.setItem('fixture-firmware', '{"direct":true}')`);
    startups.delete(second.webContents.id);
    second.webContents.reload();
    await waitFor(() => !second.webContents.isLoading() && run(second, "!!document.querySelector('#stream-canvas')"), 'direct canvas');
    await waitFor(() => settled(second), 'direct mode');
    assert.deepEqual(startup(second), { speaker: true, microphone: true, speakerState: 'unsupported', microphoneState: 'unsupported' });
    assert.deepEqual((await firmware(second)).calls, []);

    // Address edits keep the microphone at connect for the same origin (trailing slash, letter case,
    // reverting), turn it off for a different origin, and the saved result matches after a reload.
    const thirdMicrophone = () => run(settings, "document.querySelectorAll('.audio-startup-microphone')[2].checked");
    /** @param {string} value */
    const typeAddress = value => run(settings, `(() => { const input = document.querySelector('#address-2'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input')); })()`);
    /** @param {string} label */
    const submitted = async label => {
      await run(settings, "document.querySelector('#settings-form').requestSubmit()");
      await waitFor(async () => (await run(settings, "document.querySelector('#save-status').textContent")) === 'Changes saved', label);
      return /** @type {{origin: string, audio: import('../src/audio.cjs').AudioSettings}} */ ((await run(settings, 'window.settings.load()')).devices[2]);
    };
    for (const [value, checked] of /** @type {[string, boolean][]} */ ([[`${thirdOrigin}/`, true], [thirdOrigin.replace('http:', 'HTTP:'), true], ['http://127.0.0.1:1', false], ['http://127.0.0.1:', false], [`${thirdOrigin}/`, true]])) {
      await typeAddress(value);
      assert.equal(await thirdMicrophone(), checked, `Microphone switch for ${value}`);
    }
    let thirdSaved = await submitted('same origin saved');
    assert.deepEqual([thirdSaved.origin, thirdSaved.audio.startup], [thirdOrigin, { speaker: true, microphone: true }], 'A spelling-only change keeps the setting');
    settings.webContents.reload();
    await waitFor(() => !settings.webContents.isLoading() && run(settings, "document.querySelectorAll('.audio-startup-microphone').length === 3"), 'settings reloaded');
    assert.equal(await thirdMicrophone(), true, 'Reloaded settings show the saved switch');
    await typeAddress(`http://localhost:${signedInAddress.port}`);
    assert.equal(await thirdMicrophone(), false);
    thirdSaved = await submitted('new origin saved');
    assert.deepEqual([thirdSaved.origin, thirdSaved.audio.startup, thirdSaved.audio.foreground], [`http://localhost:${signedInAddress.port}`, { speaker: true, microphone: false }, savedMicrophone], 'A different origin turns it off and keeps the device choices');
    assert.equal(await thirdMicrophone(), false, 'The form matches the saved setting');
    await save(value => { value.devices[2].origin = thirdOrigin; });
    await save(value => { value.devices[2].audio.startup.microphone = true; });

    // A saved microphone in a newly opened session: live video is ready before Chromium has persisted
    // the session's device ID salt, so the microphone is unresolved at first. Startup waits for the
    // mapping and starts the microphone once. Chromium's fake devices apply to every session (gate above).
    await run(settings, "window.settings.open('third')");
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'Third'), 'third window');
    const third = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Third'));
    await waitFor(() => !third.webContents.isLoading() && live(third), 'third live video');
    await waitFor(() => settled(third), 'third startup', 250);
    assert.deepEqual(startup(third), { speaker: true, microphone: true, speakerState: 'applied', microphoneState: 'applied' });
    assert.deepEqual(await autoCalls(third), [['volume', true, 'auto'], ['mic', true, 'auto']], 'The microphone started once');
    assert.ok(startupLog.some(([id, status, missing]) => id === third.webContents.id && status.speakerState === 'applied' && status.microphoneState === 'waiting' && missing), 'Video was ready while the saved microphone was still unresolved');
    assert.equal(routes.get(third.webContents.id)?.at(-1)?.inputMissing, false);
    await waitFor(() => statuses.get(third.webContents.id)?.input === 'live', 'third microphone live');
    const thirdDevices = reports.get(third.webContents.id) || [];
    assert.ok(thirdDevices.length > 0 && thirdDevices.every(device => /^Fake /.test(device.label)), 'Only fake devices in the new session');
    third.close();
    await waitFor(() => !BrowserWindow.getAllWindows().some(win => win.getTitle() === 'Third'), 'third closed');

    /** @param {Electron.BrowserWindow} win @param {import('../src/audio.cjs').StartupState} state @param {number} since */
    const reportsOf = (win, state, since) => startupLog.slice(since).filter(([id, status]) => id === win.webContents.id && status.microphoneState === state).length;
    const micOnCall = async () => (await autoCalls(second)).some(call => call[0] === 'mic' && call[1]);

    // The firmware's audio session outlives a video-only replacement (orientation, video format) and
    // keeps a manually muted microphone's track. The next session unmutes it by enabling that track,
    // without a new request: applied at once, and still on well past the 15 s bound for a request.
    await setStartup({ speaker: false, microphone: false }, { speaker: true, microphone: true });
    let since = startupLog.length;
    await reload(second, { retainTrack: true });
    await waitFor(() => settled(second) && statuses.get(second.webContents.id)?.input === 'live', 'retained microphone started');
    const micTrack = "window.mic?.stream.getAudioTracks().map(track => [track.readyState, track.enabled])[0]";
    await run(second, 'window.manual(({ audioMic }) => audioMic.setMicMuted(true))');
    assert.deepEqual(await run(second, micTrack), ['live', false], 'The manual mute keeps the track');
    startups.delete(second.webContents.id);
    const replaced = Date.now();
    await run(second, 'window.connect()');
    await waitFor(() => settled(second), 'retained microphone re-enabled');
    assert.ok(Date.now() - replaced < 5000, `Re-enabled without the request bound: ${Date.now() - replaced} ms`);
    assert.deepEqual(startup(second), { speaker: true, microphone: true, speakerState: 'unchanged', microphoneState: 'applied' });
    await sleep(16000);
    let state = await firmware(second);
    assert.deepEqual([await autoCalls(second), state.micMuted, state.micErrors, await run(second, 'window.micRequests'), await run(second, micTrack)],
      [[['volume', true, 'auto'], ['mic', true, 'auto'], ['mic', true, 'auto']], false, 0, 1, ['live', true]], 'No new request, failure or re-mute');
    assert.deepEqual([startup(second)?.microphoneState, reportsOf(second, 'error', since), reportsOf(second, 'denied', since), statuses.get(second.webContents.id)?.input], ['applied', 0, 0, 'live']);
    // Not blocked: the next video session re-enables it again.
    await run(second, 'window.manual(({ audioMic }) => audioMic.setMicMuted(true))');
    startups.delete(second.webContents.id);
    await run(second, 'window.connect()');
    await waitFor(() => settled(second), 'retained microphone re-enabled again');
    assert.deepEqual([startup(second)?.microphoneState, (await firmware(second)).micMuted, await run(second, 'window.micRequests'), await run(second, micTrack)], ['applied', false, 1, ['live', true]]);

    // The reverse: a retained microphone left on transmits across a video-only reconnect. With startup
    // microphone off, the new session mutes it as soon as the stores are usable, before USB and video
    // initialization or the rate limit: the same track and sender, disabled, without a new capture.
    // Saving the setting does not mute the running session.
    await setStartup({ speaker: false, microphone: false }, { speaker: false, microphone: false });
    await sleep(1000);
    assert.deepEqual([(await firmware(second)).micMuted, await run(second, micTrack)], [false, ['live', true]], 'Saving does not mute the running session');
    await run(second, 'window.retained = { track: window.mic.stream.getAudioTracks()[0], sender: window.mic.pc.getSenders()[0] }');
    const retainedKept = "window.mic.stream.getAudioTracks()[0] === window.retained.track && window.mic.pc.getSenders()[0] === window.retained.sender && window.retained.sender.track === window.retained.track";
    const offCalls = async () => (await autoCalls(second)).filter(call => call[0] === 'mic' && !call[1]).length;
    /** @param {string} script @param {number} count @param {string} label */
    const mutedEarly = async (script, count, label) => {
      startups.delete(second.webContents.id);
      await run(second, script);
      await waitFor(async () => await offCalls() === count && startup(second)?.microphoneState === 'applied', label);
      assert.deepEqual([startup(second)?.speakerState, (await firmware(second)).micMuted, await run(second, micTrack), await run(second, 'window.micRequests'), await run(second, retainedKept)],
        ['waiting', true, ['live', false], 1, true], `${label}: muted before initialization, no new capture`);
    };
    // Stalled USB initialization: muted at once; a manual unmute in the same session survives later
    // ticks and the completed startup.
    since = startupLog.length;
    await mutedEarly('window.firmware.usb.initLoading = true; window.connect()', 1, 'muted while USB initializes');
    await run(second, 'window.manual(({ audioMic }) => audioMic.setMicMuted(false))');
    await sleep(1000);
    await run(second, 'window.firmware.usb.initLoading = false');
    await waitFor(() => settled(second), 'startup after USB initialization');
    await sleep(1000);
    assert.deepEqual(startup(second), { speaker: false, microphone: false, speakerState: 'applied', microphoneState: 'applied' });
    assert.deepEqual([await offCalls(), (await firmware(second)).micMuted, await run(second, micTrack), await run(second, retainedKept)], [1, false, ['live', true], true], 'The manual unmute stays');
    // Stalled video initialization: muted at once; the bounded wait reports the microphone result
    // without muting again, and a manual unmute meanwhile stays.
    await mutedEarly('window.holdVideoInit = true; window.connect()', 2, 'muted while video initializes');
    await run(second, 'window.manual(({ audioMic }) => audioMic.setMicMuted(false))');
    await waitFor(() => settled(second), 'video initialization timed out', 350);
    assert.deepEqual(startup(second), { speaker: false, microphone: false, speakerState: 'error', microphoneState: 'applied' });
    assert.deepEqual([await offCalls(), (await firmware(second)).micMuted, await run(second, micTrack), await run(second, retainedKept)], [2, false, ['live', true], true], 'No second mute after the timeout');
    // Recovery: the next session mutes again and completes.
    startups.delete(second.webContents.id);
    await run(second, 'window.holdVideoInit = false; window.connect()');
    await waitFor(() => settled(second), 'next session after the timeout');
    assert.deepEqual(startup(second), { speaker: false, microphone: false, speakerState: 'unchanged', microphoneState: 'applied' });
    assert.deepEqual([await offCalls(), (await firmware(second)).micMuted, await run(second, micTrack), await run(second, 'window.micRequests'), await run(second, retainedKept)], [3, true, ['live', false], 1, true]);
    assert.deepEqual([reportsOf(second, 'error', since), reportsOf(second, 'denied', since), (await firmware(second)).micErrors], [0, 0, 0]);

    // The permission handlers below replace the app's for this connection, so these checks run last.
    // A manual mute while the real capture request is pending (held at the permission request) is no
    // failure: it ends the attempt for this session only, and the next video session starts it again.
    /** @type {((granted: boolean) => void)[]} */
    const held = [];
    let hold = true;
    second.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => { if (permission === 'media' && hold) held.push(callback); else callback(permission === 'media' || permission === 'pointerLock'); });
    await setStartup({ speaker: false, microphone: false }, { speaker: false, microphone: true });
    since = startupLog.length;
    await reload(second);
    await waitFor(() => held.length > 0, 'pending microphone request');
    await run(second, 'window.manual(({ audioMic }) => audioMic.setMicMuted(true))');
    await waitFor(() => settled(second), 'attempt ended by the manual mute');
    assert.ok(held.length > 0 && statuses.get(second.webContents.id)?.input !== 'live', 'Ended while the capture was still pending');
    assert.deepEqual([startup(second)?.microphoneState, reportsOf(second, 'error', since), reportsOf(second, 'denied', since)], ['applied', 0, 0], 'A manual mute is no failure');
    // The stale request completes afterwards: the firmware stops it and the manual mute holds.
    held.splice(0).forEach(callback => callback(true));
    await waitFor(() => run(second, 'window.staleMics > 0'), 'stale capture resolved');
    await waitFor(() => (statuses.get(second.webContents.id)?.openInputs ?? 0) === 0 && statuses.get(second.webContents.id)?.input === 'idle', 'stale capture closed');
    state = await firmware(second);
    assert.deepEqual([await autoCalls(second), state.micMuted, state.micErrors], [[['mic', true, 'auto']], true, 0], 'The manual mute holds');
    hold = false;
    startups.delete(second.webContents.id);
    await run(second, 'window.connect()');
    await waitFor(() => settled(second) && statuses.get(second.webContents.id)?.input === 'live', 'microphone started in the next session');
    state = await firmware(second);
    assert.deepEqual([await autoCalls(second), startup(second)?.microphoneState, state.micMuted, state.micErrors], [[['mic', true, 'auto'], ['mic', true, 'auto']], 'applied', false, 0], 'Started again after reconnect');
    assert.deepEqual([reportsOf(second, 'error', since), reportsOf(second, 'denied', since)], [0, 0]);

    // A firmware dialog still open from before the attempt is not its failure: a manual mute during
    // the pending capture ends the attempt without a block, and the next video session starts again.
    hold = true;
    since = startupLog.length;
    await reload(second, { earlierDialog: true });
    await waitFor(() => held.length > 0, 'pending microphone request beside the earlier dialog');
    await run(second, 'window.manual(({ audioMic }) => audioMic.setMicMuted(true))');
    await waitFor(() => settled(second), 'attempt ended by the manual mute beside the earlier dialog');
    assert.deepEqual([startup(second)?.microphoneState, reportsOf(second, 'error', since), reportsOf(second, 'denied', since)], ['applied', 0, 0], 'The earlier dialog is no failure');
    held.splice(0).forEach(callback => callback(true));
    await waitFor(() => run(second, 'window.staleMics > 0'), 'stale capture resolved beside the earlier dialog');
    await waitFor(() => (statuses.get(second.webContents.id)?.openInputs ?? 0) === 0, 'stale capture closed beside the earlier dialog');
    hold = false;
    startups.delete(second.webContents.id);
    await run(second, 'window.connect()');
    await waitFor(() => settled(second) && statuses.get(second.webContents.id)?.input === 'live', 'microphone started after the earlier dialog');
    state = await firmware(second);
    assert.deepEqual([await autoCalls(second), startup(second)?.microphoneState, state.micMuted, state.micErrors], [[['mic', true, 'auto'], ['mic', true, 'auto']], 'applied', false, 0], 'Started again after reconnect');
    assert.deepEqual([reportsOf(second, 'error', since), reportsOf(second, 'denied', since)], [0, 0]);

    // Permission denied: one attempt, ended, and not repeated for a new video session.
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

    // A delayed failure of an older attempt does not touch a newer video session: no re-mute, no block.
    since = startupLog.length;
    await reload(second, { micDelay: 1500, keepOnFailure: true });
    await waitFor(micOnCall, 'delayed attempt started');
    await run(second, 'window.connect()');
    await waitFor(() => settled(second) && startup(second)?.microphoneState === 'unchanged', 'newer session');
    await sleep(2500);
    state = await firmware(second);
    assert.deepEqual([await autoCalls(second), state.micMuted, state.micErrors], [[['mic', true, 'auto']], false, 1], 'The failure arrived after the new session and changed nothing');
    assert.deepEqual([reportsOf(second, 'denied', since), reportsOf(second, 'error', since), startup(second)?.microphoneState], [0, 0, 'unchanged']);

    // A delayed failure after manual microphone changes does not override them.
    since = startupLog.length;
    await reload(second, { micDelay: 1500, keepOnFailure: true });
    await waitFor(micOnCall, 'second delayed attempt started');
    await run(second, 'window.manual(({ audioMic }) => audioMic.setMicMuted(true))');
    await sleep(500);
    await run(second, 'window.manual(({ audioMic }) => audioMic.setMicMuted(false))');
    await sleep(3500);
    state = await firmware(second);
    assert.deepEqual([await autoCalls(second), state.micMuted], [[['mic', true, 'auto']], false], 'The manual microphone stays on');
    // The manual mute ended the attempt without a failure: the later failure is not attributed to it.
    assert.deepEqual([startup(second)?.microphoneState, reportsOf(second, 'error', since), reportsOf(second, 'denied', since)], ['applied', 0, 0]);

    // The firmware's audio answer fails before any microphone request and re-mutes: one error, no
    // capture and no prompt, the app does not fight the controls, and a new session does not retry.
    since = startupLog.length;
    let before = requests;
    await reload(second, { answerError: true });
    await waitFor(() => settled(second), 'failed answer');
    await sleep(1500);
    state = await firmware(second);
    assert.deepEqual([startup(second)?.microphoneState, reportsOf(second, 'error', since), reportsOf(second, 'applied', since)], ['error', 1, 0], 'Reported once, never applied');
    assert.deepEqual([await autoCalls(second), state.micMuted, state.micErrors, requests - before, statuses.get(second.webContents.id)?.openInputs], [[['mic', true, 'auto']], true, 1, 0, 0]);
    await run(second, 'window.connect()');
    await waitFor(async () => settled(second) && (await run(second, 'window.firmware.kvm.configState.initVideoSessionFinished')), 'new session after the failed answer');
    await sleep(1000);
    assert.deepEqual([(await autoCalls(second)).length, startup(second)?.microphoneState], [1, 'error'], 'Not retried');

    // No microphone request at all: after the bounded wait the attempt ends once with an error.
    since = startupLog.length;
    before = requests;
    await reload(second, { answerHang: true });
    await waitFor(() => settled(second), 'attempt without a request', 250);
    await sleep(1500);
    state = await firmware(second);
    assert.deepEqual([startup(second)?.microphoneState, reportsOf(second, 'applied', since)], ['error', 0]);
    assert.deepEqual([await autoCalls(second), state.micMuted, requests - before, statuses.get(second.webContents.id)?.openInputs], [[['mic', true, 'auto'], ['mic', false, 'auto']], true, 0, 0], 'Ended once');

    assert.equal(first.webContents.isAudioMuted() && second.webContents.isAudioMuted(), true, 'Global mute held throughout');
    console.log('PASS: startup audio defaults and idempotence, fake-device gate, settings switches, all four combinations on two connections, no change on save, once per session, manual changes across focus/routes/audio-only reconnect/buffering, reapply after a new video session and after sign-in, rate-limited transport replacement that recovers past twenty sessions, viewers only, delayed stores and USB initialization, USB microphone off, disabled and bounded missing microphone, Direct mode, same-origin address edits and a new origin, a saved microphone awaited while its new session is mapped, a retained muted microphone track re-enabled after a video-only replacement without a request, failure or re-mute past 15 s, a retained live microphone muted before stalled USB or video initialization with the same track and sender, manual unmute kept through completion and timeout, muted again next session, a manual mute during a pending capture restarted by the next session, also beside an earlier error dialog, single denied attempt, delayed failures across a new session and manual changes, a failed and a missing firmware answer, global mute and routing preserved');
    app.exit(0);
  } catch (error) {
    console.error(error); console.error('Startups:', JSON.stringify([...startups]), 'Statuses:', JSON.stringify([...statuses]));
    app.exit(1);
  }
  finally { server.close(); signedInServer.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
