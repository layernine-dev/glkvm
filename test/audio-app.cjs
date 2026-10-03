require('./runtime.cjs');
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaults } = require('../src/config.cjs');
const fakeCatalog = require('./fake-catalog.cjs');
const { readDeviceIdSalt } = require('../src/device-ids.cjs');

// Chromium's fake capture and output devices: no microphone or speaker hardware is used.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-audio-'));
const evidence = process.env.GLKVM_AUDIO_EVIDENCE;
app.setPath('userData', directory);

// Mirrors the firmware's microphone path: getUserMedia({audio: constraints}), a
// peer connection sender, mute through track.enabled, and remote playback elements.
// The played signal is silent (gain 0).
const vendorScript = `<script>
  window.mic = null;
  window.startMic = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, sampleRate: 48000, sampleSize: 16, autoGainControl: false, noiseSuppression: false } });
    const track = stream.getAudioTracks()[0];
    const pc = new RTCPeerConnection();
    const sender = pc.addTrack(track, stream);
    window.mic = { stream, track, pc, sender };
    return track.readyState;
  };
  window.setMicEnabled = enabled => { window.mic.track.enabled = enabled; };
  window.stopMic = () => { window.mic.stream.getTracks().forEach(track => track.stop()); window.mic.pc.close(); };
  window.tryMedia = constraints => navigator.mediaDevices.getUserMedia(constraints).then(stream => { stream.getTracks().forEach(track => track.stop()); return 'granted'; }, error => error.name);
  window.toneStream = () => {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain(); gain.gain.value = 0;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination); oscillator.start();
    return destination.stream;
  };
  window.playRemote = () => {
    const audio = document.createElement('audio'); audio.className = 'remote-audio';
    document.body.append(audio);
    audio.srcObject = window.toneStream();
    return audio.play().then(() => 'playing', error => error.name);
  };
  window.sinks = () => [...document.querySelectorAll('.remote-audio')].map(audio => audio.sinkId);
  // Test control: slow down speaker changes, as a slow audio device would, or make players reject them.
  window.sinkDelay = 0; window.sinkFail = false; window.sinkCalls = [];
  for (const proto of [HTMLMediaElement.prototype, Object.getPrototypeOf(AudioContext.prototype)]) {
    const original = proto.setSinkId;
    proto.setSinkId = function setSinkId(id) {
      window.sinkCalls.push(id);
      const fail = window.sinkFail && this instanceof HTMLMediaElement;
      if (!window.sinkDelay && !fail) return original.call(this, id);
      return new Promise(resolve => setTimeout(resolve, window.sinkDelay)).then(() => fail ? Promise.reject(new DOMException('Test speaker failure.', 'AbortError')) : original.call(this, id));
    };
  }
  window.delaySinks = ms => { window.sinkDelay = ms; };
</script></body>`;
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8').replace('<script>', '<script>localStorage.setItem("fixture-auth", "true");').replace('</body>', vendorScript));
});
/** @param {() => unknown | Promise<unknown>} condition @param {string} [label] @param {number} [tries] */
async function waitFor(condition, label = 'application state', tries = 100) {
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

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = defaults();
  config.muted = false;
  config.devices = [
    { id: 'first', name: 'First', origin: `http://127.0.0.1:${address.port}`, openAtStartup: true, audio: { foreground: { input: 'default', output: 'default' }, background: { input: 'disabled', output: 'default' } } },
    { id: 'second', name: 'Second', origin: `http://localhost:${address.port}`, openAtStartup: true },
  ];
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(config));
  fakeCatalog.setDevices(fakeCatalog.fakeDevices());
  await app.whenReady();
  require('../src/main.cjs');
  try {
    await waitFor(() => ['First', 'Second'].every(title => BrowserWindow.getAllWindows().some(win => win.getTitle() === title)));
    const first = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'First'));
    const second = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Second'));
    await waitFor(() => !first.webContents.isLoading() && !second.webContents.isLoading());
    /** @param {Electron.BrowserWindow} win @param {string} script */
    const run = (win, script) => win.webContents.executeJavaScript(script);
    const status = (/** @type {Electron.BrowserWindow} */ win) => statuses.get(win.webContents.id);
    assert.equal(await run(first, 'typeof window.settings'), 'undefined', 'No bridge is exposed to the page');

    // Safety gate: only continue with Chromium's fake microphones.
    await waitFor(() => reports.get(first.webContents.id)?.some(device => device.kind === 'audioinput'), 'microphone names');
    const firstDevices = /** @type {{kind: string, deviceId: string, label: string}[]} */ (reports.get(first.webContents.id));
    const inputs = firstDevices.filter(device => device.kind === 'audioinput');
    const outputs = firstDevices.filter(device => device.kind === 'audiooutput');
    if (!inputs.every(device => /^Fake /.test(device.label)) || !outputs.every(device => /^Fake /.test(device.label))) throw new Error(`Refusing to test with real devices: ${firstDevices.map(device => device.label).join(', ')}`);
    assert.equal(inputs.length, 2); assert.equal(outputs.length, 2);
    await waitFor(() => reports.get(second.webContents.id), 'second connection devices');
    // New sessions persist their device ID salt up to 10 seconds after the first device request.
    for (const win of [first, second]) await waitFor(() => readDeviceIdSalt(/** @type {string} */ (win.webContents.session.getStoragePath())), 'persisted device ID salt', 200);
    const secondDevices = /** @type {{kind: string, deviceId: string, label: string}[]} */ (reports.get(second.webContents.id));
    assert.equal(secondDevices.some(device => device.kind === 'audioinput'), false, 'A connection without a microphone gets no microphone names');
    assert.ok(secondDevices.some(device => device.kind === 'audiooutput'), 'Speaker selection is separate from microphone access');
    assert.ok(!secondDevices.some(device => outputs.some(output => output.deviceId === device.deviceId)), 'Device IDs are scoped to each connection');

    Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []).find(item => item.label === 'Settings…')?.click();
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'GLKVM Clean Settings'));
    const settings = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'GLKVM Clean Settings'));
    await waitFor(() => !settings.webContents.isLoading() && run(settings, "document.querySelector('.audio-foreground-input') !== null"));
    // Settings save native UIDs; the page sees them as its own hashed IDs.
    const [mic1, mic2] = inputs;
    const [speaker1, speaker2] = outputs;
    const uids = new Map([[mic1, 'fake_audio_input_1'], [mic2, 'fake_audio_input_2'], [speaker1, 'fake_audio_output_1'], [speaker2, 'fake_audio_output_2']]);
    assert.deepEqual([mic1.label, mic2.label, speaker1.label, speaker2.label], ['Fake Audio Input 1', 'Fake Audio Input 2', 'Fake Audio Output 1', 'Fake Audio Output 2']);
    /** @param {(value: any) => void} edit */
    const save = async edit => {
      const value = await run(settings, 'window.settings.load()');
      edit(value);
      // Same as submitting the form: keep the open page in sync with the saved settings.
      const result = await run(settings, `window.settings.save(${JSON.stringify(value)}).then(result => { if (result.ok) { config = result.config; render(); } return result; })`);
      assert.equal(result.ok, true, result.error);
    };
    const pick = (/** @type {{kind: string, deviceId: string, label: string}} */ device) => ({ uid: /** @type {string} */ (uids.get(device)), label: device.label });
    await save(value => {
      value.devices[0].audio = { foreground: { input: pick(mic1), output: pick(speaker1) }, background: { input: pick(mic2), output: pick(speaker2) } };
    });

    // Focus and settings changes never start a microphone by themselves.
    app.focus({ steal: true }); first.focus();
    await waitFor(() => first.isFocused());
    settings.focus(); await waitFor(() => settings.isFocused());
    first.focus(); await waitFor(() => first.isFocused());
    await waitFor(() => status(first)?.output === speaker1.deviceId && status(first)?.outputState === 'ok', 'foreground speaker');
    assert.equal(status(first)?.input, 'idle');
    assert.equal(first.webContents.isAudioMuted(), false, 'A routed speaker is audible when the app is unmuted');

    // The vendor starts its microphone: foreground device, stable sender track.
    assert.equal(await run(first, 'window.startMic()'), 'live');
    await waitFor(() => status(first)?.input === 'live' && status(first)?.inputDevice === mic1.deviceId, 'foreground microphone');
    assert.equal(await run(first, 'window.playRemote()'), 'playing');
    await waitFor(async () => (await run(first, 'window.sinks()'))[0] === speaker1.deviceId, 'foreground sink');
    await run(first, 'window.setMicEnabled(false)');

    // Background: another app window takes focus; switch the active capture.
    settings.focus(); await waitFor(() => settings.isFocused());
    await waitFor(() => status(first)?.inputDevice === mic2.deviceId && status(first)?.output === speaker2.deviceId && status(first)?.outputState === 'ok', 'background route');
    assert.deepEqual(await run(first, '[window.mic.sender.track === window.mic.track, window.mic.track.readyState, window.mic.track.enabled]'), [true, 'live', false], 'The replaced input keeps the vendor track, sender and mute');
    assert.deepEqual(await run(first, 'window.sinks()'), [speaker2.deviceId]);
    assert.equal(await run(first, 'window.playRemote()'), 'playing');
    assert.deepEqual(await run(first, 'window.sinks()'), [speaker2.deviceId, speaker2.deviceId], 'New elements start on the current speaker');
    await run(first, 'window.setMicEnabled(true)');

    // Rapid transitions settle on the final state.
    for (let i = 0; i < 8; i++) { first.focus(); settings.focus(); }
    first.focus();
    await waitFor(() => first.isFocused());
    await waitFor(() => status(first)?.inputDevice === mic1.deviceId && status(first)?.output === speaker1.deviceId, 'rapid transitions');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(status(first)?.inputDevice, mic1.deviceId);
    assert.deepEqual(await run(first, 'window.sinks()'), [speaker1.deviceId, speaker1.deviceId]);
    assert.equal(await run(first, 'window.mic.track.enabled'), true);

    // Minimized is background even though the window was focused.
    first.minimize();
    await waitFor(() => status(first)?.inputDevice === mic2.deviceId, 'minimized background');
    first.restore();
    await waitFor(() => !first.isMinimized(), 'restored window');
    app.focus({ steal: true }); first.focus();
    await waitFor(() => first.isFocused() && status(first)?.inputDevice === mic1.deviceId, 'restored foreground');

    // Missing devices stay silent and are reported; no fallback to another device.
    const gone = { uid: 'AppleUSBAudioEngine:Unplugged:1', label: 'Unplugged' };
    await save(value => { value.devices[0].audio.foreground = { input: gone, output: gone }; });
    await waitFor(() => status(first)?.input === 'missing' && status(first)?.outputState === 'missing', 'missing devices');
    assert.equal(status(first)?.inputDevice, null, 'No microphone is sending');
    assert.equal(first.webContents.isAudioMuted(), true, 'A missing speaker mutes the window');
    assert.equal(await run(first, 'window.mic.track.readyState'), 'live', 'The vendor track survives for a later replug');
    const shown = await run(settings, `(() => { const select = document.querySelector('.audio-foreground-input'); return { value: select.value, text: select.selectedOptions[0].textContent, status: document.querySelector('.audio-status').textContent }; })()`);
    assert.deepEqual([shown.value, shown.text], [`uid:${gone.uid}`, 'Unplugged — not available'], 'The unavailable choice is retained');
    assert.equal(status(first)?.output, null, 'An unresolved speaker is never sent as the system default');
    assert.match(shown.status, /Selected microphone unavailable/);
    await save(value => { value.devices[0].audio.foreground = { input: 'disabled', output: pick(speaker1) }; });
    await waitFor(() => status(first)?.input === 'disabled' && status(first)?.inputDevice === null && !first.webContents.isAudioMuted(), 'disabled microphone');
    await save(value => { value.devices[0].audio.foreground = { input: pick(mic1), output: pick(speaker1) }; });
    await waitFor(() => status(first)?.input === 'live' && status(first)?.inputDevice === mic1.deviceId, 'microphone returns');

    // Global mute still applies on top of routing.
    await save(value => { value.muted = true; });
    await waitFor(() => first.webContents.isAudioMuted());
    await save(value => { value.muted = false; });
    await waitFor(() => !first.webContents.isAudioMuted());

    // Permission boundaries.
    assert.equal(await run(second, "window.tryMedia({ audio: true })"), 'NotAllowedError', 'No microphone for a connection without one');
    assert.equal(await run(first, "window.tryMedia({ video: true })"), 'NotAllowedError', 'Camera');
    assert.equal(await run(first, "window.tryMedia({ audio: true, video: true })"), 'NotAllowedError', 'Camera with microphone');
    assert.equal(await run(first, `new Promise(resolve => { const frame = document.createElement('iframe'); frame.src = '/frame'; frame.onload = () => frame.contentWindow.navigator.mediaDevices.getUserMedia({ audio: true }).then(() => resolve('granted'), error => resolve(error.name)); document.body.append(frame); })`), 'NotAllowedError', 'Subframe');

    // The vendor stops its microphone: the physical capture is released.
    await run(first, 'window.stopMic()');
    await waitFor(() => status(first)?.input === 'idle' && status(first)?.inputDevice === null, 'stopped microphone');
    settings.focus(); await waitFor(() => settings.isFocused());
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(status(first)?.input, 'idle', 'Focus changes do not restart a stopped microphone');

    // A -> B -> A with slow speaker changes: stale confirmations never unmute.
    await waitFor(() => status(first)?.output === speaker2.deviceId && status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'background speaker');
    await run(first, 'window.delaySinks(800)');
    const startGeneration = /** @type {number} */ (status(first)?.generation);
    first.focus();
    await waitFor(() => (status(first)?.generation ?? 0) > startGeneration && status(first)?.outputState === 'pending', 'route B pending');
    assert.equal(first.webContents.isAudioMuted(), true, 'A changed speaker mutes until confirmed');
    settings.focus(); await waitFor(() => settings.isFocused());
    /** @type {string[]} */
    const leaks = [];
    const transitionStart = Date.now();
    for (;;) {
      const current = status(first);
      if (current && current.generation >= startGeneration + 2 && current.outputState === 'ok' && current.output === speaker2.deviceId) break;
      if (!first.webContents.isAudioMuted()) leaks.push(JSON.stringify(current));
      if (Date.now() - transitionStart > 10000) throw new Error(`Timed out waiting for A -> B -> A: start ${startGeneration}, speakers ${speaker1.deviceId.slice(0, 6)}/${speaker2.deviceId.slice(0, 6)}, focused ${BrowserWindow.getFocusedWindow()?.getTitle()}, sinks ${JSON.stringify(await run(first, 'window.sinks()'))}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual(leaks, [], 'Muted until the final speaker is confirmed');
    assert.ok(Date.now() - transitionStart >= 700, 'The delayed speaker change was observed');
    await waitFor(() => !first.webContents.isAudioMuted(), 'unmuted after confirmation');
    assert.deepEqual(await run(first, 'window.sinks()'), [speaker2.deviceId, speaker2.deviceId]);

    // A new AudioContext renders to no device until the selected speaker is applied.
    assert.deepEqual(await run(first, '(() => { window.lateContext = new AudioContext(); return [typeof window.lateContext.sinkId, window.lateContext.sinkId?.type]; })()'), ['object', 'none']);
    await waitFor(() => run(first, `window.lateContext.sinkId === ${JSON.stringify(speaker2.deviceId)}`), 'new context speaker');
    assert.equal(first.webContents.isAudioMuted(), false);
    await run(first, 'window.delaySinks(0)');

    // A player that cannot use the selected speaker never plays, even detached and paused;
    // the failure is reported and keeps the window muted.
    await run(first, 'window.sinkFail = true');
    assert.equal(await run(first, `(() => { const audio = new Audio(); window.detached = audio; audio.addEventListener('play', () => { window.detachedPlayed = true; }); audio.srcObject = window.toneStream(); return audio.play().then(() => 'playing', error => error.name); })()`), 'NotAllowedError', 'Playback fails closed');
    assert.deepEqual(await run(first, '[window.detached.paused, window.detached.sinkId, !!window.detachedPlayed]'), [true, '', false], 'Never started on the default speaker');
    await waitFor(() => status(first)?.outputState === 'error' && first.webContents.isAudioMuted(), 'speaker failure reported');
    assert.equal(await run(first, `(() => { const audio = document.createElement('audio'); audio.className = 'failing-audio'; document.body.append(audio); audio.srcObject = window.toneStream(); return audio.play().then(() => 'playing', error => error.name); })()`), 'NotAllowedError', 'Attached playback fails closed');
    assert.deepEqual(await run(first, "[document.querySelector('.failing-audio').paused, document.querySelector('.failing-audio').sinkId]"), [true, '']);
    await run(first, "window.sinkFail = false; navigator.mediaDevices.dispatchEvent(new Event('devicechange'))");
    await waitFor(() => status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'speaker recovered');
    assert.equal(await run(first, "window.detached.play().then(() => window.detached.sinkId, error => error.name)"), speaker2.deviceId, 'Plays once routed');

    // A route change while play() waits: playback starts on the newest speaker, which the
    // page confirms for the newest generation.
    await run(first, 'window.delaySinks(1500)');
    await run(first, `(() => { const audio = document.createElement('audio'); window.gated = audio; document.body.append(audio); audio.srcObject = window.toneStream(); audio.addEventListener('play', () => { window.gatedSinkAtPlay = audio.sinkId; }); window.gatedResult = audio.play().then(() => 'playing', error => error.name); })()`);
    const gatedGeneration = /** @type {number} */ (status(first)?.generation);
    first.focus();
    await waitFor(() => (status(first)?.generation ?? 0) > gatedGeneration, 'route change while play waits');
    assert.equal(await run(first, 'window.gatedSinkAtPlay'), undefined, 'Still waiting for the speaker');
    assert.equal(first.webContents.isAudioMuted(), true);
    assert.equal(await run(first, 'window.gatedResult'), 'playing');
    assert.deepEqual(await run(first, '[window.gatedSinkAtPlay, window.gated.sinkId]'), [speaker1.deviceId, speaker1.deviceId], 'Started on the newest speaker only');
    await waitFor(() => status(first)?.output === speaker1.deviceId && status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'newest generation confirmed');
    assert.ok((status(first)?.generation ?? 0) > gatedGeneration);
    await run(first, 'window.delaySinks(0)');

    // A start that bypasses play() (here another frame's native play after the page moved
    // the player to the default speaker) is paused until it is routed again.
    await run(first, `(async () => { const audio = document.createElement('audio'); window.ungated = audio; document.body.append(audio); audio.srcObject = window.toneStream(); await audio.play(); audio.pause(); await audio.setSinkId(''); })()`);
    await waitFor(() => status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'audible before ungated start');
    assert.deepEqual(await run(first, `(async () => {
      const audio = window.ungated;
      const events = []; for (const name of ['play', 'pause']) audio.addEventListener(name, () => events.push(name + ':' + (audio.sinkId ? 'routed' : 'default')));
      document.querySelector('iframe').contentWindow.HTMLMediaElement.prototype.play.call(audio);
      for (let i = 0; i < 50 && (audio.paused || audio.sinkId !== ${JSON.stringify(speaker1.deviceId)}); i++) await new Promise(resolve => setTimeout(resolve, 100));
      return [events.slice(0, 3), audio.paused, audio.sinkId];
    })()`), [['play:default', 'pause:default', 'play:routed'], false, speaker1.deviceId], 'Ungated start paused and resumed on the selected speaker');
    await waitFor(() => status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'routed after ungated start');

    // Clones and native stops: the capture lasts while any derived track is live.
    first.focus(); await waitFor(() => first.isFocused());
    assert.equal(await run(first, 'window.startMic()'), 'live');
    await waitFor(() => status(first)?.input === 'live' && status(first)?.openInputs === 1, 'microphone for clone test');
    await run(first, 'window.mic.clone = window.mic.track.clone(); MediaStreamTrack.prototype.stop.call(window.mic.track)');
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.deepEqual([status(first)?.input, status(first)?.openInputs, await run(first, 'window.mic.clone.readyState')], ['live', 1, 'live'], 'A live clone keeps the capture');
    await run(first, "document.querySelector('iframe').contentWindow.MediaStreamTrack.prototype.stop.call(window.mic.clone)");
    await waitFor(() => status(first)?.input === 'idle' && status(first)?.openInputs === 0, 'capture released after another frame stops the clone');
    assert.equal(await run(first, 'window.startMic()'), 'live');
    await waitFor(() => status(first)?.openInputs === 1, 'second microphone');
    await run(first, 'MediaStreamTrack.prototype.stop.call(window.mic.track)');
    await waitFor(() => status(first)?.input === 'idle' && status(first)?.openInputs === 0, 'capture released after prototype stop');

    // Stream clones (native MediaStream.prototype.clone) own the capture like track clones.
    assert.equal(await run(first, 'window.startMic()'), 'live');
    await waitFor(() => status(first)?.input === 'live' && status(first)?.openInputs === 1, 'microphone for stream clone test');
    assert.deepEqual(await run(first, `(() => { const copy = window.mic.stream.clone(); window.mic.copy = copy; window.mic.copyOfCopy = copy.clone(); const [track] = copy.getTracks(); return [copy.getTracks().length, track.kind, track !== window.mic.track, track.readyState, copy.id !== window.mic.stream.id, window.mic.copyOfCopy.getAudioTracks().length]; })()`), [1, 'audio', true, 'live', true, 1]);
    await run(first, 'window.stopMic()');
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.deepEqual([status(first)?.input, status(first)?.openInputs, await run(first, 'window.mic.copy.getTracks()[0].readyState')], ['live', 1, 'live'], 'A live stream clone keeps the capture after the original stops');
    await run(first, 'window.mic.copy.getTracks()[0].stop()');
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.deepEqual([status(first)?.input, status(first)?.openInputs], ['live', 1], 'A clone of the clone keeps the capture');
    await run(first, "document.querySelector('iframe').contentWindow.MediaStreamTrack.prototype.stop.call(window.mic.copyOfCopy.getTracks()[0])");
    await waitFor(() => status(first)?.input === 'idle' && status(first)?.openInputs === 0, 'capture released after the last stream clone stops');

    // Disabling both profiles suspends the capture; enabling restores it with the page's mute.
    assert.equal(await run(first, 'window.startMic()'), 'live');
    await waitFor(() => status(first)?.inputDevice === mic1.deviceId && status(first)?.openInputs === 1, 'microphone before disabling both');
    await run(first, 'window.setMicEnabled(false)');
    await save(value => { value.devices[0].audio.foreground.input = 'disabled'; value.devices[0].audio.background.input = 'disabled'; });
    await waitFor(() => status(first)?.input === 'disabled' && status(first)?.openInputs === 0, 'both profiles disabled');
    assert.deepEqual(await run(first, '[window.mic.track.readyState, window.mic.track.enabled, window.mic.sender.track === window.mic.track]'), ['live', false, true]);
    await waitFor(() => reports.get(first.webContents.id)?.every(device => device.kind !== 'audioinput'), 'microphone names withdrawn');
    await save(value => { value.devices[0].audio.foreground.input = pick(mic1); value.devices[0].audio.background.input = pick(mic2); });
    await waitFor(() => status(first)?.input === 'live' && status(first)?.inputDevice === mic1.deviceId && status(first)?.openInputs === 1, 'restored microphone');
    assert.deepEqual(await run(first, '[window.mic.track.readyState, window.mic.track.enabled, window.mic.sender.track === window.mic.track]'), ['live', false, true], 'Restoring keeps the page track and its mute');
    await waitFor(() => reports.get(first.webContents.id)?.some(device => device.kind === 'audioinput'), 'microphone names listed again');
    await save(value => { value.devices[1].audio.foreground.input = 'default'; });
    await waitFor(() => reports.get(second.webContents.id)?.some(device => device.kind === 'audioinput'), 'enabling a microphone lists names without reopening');

    // A device change retries a missing microphone without falling back.
    await save(value => { value.devices[0].audio.foreground.input = gone; });
    await waitFor(() => status(first)?.input === 'missing' && status(first)?.openInputs === 0, 'missing before device change');
    await run(first, "navigator.mediaDevices.dispatchEvent(new Event('devicechange'))");
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual([status(first)?.input, status(first)?.inputDevice, status(first)?.openInputs], ['missing', null, 0]);
    await save(value => { value.devices[0].audio.foreground.input = pick(mic1); });
    await waitFor(() => status(first)?.input === 'live' && status(first)?.inputDevice === mic1.deviceId, 'microphone after device change');

    // Disabling while a slower device request is pending releases the old device at
    // once and closes the superseded request when it resolves. This replaces the
    // app's permission handler, so it runs after the permission boundary checks.
    let requests = 0;
    first.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
      const audioOnly = permission === 'media' && 'mediaTypes' in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio';
      if (audioOnly) requests++;
      setTimeout(() => callback(audioOnly), 1500);
    });
    settings.focus(); await waitFor(() => settings.isFocused());
    await waitFor(() => requests === 1, 'pending background microphone request');
    assert.equal(status(first)?.inputDevice, mic1.deviceId, 'The previous device is used until the new one is ready');
    const disabledAt = Date.now();
    await save(value => { value.devices[0].audio.background.input = 'disabled'; });
    await waitFor(() => status(first)?.input === 'disabled' && status(first)?.openInputs === 0, 'immediate disable');
    assert.ok(Date.now() - disabledAt < 1000, 'Disabled before the pending request resolved');
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.deepEqual([status(first)?.input, status(first)?.inputDevice, status(first)?.openInputs], ['disabled', null, 0], 'The superseded request was closed');
    // Same for a choice that cannot be resolved: device A goes silent at once while the
    // request for B is pending, and B is closed when it resolves.
    await save(value => { value.devices[0].audio.background.input = pick(mic1); });
    await waitFor(() => status(first)?.input === 'live' && status(first)?.inputDevice === mic1.deviceId && status(first)?.openInputs === 1, 'background device A live');
    const before = requests;
    await save(value => { value.devices[0].audio.background.input = pick(mic2); });
    await waitFor(() => requests === before + 1, 'pending request for device B');
    assert.equal(status(first)?.inputDevice, mic1.deviceId, 'Device A is used until device B is ready');
    const missingAt = Date.now();
    await save(value => { value.devices[0].audio.background.input = gone; });
    await waitFor(() => status(first)?.input === 'missing' && status(first)?.inputDevice === null && status(first)?.openInputs === 0, 'immediate silence for an unresolved device');
    assert.ok(Date.now() - missingAt < 1000, 'Silent before the pending request resolved');
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.deepEqual([status(first)?.input, status(first)?.inputDevice, status(first)?.openInputs], ['missing', null, 0], 'The request for device B was closed');

    // A route that loses its speaker while the previous speaker is still being checked
    // never applies anything, and never the system default. Both routes reach the page
    // back to back, so the second arrives while the first one's device list is pending.
    await save(value => { value.devices[0].audio.background.output = pick(speaker2); });
    await waitFor(() => status(first)?.output === speaker2.deviceId && status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'background speaker before the race');
    const contents = first.webContents;
    const send = contents.send;
    /** @type {unknown[] | null} */
    let held = null;
    contents.send = (channel, ...args) => {
      if (channel !== 'glkvm:audio-route') return send.call(contents, channel, ...args);
      if (!held && args[0]?.output === speaker1.deviceId) { held = args; return; }
      if (held) send.call(contents, channel, ...held);
      held = null;
      send.call(contents, channel, ...args);
    };
    await run(first, 'window.sinkCalls = []');
    await save(value => { value.devices[0].audio.background.output = pick(speaker1); });
    assert.ok(held, 'The route to the other speaker is held back');
    /** @type {string[]} */
    const raceLeaks = [];
    const watchRace = setInterval(() => { if (!first.webContents.isAudioMuted() && status(first)?.output !== speaker2.deviceId) raceLeaks.push(JSON.stringify(status(first))); }, 5);
    await save(value => { value.devices[0].audio.background.output = gone; });
    contents.send = send;
    await waitFor(() => status(first)?.output === null && status(first)?.outputState === 'missing', 'speaker lost during the device check');
    await new Promise(resolve => setTimeout(resolve, 1000));
    clearInterval(watchRace);
    assert.deepEqual(await run(first, 'window.sinkCalls'), [], 'Nothing was applied while the speaker was unresolved, not even the system default');
    assert.ok((await run(first, 'window.sinks()')).every((/** @type {string} */ sink) => sink === speaker2.deviceId), 'Players keep the previous speaker');
    assert.deepEqual(raceLeaks, [], 'Muted throughout');
    assert.equal(first.webContents.isAudioMuted(), true, 'Still muted while the speaker is missing');
    await save(value => { value.devices[0].audio.background.output = pick(speaker2); });
    await waitFor(() => status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'speaker restored after the race');

    await run(settings, "document.querySelector('#connections-tab').click()");
    await waitFor(() => run(settings, `document.querySelector('.audio-foreground-input').textContent.includes(${JSON.stringify(mic1.label)})`), 'settings device names');
    if (evidence) fs.writeFileSync(path.join(evidence, 'settings-audio.png'), (await settings.webContents.capturePage()).toPNG());
    console.log('PASS: fake-device safety gate, per-connection device scoping, no capture from focus or settings, foreground/background/minimized routing, active microphone replacement with stable vendor track and mute, speaker routing for existing and new elements, rapid transitions, missing devices silent and retained, disabled microphone, global mute, camera/subframe/disabled-connection denial, stop cleanup, delayed A->B->A speaker generations, silent new contexts, fail-closed playback on speaker errors (detached and attached), play waiting across a route change and newest-generation confirmation, ungated start paused until routed, track and stream clone lifecycle with native/other-frame stop, both-profiles-disabled restore with mute and device re-listing, device change without fallback, immediate disable and immediate silence for an unresolved device during a pending device request, speaker lost during the device check applies nothing (no system default) and stays muted');
    app.exit(0);
  } catch (error) {
    console.error(error); console.error('Statuses:', JSON.stringify([...statuses]));
    app.exit(1);
  }
  finally { server.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
