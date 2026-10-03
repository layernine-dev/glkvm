const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults, validateConfig } = require('../src/config.cjs');
const { prepareConfig } = require('../src/credentials.cjs');
const { defaultAudio, validateAudio, resolveDevice, routeFor, mediaPermission, validateDeviceReport, validateAudioStatus, nextRoute, routeChanged, outputRouted } = require('../src/audio.cjs');
const { browserDeviceId, readDeviceIdSalt, supportedRuntime } = require('../src/device-ids.cjs');
const { parseCatalog, deviceLabels } = require('../src/audio-catalog.cjs');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mic = { uid: 'AppleUSBAudioEngine:Vendor:Mic:1234:1', label: 'USB Microphone' };
const speaker = { uid: 'BuiltInSpeakerDevice', label: 'Headphones' };
const legacyMic = { deviceId: 'a'.repeat(64), label: 'USB Microphone' };
/** Resolves every choice to a fixed ID, as when the page lists it. @param {import('../src/audio.cjs').DeviceChoice} choice */
const listed = choice => `id-${'uid' in choice ? choice.uid.length : choice.deviceId.length}`;
const storage = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (/** @type {string} */ value) => Buffer.from(value), decryptStringAsync: async (/** @type {Buffer} */ value) => ({ result: value.toString() }) };

test('legacy connections migrate with microphones disabled and system output', () => {
  const legacy = defaults();
  delete legacy.devices[0].audio;
  const migrated = validateConfig(legacy);
  assert.deepEqual(migrated.devices[0].audio, defaultAudio());
  assert.equal(migrated.muted, true, 'Global mute is unchanged');
  assert.deepEqual(routeFor(defaultAudio(), true, listed), { inputAllowed: false, input: null, inputMissing: false, output: '' });
});

test('audio choices are validated and independent per connection and profile', () => {
  const config = defaults();
  config.devices.push({ id: 'lab', name: 'Lab', origin: 'https://lab.test', openAtStartup: false });
  config.devices[0].audio = { foreground: { input: mic, output: speaker }, background: { input: 'disabled', output: 'default' } };
  const saved = validateConfig(config);
  assert.deepEqual(saved.devices[0].audio?.foreground, { input: mic, output: speaker });
  assert.deepEqual(saved.devices[1].audio, defaultAudio());
  const audio = /** @type {import('../src/audio.cjs').AudioSettings} */ (saved.devices[0].audio);
  assert.deepEqual(routeFor(audio, true, listed), { inputAllowed: true, input: listed(mic), inputMissing: false, output: listed(speaker) });
  assert.deepEqual(routeFor(audio, false, listed), { inputAllowed: true, input: null, inputMissing: false, output: '' });
  assert.deepEqual(routeFor({ ...audio, background: { input: 'default', output: 'default' } }, false, listed).input, '');
  assert.deepEqual(routeFor(audio, true, () => null), { inputAllowed: true, input: null, inputMissing: true, output: null }, 'Unresolved choices are silent, never the system default');
  assert.deepEqual(validateAudio({ foreground: { input: legacyMic, output: 'default' }, background: defaultAudio().background }).foreground.input, legacyMic, 'Older page device IDs are kept');
  for (const invalid of [
    { foreground: { input: { uid: '', label: 'x' }, output: 'default' }, background: defaultAudio().background },
    { foreground: { input: { uid: 'x'.repeat(257), label: 'x' }, output: 'default' }, background: defaultAudio().background },
    { foreground: { input: { uid: 'bad\u0000uid', label: 'x' }, output: 'default' }, background: defaultAudio().background },
    { foreground: { input: { uid: 5, label: 'x' }, output: 'default' }, background: defaultAudio().background },
    { foreground: { input: 'disabled', output: 'disabled' }, background: defaultAudio().background },
    { foreground: { input: { deviceId: 'default', label: 'x' }, output: 'default' }, background: defaultAudio().background },
    { foreground: { input: { deviceId: '../x', label: 'x' }, output: 'default' }, background: defaultAudio().background },
    { foreground: { input: { deviceId: 'abc', label: 'bad\nlabel' }, output: 'default' }, background: defaultAudio().background },
    { foreground: { input: 'default', output: 'default' } },
    'default',
  ]) assert.throws(() => validateAudio(invalid));
});

