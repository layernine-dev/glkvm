// Per-connection audio routing policy. Choices name native CoreAudio devices by UID.
// Chromium hashes that UID into a deviceId per session and origin (src/device-ids.cjs);
// a choice is only used once that exact ID is listed by the connection's own page.
// Older settings stored such a page deviceId; it is used only when it is exactly the
// hash of a current native device, otherwise it stays unresolved and silent.
const { browserDeviceId } = require('./device-ids.cjs');
/** @typedef {{uid: string, label: string}} NativeChoice */
/** @typedef {{deviceId: string, label: string}} AudioDevice */
/** @typedef {NativeChoice | AudioDevice} DeviceChoice */
/** @typedef {'disabled' | 'default' | DeviceChoice} InputChoice */
/** @typedef {'default' | DeviceChoice} OutputChoice */
/** @typedef {{input: InputChoice, output: OutputChoice}} AudioProfile */
/** The device page's own Sound and Microphone controls when a video session starts.
 * @typedef {{speaker: boolean, microphone: boolean}} StartupAudio */
/** @typedef {{foreground: AudioProfile, background: AudioProfile, startup: StartupAudio}} AudioSettings */
/** Unresolved choices are silent: input null with inputMissing, output null (never '' = system default).
 * @typedef {{inputAllowed: boolean, input: string | null, inputMissing: boolean, output: string | null}} AudioRoute */
/** @typedef {{inputs: AudioDevice[], outputs: AudioDevice[]}} AudioDevices */
/** @typedef {AudioRoute & {generation: number}} SentRoute */
/** @typedef {{input: 'idle' | 'live' | 'disabled' | 'missing' | 'denied' | 'error', inputDevice: string | null, openInputs: number, generation: number, output: string | null, outputState: 'pending' | 'ok' | 'missing' | 'error'}} AudioStatus */
/** @typedef {{route: SentRoute | null, outputGeneration: number}} RouteState */
/** @typedef {{origin: string, salt: string | null, reported: AudioDevices | null, catalog: {uid: string}[]}} Resolution */
/** @typedef {'waiting' | 'applied' | 'unchanged' | 'unsupported' | 'unavailable' | 'denied' | 'error'} StartupState */
/** @typedef {StartupAudio & {speakerState: StartupState, microphoneState: StartupState}} StartupStatus */

const deviceIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const reservedIds = new Set(['default', 'communications']);
const inputStates = ['idle', 'live', 'disabled', 'missing', 'denied', 'error'];
const outputStates = ['pending', 'ok', 'missing', 'error'];
const startupStates = ['waiting', 'applied', 'unchanged', 'unsupported', 'unavailable', 'denied', 'error'];

/** @returns {AudioSettings} */
function defaultAudio() {
  return { foreground: { input: 'disabled', output: 'default' }, background: { input: 'disabled', output: 'default' }, startup: { speaker: false, microphone: false } };
}

/** @param {unknown} id */
function isDeviceId(id) { return typeof id === 'string' && deviceIdPattern.test(id) && !reservedIds.has(id); }
/** @param {unknown} label */
function isLabel(label) { return typeof label === 'string' && label.length <= 120 && !/[\x00-\x1f\x7f]/.test(label); }
/** @param {unknown} uid */
function isUid(uid) { return typeof uid === 'string' && uid.length >= 1 && uid.length <= 256 && !/[\x00-\x1f\x7f]/.test(uid); }

/** @param {unknown} value @param {boolean} input @returns {InputChoice} */
function validateChoice(value, input) {
  if (value === 'default' || (input && value === 'disabled')) return value;
  const choice = /** @type {Record<string, unknown> | null} */ (value && typeof value === 'object' ? value : null);
  if (!choice || !isLabel(choice.label)) throw new Error('Invalid audio device setting.');
  const label = /** @type {string} */ (choice.label);
  if ('uid' in choice) {
    if (!isUid(choice.uid)) throw new Error('Invalid audio device setting.');
    return { uid: /** @type {string} */ (choice.uid), label };
  }
  if (!isDeviceId(choice.deviceId)) throw new Error('Invalid audio device setting.');
  return { deviceId: /** @type {string} */ (choice.deviceId), label };
}

