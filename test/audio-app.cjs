require('./runtime.cjs');
const { app, BrowserWindow, Menu, ipcMain, session } = require('electron');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaults, partitionFor } = require('../src/config.cjs');
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
  // Test control: players the page starts at load, before its first route arrives.
  if (localStorage.getItem('fixture-early-audio')) {
    localStorage.removeItem('fixture-early-audio');
    const player = (attached, autoplay) => {
      const audio = document.createElement('audio'); audio.autoplay = autoplay;
      if (attached) document.body.append(audio);
      audio.srcObject = window.toneStream();
      audio.addEventListener('play', () => { audio.sinkAtPlay ??= audio.sinkId; });
      return audio;
    };
    const video = document.createElement('video'); document.body.append(video);
    video.srcObject = new MediaStream(document.querySelector('#stream-video').srcObject.getVideoTracks());
    window.early = { attached: player(true, false), detached: player(false, false), paused: player(true, false), becomesVideo: player(true, false), losesAudio: player(false, false), autoplay: player(true, true), video, results: {} };
    for (const name of ['attached', 'detached', 'paused', 'becomesVideo', 'losesAudio', 'video']) window.early[name].play().then(() => 'playing', error => error.name).then(value => { window.early.results[name] = value; });
    window.early.paused.pause();
  }