test('native device choices survive address changes; they are resolved per origin', async () => {
  const previous = validateConfig({ ...defaults(), devices: [{ id: 'glkvm', name: 'GLKVM', origin: 'https://glkvm.local', openAtStartup: true, audio: { foreground: { input: mic, output: speaker }, background: { input: 'default', output: legacyMic } } }] });
  const renamed = await prepareConfig({ ...previous, devices: [{ ...previous.devices[0], name: 'Office' }] }, previous, storage);
  assert.deepEqual(renamed.devices[0].audio, previous.devices[0].audio, 'Renaming keeps device choices');
  const moved = await prepareConfig({ ...previous, devices: [{ ...previous.devices[0], origin: 'https://other.test' }] }, previous, storage);
  assert.deepEqual(moved.devices[0].audio, previous.devices[0].audio, 'No reset and no fallback to system defaults');
});

test('a native UID maps to the exact Chromium deviceId only when the page lists it', () => {
  const salt = '0123456789ABCDEF0123456789ABCDEF';
  const origin = 'https://glkvm.local';
  // Independent restatement of media_devices_util.cc GetHMACForRawMediaDeviceID.
  const expected = createHmac('sha256', Buffer.from(origin)).update(Buffer.concat([Buffer.from(mic.uid), Buffer.from(salt)])).digest('hex');
  assert.equal(browserDeviceId(origin, mic.uid, salt), expected);
  assert.notEqual(browserDeviceId('https://other.test', mic.uid, salt), expected, 'Origin-scoped');
  assert.notEqual(browserDeviceId(origin, mic.uid, 'F'.repeat(32)), expected, 'Session-scoped');
  const id = (/** @type {string} */ uid) => browserDeviceId(origin, uid, salt);
  const catalog = [{ uid: mic.uid }, { uid: speaker.uid }];
  const reported = { inputs: [{ deviceId: id(mic.uid), label: 'x' }], outputs: [{ deviceId: id(speaker.uid), label: 'x' }] };
  const resolution = { origin, salt, reported, catalog };
  assert.equal(resolveDevice(mic, 'input', resolution), id(mic.uid));
  assert.equal(resolveDevice(speaker, 'output', resolution), id(speaker.uid));
  assert.equal(resolveDevice(mic, 'output', resolution), null, 'Listed for the other direction only');
  assert.equal(resolveDevice(mic, 'input', { ...resolution, salt: null }), null, 'No salt yet');
  assert.equal(resolveDevice(mic, 'input', { ...resolution, reported: null }), null, 'No page report yet');
  assert.equal(resolveDevice(mic, 'input', { ...resolution, salt: 'F'.repeat(32) }), null, 'A rotated salt is detected');
  assert.equal(resolveDevice({ uid: 'Unplugged', label: 'x' }, 'input', resolution), null);
  assert.equal(resolveDevice({ deviceId: id(mic.uid), label: 'Old' }, 'input', resolution), id(mic.uid), 'Legacy ID that is an exact native hash');
  assert.equal(resolveDevice({ ...legacyMic, label: 'USB Microphone' }, 'input', resolution), null, 'Legacy ID without a hash match is never guessed by label');
  assert.equal(resolveDevice({ deviceId: id(mic.uid), label: 'Old' }, 'input', { ...resolution, catalog: [] }), null, 'Legacy needs the native catalog');
});

test('the device ID salt is read from session preferences without guessing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-salt-'));
  try {
    assert.equal(readDeviceIdSalt(directory), null, 'Missing file');
    const write = (/** @type {unknown} */ value) => fs.writeFileSync(path.join(directory, 'Preferences'), typeof value === 'string' ? value : JSON.stringify(value));
    write({ electron: { media: { device_id_salt: '0123456789ABCDEF0123456789ABCDEF' } } });
    assert.equal(readDeviceIdSalt(directory), '0123456789ABCDEF0123456789ABCDEF');
    for (const invalid of ['{', { electron: {} }, { electron: { media: { device_id_salt: '' } } }, { electron: { media: { device_id_salt: 'short' } } }, { electron: { media: { device_id_salt: 5 } } }]) {
      write(invalid); assert.equal(readDeviceIdSalt(directory), null);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  assert.equal(supportedRuntime(/** @type {NodeJS.ProcessVersions} */ ({ electron: '44.5.1', chrome: '152.0.7977.130' })), true);
  assert.equal(supportedRuntime(/** @type {NodeJS.ProcessVersions} */ ({ electron: '45.0.0', chrome: '153.0.0.0' })), false, 'Another runtime must be re-verified');
  assert.equal(require('electron/package.json').version, '44.5.1', 'The installed Electron is the verified one');
});

