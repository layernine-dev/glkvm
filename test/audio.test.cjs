const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults, validateConfig } = require('../src/config.cjs');
const { prepareConfig } = require('../src/credentials.cjs');
const { defaultAudio, validateAudio, routeFor, mediaPermission, validateDeviceReport, validateAudioStatus, nextRoute, routeChanged, outputRouted } = require('../src/audio.cjs');

const mic = { deviceId: 'a'.repeat(64), label: 'USB Microphone' };
const speaker = { deviceId: 'b'.repeat(64), label: 'Headphones' };
const storage = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (/** @type {string} */ value) => Buffer.from(value), decryptStringAsync: async (/** @type {Buffer} */ value) => ({ result: value.toString() }) };

test('legacy connections migrate with microphones disabled and system output', () => {
  const legacy = defaults();
  delete legacy.devices[0].audio;
  const migrated = validateConfig(legacy);
  assert.deepEqual(migrated.devices[0].audio, defaultAudio());
  assert.equal(migrated.muted, true, 'Global mute is unchanged');
  assert.deepEqual(routeFor(defaultAudio(), true), { inputAllowed: false, input: null, output: '' });
});

test('audio choices are validated and independent per connection and profile', () => {
  const config = defaults();
  config.devices.push({ id: 'lab', name: 'Lab', origin: 'https://lab.test', openAtStartup: false });
  config.devices[0].audio = { foreground: { input: mic, output: speaker }, background: { input: 'disabled', output: 'default' } };
  const saved = validateConfig(config);
  assert.deepEqual(saved.devices[0].audio?.foreground, { input: mic, output: speaker });
  assert.deepEqual(saved.devices[1].audio, defaultAudio());
  const audio = /** @type {import('../src/audio.cjs').AudioSettings} */ (saved.devices[0].audio);
  assert.deepEqual(routeFor(audio, true), { inputAllowed: true, input: mic.deviceId, output: speaker.deviceId });
  assert.deepEqual(routeFor(audio, false), { inputAllowed: true, input: null, output: '' });
  assert.deepEqual(routeFor({ ...audio, background: { input: 'default', output: 'default' } }, false).input, '');
  for (const invalid of [
    { foreground: { input: 'disabled', output: 'disabled' }, background: defaultAudio().background },
    { foreground: { input: { deviceId: 'default', label: 'x' }, output: 'default' }, background: defaultAudio().background },
    { foreground: { input: { deviceId: '../x', label: 'x' }, output: 'default' }, background: defaultAudio().background },
    { foreground: { input: { deviceId: 'abc', label: 'bad\nlabel' }, output: 'default' }, background: defaultAudio().background },
    { foreground: { input: 'default', output: 'default' } },
    'default',
  ]) assert.throws(() => validateAudio(invalid));
});

test('changing a connection address invalidates its origin-scoped device IDs', async () => {
  const previous = validateConfig({ ...defaults(), devices: [{ id: 'glkvm', name: 'GLKVM', origin: 'https://glkvm.local', openAtStartup: true, audio: { foreground: { input: mic, output: speaker }, background: { input: 'default', output: speaker } } }] });
  const renamed = await prepareConfig({ ...previous, devices: [{ ...previous.devices[0], name: 'Office' }] }, previous, storage);
  assert.deepEqual(renamed.devices[0].audio, previous.devices[0].audio, 'Renaming keeps device choices');
  const moved = await prepareConfig({ ...previous, devices: [{ ...previous.devices[0], origin: 'https://other.test' }] }, previous, storage);
  assert.deepEqual(moved.devices[0].audio, { foreground: { input: 'disabled', output: 'default' }, background: { input: 'default', output: 'default' } });
});

