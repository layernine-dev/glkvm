// Per-connection audio routing policy. Device IDs are scoped by Chromium to the
// connection's session and origin, so they are only meaningful for that connection.
/** @typedef {{deviceId: string, label: string}} AudioDevice */
/** @typedef {'disabled' | 'default' | AudioDevice} InputChoice */
/** @typedef {'default' | AudioDevice} OutputChoice */
/** @typedef {{input: InputChoice, output: OutputChoice}} AudioProfile */
/** @typedef {{foreground: AudioProfile, background: AudioProfile}} AudioSettings */
/** @typedef {{inputAllowed: boolean, input: string | null, output: string}} AudioRoute */
/** @typedef {{inputs: AudioDevice[], outputs: AudioDevice[]}} AudioDevices */
/** @typedef {AudioRoute & {generation: number}} SentRoute */
/** @typedef {{input: 'idle' | 'live' | 'disabled' | 'missing' | 'denied' | 'error', inputDevice: string | null, openInputs: number, generation: number, output: string, outputState: 'pending' | 'ok' | 'missing' | 'error'}} AudioStatus */
/** @typedef {{route: SentRoute | null, outputGeneration: number}} RouteState */

const deviceIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const reservedIds = new Set(['default', 'communications']);
const inputStates = ['idle', 'live', 'disabled', 'missing', 'denied', 'error'];
const outputStates = ['pending', 'ok', 'missing', 'error'];

/** @returns {AudioSettings} */
function defaultAudio() {
  return { foreground: { input: 'disabled', output: 'default' }, background: { input: 'disabled', output: 'default' } };
}

/** @param {unknown} id */
function isDeviceId(id) { return typeof id === 'string' && deviceIdPattern.test(id) && !reservedIds.has(id); }
/** @param {unknown} label */
function isLabel(label) { return typeof label === 'string' && label.length <= 120 && !/[\x00-\x1f\x7f]/.test(label); }

/** @param {unknown} value @param {boolean} input @returns {InputChoice} */
function validateChoice(value, input) {
  if (value === 'default' || (input && value === 'disabled')) return value;
  const choice = /** @type {AudioDevice | null} */ (value && typeof value === 'object' ? value : null);
  if (!choice || !isDeviceId(choice.deviceId) || !isLabel(choice.label)) throw new Error('Invalid audio device setting.');
  return { deviceId: choice.deviceId, label: choice.label };
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
  return { foreground: validateProfile(input.foreground), background: validateProfile(input.background) };
}

/** Device IDs are origin-scoped. A new address keeps only explicit non-device choices.
 * @param {AudioSettings} audio @returns {AudioSettings} */
function resetAudioDevices(audio) {
  /** @param {AudioProfile} profile @returns {AudioProfile} */
  const reset = profile => ({ input: typeof profile.input === 'object' ? 'disabled' : profile.input, output: 'default' });
  return { foreground: reset(audio.foreground), background: reset(audio.background) };
}

/** @param {AudioSettings} audio */
function inputAllowed(audio) { return audio.foreground.input !== 'disabled' || audio.background.input !== 'disabled'; }

/** @param {AudioSettings} audio @param {boolean} foreground @returns {AudioRoute} */
function routeFor(audio, foreground) {
  const profile = foreground ? audio.foreground : audio.background;
  const input = profile.input === 'disabled' ? null : profile.input === 'default' ? '' : profile.input.deviceId;
  return { inputAllowed: inputAllowed(audio), input, output: profile.output === 'default' ? '' : profile.output.deviceId };
}

/** @param {unknown} value @param {string} origin */
function sameOrigin(value, origin) {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; } catch { return false; }
}

/**
 * Media permission policy for a connection's visible viewer main frame.
 * Checks expose device names: speakers for output selection, microphones only once
 * a microphone is enabled. Capture requests additionally need the current profile's
 * microphone. Camera, unknown media, subframes and login helpers are always denied.
 * @param {{kind: 'check' | 'request', permission: string, details: {isMainFrame?: boolean, requestingUrl?: string, securityOrigin?: string, mediaType?: string, mediaTypes?: unknown}, viewer: boolean, origin?: string, audio?: AudioSettings, foreground: boolean}} request
 */
function mediaPermission({ kind, permission, details, viewer, origin, audio, foreground }) {
  if (!viewer || !origin || !audio || details.isMainFrame !== true || !sameOrigin(details.requestingUrl, origin)) return false;
  if (details.securityOrigin !== undefined && !sameOrigin(details.securityOrigin, origin)) return false;
  if (permission === 'speaker-selection') return kind === 'check';
  if (permission !== 'media' || !inputAllowed(audio)) return false;
  if (kind === 'check') return details.mediaType === 'audio';
  const types = details.mediaTypes;
  return Array.isArray(types) && types.length === 1 && types[0] === 'audio' && routeFor(audio, foreground).input !== null;
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
  if (status.output !== '' && !isDeviceId(status.output)) return null;
  if (!Number.isInteger(status.generation) || status.generation < 1 || !Number.isInteger(status.openInputs) || status.openInputs < 0 || status.openInputs > 64) return null;
  return { input: status.input, inputDevice: status.inputDevice, openInputs: status.openInputs, generation: status.generation, output: status.output, outputState: status.outputState };
}

/** Prepare the next route for a page. A changed speaker starts a new output generation,
 * so confirmations of an earlier route (including the same speaker before A → B → A)
 * cannot unmute the window.
 * @param {RouteState} state @param {AudioRoute} next @param {number} generation @returns {RouteState} */
function nextRoute(state, next, generation) {
  const outputChanged = !state.route || state.route.output !== next.output;
  return { route: { ...next, generation }, outputGeneration: outputChanged ? generation : state.outputGeneration };
}
/** @param {RouteState} state @param {Pick<AudioRoute, 'inputAllowed' | 'input' | 'output'>} next */
function routeChanged(state, next) {
  return !state.route || state.route.inputAllowed !== next.inputAllowed || state.route.input !== next.input || state.route.output !== next.output;
}
/** The page confirmed the current speaker for a generation since it was last changed.
 * @param {RouteState} state @param {AudioStatus | null} status */
function outputRouted(state, status) {
  return !!state.route && !!status && status.outputState === 'ok' && status.output === state.route.output
    && status.generation >= state.outputGeneration && status.generation <= state.route.generation;
}

module.exports = { defaultAudio, validateAudio, resetAudioDevices, inputAllowed, routeFor, mediaPermission, validateDeviceReport, validateAudioStatus, nextRoute, routeChanged, outputRouted };