test('the native catalog is validated and duplicate names are disambiguated', () => {
  const line = JSON.stringify({ devices: [
    { uid: 'A:1', name: 'Headset', input: true, output: false, alive: true, transport: 'USB' },
    { uid: 'B:2', name: 'Headset', input: true, output: false, alive: true, transport: 'Bluetooth' },
    { uid: 'C:3', name: 'Mic', input: true, output: true, alive: false, transport: '' },
  ] });
  const devices = /** @type {import('../src/audio-catalog.cjs').NativeDevice[]} */ (parseCatalog(line));
  assert.equal(devices.length, 3);
  assert.deepEqual([...deviceLabels(devices).values()], ['Headset (USB, A:1)', 'Headset (Bluetooth, B:2)', 'Mic']);
  for (const invalid of ['x', '{}', JSON.stringify({ devices: [{ uid: '', name: 'x', input: true, output: true, alive: true }] }), JSON.stringify({ devices: [{ uid: 'a', name: 'x', input: 'yes', output: true, alive: true }] }), JSON.stringify({ devices: [{ uid: 'a', name: 'x', input: true, output: true, alive: true }, { uid: 'a', name: 'y', input: true, output: true, alive: true }] })]) {
    assert.equal(parseCatalog(invalid), null);
  }
});

test('device labels are unique, valid settings labels and independent of list order', () => {
  // No lone UTF-16 surrogate: a character was not split.
  const wellFormed = (/** @type {string} */ value) => !/\p{Cs}/u.test(value);
  /** @param {string} uid @param {string} name @param {string} [transport] @returns {import('../src/audio-catalog.cjs').NativeDevice} */
  const device = (uid, name, transport = 'USB') => ({ uid, name, input: true, output: false, alive: true, transport });
  /** @param {import('../src/audio-catalog.cjs').NativeDevice[]} devices */
  const check = devices => {
    const labels = deviceLabels(devices);
    assert.equal(new Set(labels.values()).size, devices.length, 'Every label is unique');
    assert.deepEqual([...deviceLabels([...devices].reverse())].sort(), [...labels].sort(), 'Labels do not depend on list order');
    for (const device of devices) {
      const label = /** @type {string} */ (labels.get(device.uid));
      assert.ok(label.length <= 120 && wellFormed(label), label);
      // The selectable choice saves and reloads by UID with its label.
      const audio = { foreground: { input: { uid: device.uid, label }, output: 'default' }, background: defaultAudio().background };
      assert.deepEqual(validateAudio(JSON.parse(JSON.stringify(validateAudio(audio)))), audio);
    }
    return [...labels.values()];
  };
  // Same name, transport and last six UID characters: the shortest distinct end is used.
  assert.deepEqual(check([device('AppleUSBAudioEngine:A:123456', 'Headset'), device('AppleUSBAudioEngine:B:123456', 'Headset')]), ['Headset (USB, …A:123456)', 'Headset (USB, …B:123456)']);
  // UIDs that only differ far from their end are numbered in UID order.
  assert.deepEqual(check([device(`B${'x'.repeat(40)}`, 'Headset'), device(`A${'x'.repeat(40)}`, 'Headset')]), ['Headset (USB, #2)', 'Headset (USB, #1)']);
  // Long names, including characters outside the Basic Multilingual Plane, stay within the limit.
  const long = '🎤'.repeat(100);
  const parsed = /** @type {import('../src/audio-catalog.cjs').NativeDevice[]} */ (parseCatalog(JSON.stringify({ devices: [
    { uid: 'Long:1', name: long, input: true, output: false, alive: true, transport: 'USB' },
    { uid: 'Long:2', name: long, input: true, output: false, alive: true, transport: 'USB' },
    { uid: 'Prefix:1', name: `${'a'.repeat(120)}1`, input: true, output: false, alive: true, transport: '' },
    { uid: 'Prefix:2', name: `${'a'.repeat(120)}2`, input: true, output: false, alive: true, transport: '' },
    { uid: 'Short', name: 'b'.repeat(120), input: true, output: false, alive: true, transport: '' },
  ] })));
  assert.ok(parsed.every(device => device.name.length <= 120 && wellFormed(device.name)));
  const labels = check(parsed);
  assert.ok(labels[0].endsWith('… (USB, Long:1)') && labels[1].endsWith('… (USB, Long:2)'), labels.join(' | '));
  assert.ok(labels[2].endsWith('… (…efix:1)') && labels[3].endsWith('… (…efix:2)'), 'Names that differ only after the limit are told apart');
  assert.equal(labels[4], 'b'.repeat(120), 'A name at the limit is kept whole');
  // A generated label that equals another device's own name is numbered.
  assert.deepEqual(check([device('A:1', 'Headset'), device('B:2', 'Headset'), device('C:3', 'Headset (USB, A:1)')]), ['Headset (USB, A:1)', 'Headset (USB, B:2)', 'Headset (USB, A:1) #2']);
});