test('media permissions allow only the configured viewer main frame', () => {
  const origin = 'https://glkvm.test';
  /** @type {import('../src/audio.cjs').AudioSettings} */
  const audio = { foreground: { input: mic, output: 'default' }, background: { input: 'disabled', output: speaker } };
  const base = { viewer: true, origin, audio, foreground: true };
  const frame = { isMainFrame: true, requestingUrl: `${origin}/#/kvm`, securityOrigin: `${origin}/` };
  /** @param {object} changes */
  const request = (changes = {}) => mediaPermission({ ...base, kind: 'request', permission: 'media', details: { ...frame, mediaTypes: ['audio'] }, ...changes });
  assert.equal(request(), true);
  assert.equal(request({ foreground: false }), false, 'Background profile without a microphone cannot capture');
  assert.equal(request({ details: { ...frame, mediaTypes: ['video'] } }), false, 'Camera');
  assert.equal(request({ details: { ...frame, mediaTypes: ['audio', 'video'] } }), false, 'Camera with microphone');
  assert.equal(request({ details: { ...frame, mediaTypes: [] } }), false, 'Unknown media');
  assert.equal(request({ details: { ...frame, mediaTypes: ['audio'], isMainFrame: false } }), false, 'Subframe');
  assert.equal(request({ details: { ...frame, mediaTypes: ['audio'], requestingUrl: 'https://evil.test/' } }), false, 'Other origin');
  assert.equal(request({ details: { ...frame, mediaTypes: ['audio'], securityOrigin: 'https://evil.test' } }), false, 'Other security origin');
  assert.equal(request({ viewer: false }), false, 'Login helper');
  assert.equal(request({ audio: defaultAudio() }), false, 'Microphone not enabled');
  assert.equal(mediaPermission({ ...base, kind: 'request', permission: 'speaker-selection', details: frame }), false);
  assert.equal(mediaPermission({ ...base, kind: 'request', permission: 'geolocation', details: frame }), false);
  /** @param {string} permission @param {string | undefined} mediaType @param {object} changes */
  const check = (permission, mediaType, changes = {}) => mediaPermission({ ...base, kind: 'check', permission, details: { ...frame, mediaType }, ...changes });
  assert.equal(check('media', 'audio'), true, 'Microphone names for an enabled microphone');
  assert.equal(check('media', 'audio', { audio: defaultAudio() }), false, 'No microphone names while disabled');
  assert.equal(check('speaker-selection', undefined, { audio: defaultAudio() }), true, 'Speaker selection is separate');
  assert.equal(check('media', 'video'), false);
  assert.equal(check('media', 'unknown'), false);
  assert.equal(check('speaker-selection', undefined, { viewer: false }), false);
  assert.equal(check('speaker-selection', undefined, { details: { ...frame, isMainFrame: false } }), false);
  assert.equal(check('media', 'audio', { details: { isMainFrame: true, mediaType: 'audio' } }), false, 'Missing requesting URL');
});

test('device and status reports from pages are validated', () => {
  assert.deepEqual(validateDeviceReport([{ kind: 'audioinput', ...mic }, { kind: 'audiooutput', deviceId: speaker.deviceId, label: 'Head\nphones' }]), { inputs: [mic], outputs: [{ deviceId: speaker.deviceId, label: 'Head phones' }] });
  for (const invalid of [null, {}, [{ kind: 'videoinput', ...mic }], [{ kind: 'audioinput', deviceId: 'default', label: '' }], [{ kind: 'audioinput', deviceId: 5, label: '' }], Array(65).fill({ kind: 'audioinput', ...mic })]) {
    assert.equal(validateDeviceReport(invalid), null);
  }
  const status = { input: 'live', inputDevice: mic.deviceId, openInputs: 1, generation: 3, output: '', outputState: 'ok' };
  assert.deepEqual(validateAudioStatus(status), status);
  assert.deepEqual(validateAudioStatus({ ...status, outputState: 'pending' })?.outputState, 'pending');
  for (const generation of [0, -1, 1.5, '3', undefined]) assert.equal(validateAudioStatus({ ...status, generation }), null);
  for (const openInputs of [-1, 65, 0.5, undefined]) assert.equal(validateAudioStatus({ ...status, openInputs }), null);
  assert.equal(validateAudioStatus({ ...status, input: 'recording' }), null);
  assert.equal(validateAudioStatus({ ...status, output: 'x/y' }), null);
  assert.equal(validateAudioStatus({ ...status, outputState: 'fallback' }), null);
});

test('speaker confirmations unmute only for the current output generation', () => {
  const a = speaker.deviceId;
  const b = 'c'.repeat(64);
  /** @param {string} output @param {number} generation @param {'pending' | 'ok' | 'missing' | 'error'} [outputState] */
  const ack = (output, generation, outputState = 'ok') => ({ input: /** @type {'idle'} */ ('idle'), inputDevice: null, openInputs: 0, generation, output, outputState });
  /** @type {import('../src/audio.cjs').RouteState} */
  let state = { route: null, outputGeneration: 0 };
  const routeA = { inputAllowed: false, input: null, output: a };
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
});