</script></body>`;
const server = createServer((req, res) => {
  // A navigation that never commits: the current page stays.
  if (req.url === '/no-content') { res.statusCode = 204; res.end(); return; }
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
    { id: 'first', name: 'First', origin: `http://127.0.0.1:${address.port}`, openAtStartup: true, audio: { foreground: { input: 'default', output: 'default' }, background: { input: 'disabled', output: 'default' }, startup: { speaker: false, microphone: false } } },
    { id: 'second', name: 'Second', origin: `http://localhost:${address.port}`, openAtStartup: true },
  ];
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(config));
  fakeCatalog.setDevices(fakeCatalog.fakeDevices());
  await app.whenReady();
  // Speaker changes that reach Chromium can be slowed down or failed (see sink-hooks.cjs).
  for (const device of config.devices) session.fromPartition(partitionFor(device)).registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'sink-hooks.cjs') });
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

    // Rapid transitions settle on the final state. macOS can apply queued key-window changes
    // after isFocused() first reports true, so the route must match the focus once it is stable.
    for (let i = 0; i < 8; i++) { first.focus(); settings.focus(); }
    first.focus();
    let focusedTitle = '', stableChecks = 0;
    await waitFor(() => {
      const title = BrowserWindow.getFocusedWindow()?.getTitle() || '';
      stableChecks = title && title === focusedTitle ? stableChecks + 1 : 0;
      focusedTitle = title;
      return stableChecks >= 10;
    }, 'stable focus after rapid transitions');
    const settledForeground = first.isFocused();
    const [settledMic, settledSpeaker] = settledForeground ? [mic1, speaker1] : [mic2, speaker2];
    await waitFor(() => status(first)?.inputDevice === settledMic.deviceId && status(first)?.output === settledSpeaker.deviceId && status(first)?.outputState === 'ok', 'rapid transitions');
    assert.deepEqual(await run(first, 'window.sinks()'), [settledSpeaker.deviceId, settledSpeaker.deviceId]);
    if (!settledForeground) {
      first.focus(); await waitFor(() => first.isFocused());
      await waitFor(() => status(first)?.inputDevice === mic1.deviceId && status(first)?.output === speaker1.deviceId && status(first)?.outputState === 'ok', 'foreground after rapid transitions');
    }
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

    // Global mute still applies on top of a confirmed speaker, and Settings says so.
    const audioStatusText = () => run(settings, "document.querySelector('.audio-status').textContent");
    const muteNotice = /All connections are muted\. To hear this connection, turn off Mute device audio in Controls and save, then turn on Sound on the device page\./;
    // Like the firmware, the stream video is muted and sound plays through separate audio elements.
    await run(first, "document.querySelector('#stream-video').muted = true");
    const saveStatus = () => run(settings, "document.querySelector('#save-status').textContent");
    const submitForm = async () => {
      await run(settings, "document.querySelector('#settings-form').requestSubmit()");
      await waitFor(async () => await saveStatus() === 'Changes saved', 'settings form saved');
    };
    await run(settings, "document.querySelector('#controls-tab').click(); document.querySelector('#muted').click()");
    await submitForm();
    await waitFor(() => first.webContents.isAudioMuted(), 'global mute');
    assert.equal((await run(settings, 'window.settings.load()')).muted, true);
    assert.equal(status(first)?.outputState, 'ok', 'The speaker stays confirmed while globally muted');
    assert.deepEqual(await run(first, 'window.sinks()'), [speaker1.deviceId, speaker1.deviceId], 'Device audio elements stay on the confirmed speaker');
    assert.equal(await run(first, "document.querySelector('#stream-video').muted"), true, 'The app leaves the page video muted');
    await waitFor(async () => muteNotice.test(await audioStatusText()), 'global mute status');
    assert.match(await audioStatusText(), /Microphone sending/, 'The mute notice adds to the live route status');
    if (evidence) { await run(settings, "document.querySelector('#connections-tab').click()"); fs.writeFileSync(path.join(evidence, 'settings-audio-muted.png'), (await settings.webContents.capturePage()).toPNG()); }
    // Choosing a speaker is not unmuting: the saved mute and the notice remain.
    await save(value => { value.devices[0].audio.foreground.output = pick(speaker2); });
    await waitFor(() => status(first)?.output === speaker2.deviceId && status(first)?.outputState === 'ok', 'speaker changed while muted');
    assert.equal(first.webContents.isAudioMuted(), true, 'A speaker choice does not turn off the global mute');
    assert.match(await audioStatusText(), muteNotice);
    // Failures stay visible alongside the mute notice.
    await save(value => { value.devices[0].audio.foreground.output = gone; });
    await waitFor(async () => status(first)?.outputState === 'missing' && /Selected speaker unavailable/.test(await audioStatusText()), 'missing speaker while muted');
    assert.match(await audioStatusText(), muteNotice);
    await save(value => { value.devices[0].audio.foreground.output = pick(speaker1); });
    await waitFor(() => status(first)?.output === speaker1.deviceId && status(first)?.outputState === 'ok', 'speaker restored while muted');
    assert.equal(first.webContents.isAudioMuted(), true);
    // An unsaved switch change applies nothing until saved.
    await run(settings, "document.querySelector('#controls-tab').click(); document.querySelector('#muted').click()");
    assert.equal(await saveStatus(), 'Unsaved changes');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(first.webContents.isAudioMuted(), true, 'An unsaved switch change leaves the window muted');
    // Turning the switch off and saving, as the notice directs, makes the routed speaker audible again.
    await submitForm();
    await waitFor(() => !first.webContents.isAudioMuted(), 'unmuted after the switch is saved');
    assert.equal((await run(settings, 'window.settings.load()')).muted, false);
    await waitFor(async () => !muteNotice.test(await audioStatusText()), 'mute notice cleared');
    assert.match(await audioStatusText(), /Microphone sending/);
    assert.deepEqual(await run(first, "[document.querySelector('#stream-video').muted, ...window.sinks()]"), [true, speaker1.deviceId, speaker1.deviceId], 'Unmuting routes the audio elements and leaves the page video muted');
    await run(settings, "document.querySelector('#connections-tab').click()");

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

    // A start that bypasses play() (here another frame's native play after another frame's
    // native setSinkId moved the player to the default speaker) is paused until it is routed again.
    await run(first, `(async () => { const audio = document.createElement('audio'); window.ungated = audio; document.body.append(audio); audio.srcObject = window.toneStream(); await audio.play(); audio.pause(); await document.querySelector('iframe').contentWindow.HTMLMediaElement.prototype.setSinkId.call(audio, ''); })()`);
    await waitFor(() => status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'audible before ungated start');
    assert.deepEqual(await run(first, `(async () => {
      const audio = window.ungated;
      const events = []; for (const name of ['play', 'pause']) audio.addEventListener(name, () => events.push(name + ':' + (audio.sinkId ? 'routed' : 'default')));
      document.querySelector('iframe').contentWindow.HTMLMediaElement.prototype.play.call(audio);
      for (let i = 0; i < 50 && (audio.paused || audio.sinkId !== ${JSON.stringify(speaker1.deviceId)}); i++) await new Promise(resolve => setTimeout(resolve, 100));
      return [events.slice(0, 3), audio.paused, audio.sinkId];
    })()`), [['play:default', 'pause:default', 'play:routed'], false, speaker1.deviceId], 'Ungated start paused and resumed on the selected speaker');
    await waitFor(() => status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'routed after ungated start');

    // The page may ask only for the selected speaker. Another speaker, the system default, or no
    // output is refused before it reaches Chromium, so a playing player or running context stays
    // on the confirmed speaker.
    const [s1, s2] = [JSON.stringify(speaker1.deviceId), JSON.stringify(speaker2.deviceId)];
    const pageSinks = `(async () => {
      const audio = window.ungated, context = window.lateContext;
      await context.resume();
      const calls = window.sinkCalls.length;
      const attempt = (target, id) => target.setSinkId(id).then(() => 'changed', error => error.name);
      const results = [];
      for (const target of [audio, context]) for (const id of ['', ${s2}, ${s1}, { type: 'none' }]) results.push(await attempt(target, id));
      return [results, window.sinkCalls.length - calls, audio.paused, context.state, audio.sinkId, context.sinkId];
    })()`;
    const refused = 'NotAllowedError';
    assert.deepEqual(await run(first, pageSinks), [[refused, refused, 'changed', refused, refused, refused, 'changed', refused], 0, false, 'running', speaker1.deviceId, speaker1.deviceId], 'Page speaker changes stay on the selected speaker');
    assert.deepEqual([status(first)?.output, status(first)?.outputState, first.webContents.isAudioMuted()], [speaker1.deviceId, 'ok', false]);

    // Competing page requests while the app's change of the playing player to the next speaker
    // is held in Chromium: the previous speaker is refused, and the selected one joins the app's
    // change instead of making its own.
    const competeCalls = /** @type {number} */ (await run(first, 'window.sinkCalls.length'));
    const competeGeneration = status(first)?.generation ?? 0;
    await run(first, 'window.gateSinks(window.ungated)');
    try {
      settings.focus(); await waitFor(() => settings.isFocused());
      await waitFor(() => (status(first)?.generation ?? 0) > competeGeneration && status(first)?.output === speaker2.deviceId, 'next speaker for competing requests');
      await waitFor(() => run(first, 'window.heldSinks(window.ungated).length > 0'), 'app speaker change held in Chromium');
      assert.deepEqual([await run(first, 'window.heldSinks(window.ungated)'), status(first)?.outputState, first.webContents.isAudioMuted()], [[speaker2.deviceId], 'pending', true], 'Muted while the next speaker is pending');
      // Both requests are made while the change is held; the selected one joins it synchronously.
      await run(first, `(() => {
        window.compete = [${s1}, ${s2}].map(id => {
          const entry = { result: undefined };
          entry.promise = window.ungated.setSinkId(id).then(() => 'changed', error => error.name).then(result => (entry.result = result));
          return entry;
        });
      })()`);
      await waitFor(() => run(first, 'window.compete[0].result !== undefined'), 'previous speaker refused while the change is held');
      assert.deepEqual(await run(first, `[window.compete.map(entry => entry.result ?? 'pending'), window.heldSinks(window.ungated), window.sinkCalls.slice(${competeCalls}).filter(call => call.target === window.ungated).map(call => call.id)]`),
        [[refused, 'pending'], [speaker2.deviceId], [speaker2.deviceId]], 'The selected speaker waits for the held change without its own call');
    } finally {
      await run(first, 'window.releaseSinks()');
    }
    assert.deepEqual(await run(first, `(async () => {
      const audio = window.ungated;
      const results = await Promise.all(window.compete.map(entry => entry.promise));
      return [results, audio.paused, audio.sinkId, window.sinkCalls.slice(${competeCalls}).filter(call => call.target === audio).map(call => call.id)];
    })()`), [[refused, 'changed'], false, speaker2.deviceId, [speaker2.deviceId]], 'One speaker change reaches Chromium for the app and the page');
    // App speaker changes still move playing players and running contexts.
    await waitFor(() => status(first)?.output === speaker2.deviceId && status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'background speaker for playing targets');
    assert.deepEqual(await run(first, '[window.ungated.paused, window.ungated.sinkId, window.lateContext.state, window.lateContext.sinkId]'), [false, speaker2.deviceId, 'running', speaker2.deviceId]);
    assert.equal(await run(first, `window.ungated.setSinkId(${s1}).then(() => 'changed', error => error.name)`), refused, 'The previous speaker is refused after the change');

    // B -> A -> B while the page's own request for B is held in Chromium: the request withdraws
    // the confirmation, the window stays muted from then until the final speaker is confirmed,
    // and the requested player never moves to A. Every mute change is recorded in the main
    // process from before A until that confirmation.
    const requestCalls = /** @type {number} */ (await run(first, 'window.sinkCalls.length'));
    const requestGeneration = status(first)?.generation ?? 0;
    /** @param {import('../src/audio.cjs').AudioStatus | undefined} current */
    const finalRequestRoute = current => !!current && current.generation >= requestGeneration + 2 && current.outputState === 'ok' && current.output === speaker2.deviceId;
    const setAudioMuted = first.webContents.setAudioMuted;
    /** @type {boolean[]} */
    const requestMutes = [];
    /** @type {string[]} */
    const requestLeaks = [];
    try {
      await run(first, `(() => { const audio = new Audio(); window.requested = audio; window.gateSinks(audio); window.requestedResult = audio.setSinkId(${s2}).then(() => 'changed', error => error.name); })()`);
      await waitFor(() => status(first)?.outputState === 'pending' && first.webContents.isAudioMuted(), 'page request withdraws the confirmation');
      await waitFor(() => run(first, 'window.heldSinks(window.requested).length > 0'), 'page request held in Chromium');
      first.webContents.setAudioMuted = function (/** @type {boolean} */ muted) {
        const current = status(first);
        requestMutes.push(muted);
        if (!muted && !finalRequestRoute(current)) requestLeaks.push(JSON.stringify(current));
        return setAudioMuted.call(this, muted);
      };
      assert.equal(first.webContents.isAudioMuted(), true, 'Muted when the recording starts');
      first.focus();
      await waitFor(() => (status(first)?.generation ?? 0) > requestGeneration && status(first)?.output === speaker1.deviceId, 'route A while the page request is held');
      settings.focus(); await waitFor(() => settings.isFocused());
      await waitFor(() => (status(first)?.generation ?? 0) >= requestGeneration + 2 && status(first)?.output === speaker2.deviceId, 'final route B while the page request is held');
      assert.deepEqual([await run(first, 'window.heldSinks(window.requested)'), status(first)?.outputState, first.webContents.isAudioMuted()], [[speaker2.deviceId], 'pending', true], 'The page request is still held after B -> A -> B');
      assert.equal(await run(first, 'window.releaseSinks()'), 1);
      await waitFor(() => finalRequestRoute(status(first)) && !first.webContents.isAudioMuted(), `final speaker confirmed after the page request (start ${requestGeneration}, status ${JSON.stringify(status(first))})`);
    } finally {
      first.webContents.setAudioMuted = setAudioMuted;
      await run(first, 'window.releaseSinks()');
    }
    assert.deepEqual(requestLeaks, [], 'Muted until the final speaker is confirmed after the page request');
    assert.equal(requestMutes.at(-1), false, `The confirming unmute was recorded: ${JSON.stringify(requestMutes)}`);
    const [requestResult, requestSink, requestIds] = /** @type {[string, string, string[]]} */ (await run(first, `(async () => [await window.requestedResult, window.requested.sinkId, window.sinkCalls.slice(${requestCalls}).filter(call => call.target === window.requested).map(call => call.id)])()`));
    assert.deepEqual([requestResult, requestSink], ['changed', speaker2.deviceId], 'The page request completes on the selected speaker');
    assert.ok(requestIds.length > 0 && requestIds.every(id => id === speaker2.deviceId), `The requested player never moved to the replaced speaker: ${JSON.stringify(requestIds)}`);
    first.focus(); await waitFor(() => first.isFocused());
    await waitFor(() => status(first)?.output === speaker1.deviceId && status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'foreground speaker for playing targets');
    assert.deepEqual(await run(first, '[window.ungated.sinkId, window.lateContext.sinkId, window.requested.sinkId]'), [speaker1.deviceId, speaker1.deviceId, speaker1.deviceId]);

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

    // A same-document change keeps the page and its confirmed speaker.
    const confirmed = /** @type {import('../src/audio.cjs').AudioStatus} */ (status(first));
    await run(first, "location.hash = '/same-document'");
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual([first.webContents.isAudioMuted(), status(first)], [false, confirmed], 'A same-document change keeps the window audible');

    // A reload replaces the page: muted from the start of the navigation until the new page
    // confirms its speaker, and a late confirmation from the old page is ignored. The new
    // page's first route is held back, so the players it starts at load have to wait for it.
    /** @type {unknown[][]} */
    const heldRoutes = [];
    contents.send = (channel, ...args) => { if (channel === 'glkvm:audio-route') heldRoutes.push(args); else send.call(contents, channel, ...args); };
    /** @type {boolean[]} */
    const navigationMutes = [];
    /** @type {string[]} */
    const reloadLeaks = [];
    const reloaded = () => (status(first)?.generation ?? 0) > confirmed.generation && status(first)?.outputState === 'ok';
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let watchReload;
    contents.once('did-start-navigation', () => {
      navigationMutes.push(contents.isAudioMuted());
      ipcMain.emit('glkvm:audio-status', { sender: contents, senderFrame: contents.mainFrame }, confirmed);
      navigationMutes.push(contents.isAudioMuted());
      watchReload = setInterval(() => { if (!contents.isAudioMuted() && !reloaded()) reloadLeaks.push(JSON.stringify(status(first))); }, 5);
    });
    await run(first, "localStorage.setItem('fixture-early-audio', 'true')");
    contents.reload();
    await waitFor(() => heldRoutes.length > 0, 'held route for the new page');
    await waitFor(() => run(first, "window.early?.results.video === 'playing'"), 'video-only player started before the route');
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      assert.deepEqual(navigationMutes, [true, true], 'Muted when the navigation starts; the old page cannot unmute it');
      assert.equal(contents.isAudioMuted(), true, 'Muted until the new page confirms its speaker');
      assert.deepEqual(await run(first, "['attached', 'detached', 'paused'].map(name => [window.early.results[name], window.early[name].paused, window.early[name].sinkAtPlay])"),
        [[undefined, true, undefined], [undefined, true, undefined], ['AbortError', true, undefined]], 'Audible players wait for the first route and pause cancels before any route arrives');
      await run(first, 'window.early.becomesVideo.srcObject = new MediaStream(window.early.video.srcObject.getVideoTracks())');
      await waitFor(() => run(first, "window.early.results.becomesVideo === 'playing'"), 'video-only replacement starts before the first route');
      const unresolvedRoute = heldRoutes.find(args => /** @type {import('../src/audio.cjs').SentRoute} */ (args[0]).output === null);
      assert.ok(unresolvedRoute, 'The new page first receives an unresolved device route');
      send.call(contents, 'glkvm:audio-route', ...unresolvedRoute);
      await waitFor(() => status(first)?.outputState === 'missing', 'unresolved first route reported');
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.deepEqual(await run(first, "['attached', 'detached'].map(name => [window.early.results[name], window.early[name].paused, window.early[name].sinkAtPlay])"),
        [[undefined, true, undefined], [undefined, true, undefined]], 'An unresolved first route does not start playback on the default speaker');
      await run(first, "window.early.paused.play().then(() => { window.unresolvedPause = 'playing'; }, error => { window.unresolvedPause = error.name; }); window.early.paused.pause();");
      await waitFor(() => run(first, "window.unresolvedPause === 'AbortError'"), 'pause cancels while the speaker remains unresolved');
      await run(first, 'window.early.losesAudio.srcObject.addTrack(window.early.video.srcObject.getVideoTracks()[0]); window.early.losesAudio.srcObject.removeTrack(window.early.losesAudio.srcObject.getAudioTracks()[0])');
      await waitFor(() => run(first, "window.early.results.losesAudio === 'playing'"), 'removing the last audio track starts video while the speaker remains unresolved');
    } finally {
      contents.send = send;
      for (const args of heldRoutes) send.call(contents, 'glkvm:audio-route', ...args);
    }
    await waitFor(() => reloaded() && !contents.isAudioMuted(), 'new page confirmed its speaker');
    clearInterval(watchReload);
    assert.deepEqual(reloadLeaks, [], 'Muted throughout the reload');
    const reloadSpeaker = status(first)?.output;
    assert.ok(outputs.some(output => output.deviceId === reloadSpeaker));
    await waitFor(() => run(first, "window.early.results.attached === 'playing' && window.early.results.detached === 'playing' && window.early.results.paused !== undefined"), 'early players settled');
    assert.deepEqual(await run(first, "['attached', 'detached'].map(name => [window.early.results[name], window.early[name].sinkAtPlay, window.early[name].sinkId])"),
      [['playing', reloadSpeaker, reloadSpeaker], ['playing', reloadSpeaker, reloadSpeaker]], 'Early audible players start only on the selected speaker');
    assert.deepEqual(await run(first, "[window.early.results.paused, window.early.paused.paused, window.early.paused.sinkAtPlay]"), ['AbortError', true, undefined], 'A pause before the route cancels the waiting play()');
    await waitFor(() => run(first, `!window.early.autoplay.paused && window.early.autoplay.sinkId === ${JSON.stringify(reloadSpeaker)}`), 'native autoplay routed');
    assert.equal(await run(first, '!window.early.video.paused'), true, 'The video-only player keeps playing');

    // A navigation that never commits keeps the old page, which is routed again.
    const kept = /** @type {number} */ (status(first)?.generation);
    await run(first, "window.oldPage = true; location.href = '/no-content'");
    await waitFor(() => (status(first)?.generation ?? 0) > kept && status(first)?.outputState === 'ok' && !contents.isAudioMuted(), 'old page routed again after an uncommitted navigation');
    assert.equal(await run(first, 'window.oldPage'), true, 'The page was kept');

    await run(settings, "document.querySelector('#connections-tab').click()");
    await waitFor(() => run(settings, `document.querySelector('.audio-foreground-input').textContent.includes(${JSON.stringify(mic1.label)})`), 'settings device names');

    // Pausing audio switching keeps each connection's selected profile, not its devices.
    const pauseItem = () => Menu.getApplicationMenu()?.items.flatMap(item => item.submenu?.items || []).find(item => item.label.startsWith('Pause Audio Switching'));
    /** @returns {Promise<Record<string, {foreground: boolean}>>} */
    const liveProfiles = async () => (await run(settings, 'window.settings.audio()')).connections;
    const pausedNotice = /Audio switching paused: this connection keeps its focused setting until you resume\./;
    await save(value => { value.devices[0].audio = { foreground: { input: 'disabled', output: pick(speaker1) }, background: { input: 'disabled', output: pick(speaker2) } }; });
    app.focus({ steal: true }); first.focus();
    await waitFor(() => first.isFocused() && status(first)?.output === speaker1.deviceId && status(first)?.outputState === 'ok', 'foreground before pausing');
    assert.equal(pauseItem()?.checked, false);
    pauseItem()?.click();
    assert.equal(pauseItem()?.checked, true, 'The menu shows the pause');
    const pausedGeneration = status(first)?.generation;
    settings.focus(); await waitFor(() => settings.isFocused());
    first.minimize(); await waitFor(() => first.isMinimized(), 'minimized while paused');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual([status(first)?.output, status(first)?.generation, (await liveProfiles()).first.foreground], [speaker1.deviceId, pausedGeneration, true], 'Focus changes keep the focused profile while paused');
    await waitFor(async () => pausedNotice.test(await audioStatusText()), 'paused status in Settings');
    first.restore(); await waitFor(() => !first.isMinimized(), 'restored while paused');
    settings.focus(); await waitFor(() => settings.isFocused());
    // Preferences still apply to the kept profile, and the mute stays independent.
    await save(value => { value.devices[0].audio.foreground.output = pick(speaker2); });
    await waitFor(() => status(first)?.output === speaker2.deviceId && status(first)?.outputState === 'ok', 'kept profile follows its new speaker');
    await save(value => { value.devices[0].audio.foreground.output = pick(speaker1); });
    await waitFor(() => status(first)?.output === speaker1.deviceId && status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'kept profile speaker restored');
    await save(value => { value.muted = true; });
    await waitFor(() => first.webContents.isAudioMuted(), 'global mute while paused');
    assert.equal(status(first)?.output, speaker1.deviceId);
    await save(value => { value.muted = false; });
    await waitFor(() => !first.webContents.isAudioMuted(), 'unmuted while paused');
    // Microphone access and device discovery continue for the kept profile.
    await save(value => { value.devices[0].audio.foreground.input = pick(mic1); });
    await waitFor(() => reports.get(first.webContents.id)?.some(device => device.kind === 'audioinput'), 'microphone names listed while paused');
    assert.equal(status(first)?.input, 'idle', 'Saving a microphone choice does not start capture after the page reload');
    assert.equal(await run(first, 'window.startMic()'), 'live', 'The page starts capture using the kept profile');
    await waitFor(() => status(first)?.input === 'live' && status(first)?.inputDevice === mic1.deviceId && status(first)?.openInputs === 1, 'kept profile opens its microphone');
    await run(first, "navigator.mediaDevices.dispatchEvent(new Event('devicechange'))");
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual([status(first)?.inputDevice, status(first)?.output, (await liveProfiles()).first.foreground], [mic1.deviceId, speaker1.deviceId, true], 'A device change keeps the paused profile');
    await save(value => { value.devices[0].audio.foreground.input = 'disabled'; });
    await waitFor(() => status(first)?.input === 'disabled' && status(first)?.openInputs === 0, 'kept profile microphone disabled');
    // A reload keeps the pause and the kept profile.
    const beforePausedReload = /** @type {number} */ (status(first)?.generation);
    first.webContents.reload();
    await waitFor(() => (status(first)?.generation ?? 0) > beforePausedReload && status(first)?.output === speaker1.deviceId && status(first)?.outputState === 'ok' && !first.webContents.isAudioMuted(), 'focused profile after reload while paused');
    assert.equal(first.isFocused(), false, 'The reloaded viewer is not focused');
    assert.equal(pauseItem()?.checked, true, 'The pause survives a reload');
    // A viewer opened while paused uses the background profile, even when focused.
    second.close();
    await waitFor(() => !BrowserWindow.getAllWindows().some(win => win.getTitle() === 'Second'), 'second closed');
    await run(settings, "window.settings.open('second')");
    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'Second'), 'second reopened');
    const reopened = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Second'));
    await waitFor(() => reopened.isVisible(), 'reopened viewer shown');
    reopened.focus();
    await waitFor(async () => reopened.isFocused() && (await liveProfiles()).second?.foreground === false, 'reopened viewer in background while paused');
    assert.equal((await liveProfiles()).first.foreground, true);
    // Resuming follows native focus at once.
    pauseItem()?.click();
    assert.equal(pauseItem()?.checked, false);
    await waitFor(() => status(first)?.output === speaker2.deviceId && status(first)?.outputState === 'ok', 'background profile after resuming');
    await waitFor(async () => (await liveProfiles()).second?.foreground === true, 'focused viewer in foreground after resuming');
    await waitFor(async () => !pausedNotice.test(await audioStatusText()), 'paused status cleared');
    if (evidence) fs.writeFileSync(path.join(evidence, 'settings-audio.png'), (await settings.webContents.capturePage()).toPNG());
    console.log('PASS: fake-device safety gate, per-connection device scoping, no capture from focus or settings, foreground/background/minimized routing, active microphone replacement with stable vendor track and mute, speaker routing for existing and new elements, rapid transitions, missing devices silent and retained, disabled microphone, global mute, camera/subframe/disabled-connection denial, stop cleanup, delayed A->B->A speaker generations, silent new contexts, fail-closed playback on speaker errors (detached and attached), play waiting across a route change and newest-generation confirmation, ungated start paused until routed, track and stream clone lifecycle with native/other-frame stop, both-profiles-disabled restore with mute and device re-listing, device change without fallback, immediate disable and immediate silence for an unresolved device during a pending device request, speaker lost during the device check applies nothing (no system default) and stays muted, same-document changes stay audible, reload muted from navigation start with stale old-page confirmations ignored, early attached/detached players wait for the delayed first route and start on its speaker, pause cancels a waiting play, native autoplay routed, video-only fast path, uncommitted navigation re-routes the kept page, paused audio switching keeps each focused or background profile across focus, minimize, preference changes, microphone access, device changes, mute and reload, viewers opened while paused use background, and resuming follows native focus');
    app.exit(0);
  } catch (error) {
    console.error(error); console.error('Statuses:', JSON.stringify([...statuses]));
    console.error('Focused window:', JSON.stringify(BrowserWindow.getFocusedWindow()?.getTitle() ?? null));
    app.exit(1);
  }
  finally { server.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