/** Older settings start with sound and microphone off; nothing is inferred from device choices.
 * @param {unknown} value @returns {StartupAudio} */
function validateStartup(value) {
  if (value === undefined) return { speaker: false, microphone: false };
  const startup = /** @type {Record<string, unknown> | null} */ (value && typeof value === 'object' ? value : null);
  if (!startup || typeof startup.speaker !== 'boolean' || typeof startup.microphone !== 'boolean') throw new Error('Invalid startup audio settings.');
  return { speaker: startup.speaker, microphone: startup.microphone };
}

/** Older settings have no audio profiles: keep the microphone disabled and use the system output.
 * @param {unknown} value @returns {AudioSettings} */
function validateAudio(value) {
  if (value === undefined) return defaultAudio();
  const input = /** @type {AudioSettings | null} */ (value && typeof value === 'object' ? value : null);
  if (!input) throw new Error('Invalid audio settings.');
  /** @param {unknown} profile @returns {AudioProfile} */
  const validateProfile = profile => {
    const item = /** @type {AudioProfile | null} */ (profile && typeof profile === 'object' ? profile : null);
    if (!item) throw new Error('Invalid audio settings.');
    return { input: validateChoice(item.input, true), output: /** @type {OutputChoice} */ (validateChoice(item.output, false)) };
  };
  return { foreground: validateProfile(input.foreground), background: validateProfile(input.background), startup: validateStartup(input.startup) };
}

/** @param {AudioSettings} audio */
function inputAllowed(audio) { return audio.foreground.input !== 'disabled' || audio.background.input !== 'disabled'; }

/** The page's deviceId for a choice, or null while it cannot be proven: no salt yet,
 * no page report, a legacy ID that is not a current device's hash, or not listed.
 * @param {DeviceChoice} choice @param {'input' | 'output'} kind @param {Resolution} resolution @returns {string | null} */
function resolveDevice(choice, kind, { origin, salt, reported, catalog }) {
  if (!salt || !reported) return null;
  const uid = 'uid' in choice ? choice.uid : catalog.find(device => browserDeviceId(origin, device.uid, salt) === choice.deviceId)?.uid;
  if (!uid) return null;
  const id = browserDeviceId(origin, uid, salt);
  return (kind === 'input' ? reported.inputs : reported.outputs).some(device => device.deviceId === id) ? id : null;
}

/** @param {AudioSettings} audio @param {boolean} foreground @param {(choice: DeviceChoice, kind: 'input' | 'output') => string | null} resolve @returns {AudioRoute} */
function routeFor(audio, foreground, resolve) {
  const profile = foreground ? audio.foreground : audio.background;
  const input = profile.input === 'disabled' ? null : profile.input === 'default' ? '' : resolve(profile.input, 'input');
  return { inputAllowed: inputAllowed(audio), input, inputMissing: profile.input !== 'disabled' && input === null, output: profile.output === 'default' ? '' : resolve(profile.output, 'output') };
}

/** @param {unknown} value @param {string} origin */
function sameOrigin(value, origin) {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; } catch { return false; }
}

/**
 * Media permission policy for a connection's visible viewer main frame.
 * Checks expose device IDs: speakers for output selection, microphones only once
 * a microphone is enabled. Capture requests additionally need the current profile's
 * resolved microphone. Camera, unknown media, subframes and login helpers are always denied.
 * @param {{kind: 'check' | 'request', permission: string, details: {isMainFrame?: boolean, requestingUrl?: string, securityOrigin?: string, mediaType?: string, mediaTypes?: unknown}, viewer: boolean, origin?: string, route?: AudioRoute}} request
 */