test('media permissions allow only the configured viewer main frame', () => {
  const origin = 'https://glkvm.test';
  /** @type {import('../src/audio.cjs').AudioSettings} */
  const audio = { foreground: { input: mic, output: 'default' }, background: { input: 'disabled', output: speaker } };
  /** @param {boolean} foreground @param {import('../src/audio.cjs').AudioSettings} [settings] */
  const route = (foreground, settings = audio) => routeFor(settings, foreground, listed);
  const base = { viewer: true, origin, route: route(true) };
  const frame = { isMainFrame: true, requestingUrl: `${origin}/#/kvm`, securityOrigin: `${origin}/` };
  /** @param {object} changes */
  const request = (changes = {}) => mediaPermission({ ...base, kind: 'request', permission: 'media', details: { ...frame, mediaTypes: ['audio'] }, ...changes });
  assert.equal(request(), true);
  assert.equal(request({ route: route(false) }), false, 'Background profile without a microphone cannot capture');
  assert.equal(request({ route: routeFor(audio, true, () => null) }), false, 'An unresolved microphone cannot capture');
  assert.equal(request({ details: { ...frame, mediaTypes: ['video'] } }), false, 'Camera');
  assert.equal(request({ details: { ...frame, mediaTypes: ['audio', 'video'] } }), false, 'Camera with microphone');
  assert.equal(request({ details: { ...frame, mediaTypes: [] } }), false, 'Unknown media');
  assert.equal(request({ details: { ...frame, mediaTypes: ['audio'], isMainFrame: false } }), false, 'Subframe');
  assert.equal(request({ details: { ...frame, mediaTypes: ['audio'], requestingUrl: 'https://evil.test/' } }), false, 'Other origin');
  assert.equal(request({ details: { ...frame, mediaTypes: ['audio'], securityOrigin: 'https://evil.test' } }), false, 'Other security origin');
  assert.equal(request({ viewer: false }), false, 'Login helper');
  assert.equal(request({ route: route(true, defaultAudio()) }), false, 'Microphone not enabled');
  assert.equal(mediaPermission({ ...base, kind: 'request', permission: 'speaker-selection', details: frame }), false);
  assert.equal(mediaPermission({ ...base, kind: 'request', permission: 'geolocation', details: frame }), false);
  /** @param {string} permission @param {string | undefined} mediaType @param {object} changes */
  const check = (permission, mediaType, changes = {}) => mediaPermission({ ...base, kind: 'check', permission, details: { ...frame, mediaType }, ...changes });
  assert.equal(check('media', 'audio'), true, 'Microphone names for an enabled microphone');
  assert.equal(check('media', 'audio', { route: route(true, defaultAudio()) }), false, 'No microphone names while disabled');
  assert.equal(check('speaker-selection', undefined, { route: route(true, defaultAudio()) }), true, 'Speaker selection is separate');
  assert.equal(check('media', 'video'), false);
  assert.equal(check('media', 'unknown'), false);
  assert.equal(check('speaker-selection', undefined, { viewer: false }), false);
  assert.equal(check('speaker-selection', undefined, { details: { ...frame, isMainFrame: false } }), false);
  assert.equal(check('media', 'audio', { details: { isMainFrame: true, mediaType: 'audio' } }), false, 'Missing requesting URL');
});