function mediaPermission({ kind, permission, details, viewer, origin, route }) {
  if (!viewer || !origin || !route || details.isMainFrame !== true || !sameOrigin(details.requestingUrl, origin)) return false;
  if (details.securityOrigin !== undefined && !sameOrigin(details.securityOrigin, origin)) return false;
  if (permission === 'speaker-selection') return kind === 'check';
  if (permission !== 'media' || !route.inputAllowed) return false;
  if (kind === 'check') return details.mediaType === 'audio';
  const types = details.mediaTypes;
  return Array.isArray(types) && types.length === 1 && types[0] === 'audio' && route.input !== null;
}

/** @param {unknown} value @returns {AudioDevices | null} */
function validateDeviceReport(value) {
  if (!Array.isArray(value) || value.length > 64) return null;
  /** @type {AudioDevices} */
  const result = { inputs: [], outputs: [] };
  for (const item of value) {
    if (!item || typeof item !== 'object' || !isDeviceId(item.deviceId) || typeof item.label !== 'string') return null;
    const device = { deviceId: item.deviceId, label: item.label.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120) };
    if (item.kind === 'audioinput') result.inputs.push(device);
    else if (item.kind === 'audiooutput') result.outputs.push(device);
    else return null;
  }
  return result;
}

/** @param {unknown} value @returns {AudioStatus | null} */
function validateAudioStatus(value) {
  const status = /** @type {AudioStatus | null} */ (value && typeof value === 'object' ? value : null);
  if (!status || !inputStates.includes(status.input) || !outputStates.includes(status.outputState)) return null;
  if (status.inputDevice !== null && status.inputDevice !== '' && !isDeviceId(status.inputDevice)) return null;
  if (status.output !== null && status.output !== '' && !isDeviceId(status.output)) return null;
  if (!Number.isInteger(status.generation) || status.generation < 1 || !Number.isInteger(status.openInputs) || status.openInputs < 0 || status.openInputs > 64) return null;
  return { input: status.input, inputDevice: status.inputDevice, openInputs: status.openInputs, generation: status.generation, output: status.output, outputState: status.outputState };
}

/** @param {unknown} value @returns {StartupStatus | null} */
function validateStartupStatus(value) {
  const status = /** @type {StartupStatus | null} */ (value && typeof value === 'object' ? value : null);
  if (!status || typeof status.speaker !== 'boolean' || typeof status.microphone !== 'boolean' || !startupStates.includes(status.speakerState) || !startupStates.includes(status.microphoneState)) return null;
  return { speaker: status.speaker, microphone: status.microphone, speakerState: status.speakerState, microphoneState: status.microphoneState };
}

/** Prepare the next route for a page. A changed speaker starts a new output generation,
 * so confirmations of an earlier route (including the same speaker before A → B → A)
 * cannot unmute the window.
 * @param {RouteState} state @param {AudioRoute} next @param {number} generation @returns {RouteState} */
function nextRoute(state, next, generation) {
  const outputChanged = !state.route || state.route.output !== next.output;
  return { route: { ...next, generation }, outputGeneration: outputChanged ? generation : state.outputGeneration };
}
/** @param {RouteState} state @param {AudioRoute} next */
function routeChanged(state, next) {
  return !state.route || state.route.inputAllowed !== next.inputAllowed || state.route.input !== next.input || state.route.inputMissing !== next.inputMissing || state.route.output !== next.output;
}
/** The page confirmed the current speaker for a generation since it was last changed.
 * @param {RouteState} state @param {AudioStatus | null} status */
function outputRouted(state, status) {
  return !!state.route && state.route.output !== null && !!status && status.outputState === 'ok' && status.output === state.route.output
    && status.generation >= state.outputGeneration && status.generation <= state.route.generation;
}

module.exports = { defaultAudio, validateAudio, inputAllowed, resolveDevice, routeFor, mediaPermission, validateDeviceReport, validateAudioStatus, validateStartupStatus, nextRoute, routeChanged, outputRouted };