test('device and status reports from pages are validated', () => {
  const speakerId = 'b'.repeat(64);
  assert.deepEqual(validateDeviceReport([{ kind: 'audioinput', ...legacyMic }, { kind: 'audiooutput', deviceId: speakerId, label: 'Head\nphones' }]), { inputs: [legacyMic], outputs: [{ deviceId: speakerId, label: 'Head phones' }] });
  for (const invalid of [null, {}, [{ kind: 'videoinput', ...legacyMic }], [{ kind: 'audioinput', deviceId: 'default', label: '' }], [{ kind: 'audioinput', deviceId: 5, label: '' }], Array(65).fill({ kind: 'audioinput', ...legacyMic })]) {
    assert.equal(validateDeviceReport(invalid), null);
  }
  assert.equal(validateAudioStatus({ input: 'missing', inputDevice: null, openInputs: 0, generation: 1, output: null, outputState: 'missing' })?.output, null, 'Unresolved speaker');
  const status = { input: 'live', inputDevice: legacyMic.deviceId, openInputs: 1, generation: 3, output: '', outputState: 'ok' };
  assert.deepEqual(validateAudioStatus(status), status);
  assert.deepEqual(validateAudioStatus({ ...status, outputState: 'pending' })?.outputState, 'pending');
  for (const generation of [0, -1, 1.5, '3', undefined]) assert.equal(validateAudioStatus({ ...status, generation }), null);
  for (const openInputs of [-1, 65, 0.5, undefined]) assert.equal(validateAudioStatus({ ...status, openInputs }), null);
  assert.equal(validateAudioStatus({ ...status, input: 'recording' }), null);
  assert.equal(validateAudioStatus({ ...status, output: 'x/y' }), null);
  assert.equal(validateAudioStatus({ ...status, outputState: 'fallback' }), null);
});

test('speaker confirmations unmute only for the current output generation', () => {
  const a = 'b'.repeat(64);
  const b = 'c'.repeat(64);
  /** @param {string} output @param {number} generation @param {'pending' | 'ok' | 'missing' | 'error'} [outputState] */
  const ack = (output, generation, outputState = 'ok') => ({ input: /** @type {'idle'} */ ('idle'), inputDevice: null, openInputs: 0, generation, output, outputState });
  /** @type {import('../src/audio.cjs').RouteState} */
  let state = { route: null, outputGeneration: 0 };
  /** @type {import('../src/audio.cjs').AudioRoute} */
  const routeA = { inputAllowed: false, input: null, inputMissing: false, output: a };
  const routeB = { ...routeA, output: b };
  state = nextRoute(state, routeA, 1);
  assert.equal(outputRouted(state, null), false, 'Muted until the page confirms');
  assert.equal(outputRouted(state, ack(a, 1, 'pending')), false);
  assert.equal(outputRouted(state, ack(a, 1)), true);
  state = nextRoute(state, routeB, 2);
  assert.equal(outputRouted(state, ack(a, 1)), false, 'Old success does not confirm a new speaker');
  assert.equal(outputRouted(state, ack(b, 2, 'missing')), false);
  state = nextRoute(state, routeA, 3);
  assert.equal(outputRouted(state, ack(a, 1)), false, 'A -> B -> A: a stale confirmation of A is rejected');
  assert.equal(outputRouted(state, ack(b, 2)), false, 'A late confirmation of B is rejected');
  assert.equal(outputRouted(state, ack(a, 3)), true);
  // Input-only changes keep a confirmed speaker valid, so focus changes do not flicker.
  assert.equal(routeChanged(state, { ...routeA, inputAllowed: true, input: '' }), true);
  assert.equal(routeChanged(state, routeA), false);
  state = nextRoute(state, { ...routeA, inputAllowed: true, input: '' }, 4);
  assert.equal(outputRouted(state, ack(a, 3)), true);
  assert.equal(outputRouted(state, ack(a, 4)), true);
  assert.equal(outputRouted(state, ack(a, 5)), false, 'A generation that was never sent is rejected');
  state = nextRoute(state, { ...routeA, output: null }, 6);
  assert.equal(outputRouted(state, { ...ack(a, 6), output: /** @type {string} */ (/** @type {unknown} */ (null)) }), false, 'An unresolved speaker is never confirmed');
  assert.equal(routeChanged(state, { ...routeA, output: null, inputMissing: true }), true);
});
