const { defaultKeyboard, validateKeyboard } = require('./keyboard.cjs');
const fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const { scales } = require('./window-sizes.cjs');
const { devices } = require('./devices.cjs');
const { defaultAudio, validateAudio } = require('./audio.cjs');

/** @typedef {{id: string, name: string, origin: string, openAtStartup: boolean, startMode?: string, windowScale?: number | null, encryptedPassword?: string, audio?: import('./audio.cjs').AudioSettings}} Device */
/** @typedef {{version: number, devices: Device[], controlEnabled: boolean, muted: boolean, keyboard?: ReturnType<typeof defaultKeyboard>}} Config */
/** @returns {Config} */
function defaults() {
  return { keyboard: defaultKeyboard(), version: 1, devices: devices.map(device => ({ ...device, openAtStartup: true, startMode: 'window-decoration-less', windowScale: null, audio: defaultAudio() })), controlEnabled: true, muted: true };
}

/** @param {unknown} value @returns {Config} */
function validateConfig(value) {
  if (!value || typeof value !== 'object') throw new Error('Settings must be an object.');
  const input = /** @type {Config} */ (value);
  if (input.version !== 1) throw new Error('This settings version is not supported.');
  if (!Array.isArray(input.devices) || input.devices.length > 32) throw new Error('Add up to 32 connections.');
  if (typeof input.controlEnabled !== 'boolean' || typeof input.muted !== 'boolean') throw new Error('Invalid control or audio setting.');
  const ids = new Set();
  const origins = new Set();
  const normalized = input.devices.map(device => {
    if (!device || typeof device.name !== 'string' || !device.name.trim() || device.name.trim().length > 60 || /[\x00-\x1f\x7f]/.test(device.name)) throw new Error('Each connection needs a name of 1–60 characters.');
    const id = device.id || randomUUID();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id) || ids.has(id)) throw new Error('Connection IDs must be unique.');
    ids.add(id);
    let url;
    try { url = new URL(device.origin); } catch { throw new Error(`Enter a full http:// or https:// address for ${device.name}.`); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Use only the device address for ${device.name}, without a path, password, or query.`);
    if (origins.has(url.origin)) throw new Error('This device address is already in the list.');
    origins.add(url.origin);
    if (typeof device.openAtStartup !== 'boolean') throw new Error('Invalid startup setting.');
    const startMode = device.startMode === undefined ? 'window-decoration-less' : device.startMode;
    const windowScale = device.windowScale === undefined ? null : device.windowScale;
    if (!['window-decoration-less', 'options-enabled'].includes(startMode)) throw new Error('Invalid start mode.');
    if (windowScale !== null && !scales.includes(windowScale)) throw new Error('Invalid window resolution.');
    if (device.encryptedPassword !== undefined && (typeof device.encryptedPassword !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(device.encryptedPassword) || device.encryptedPassword.length > 32768)) throw new Error('Invalid encrypted password.');
    return { ...(device.encryptedPassword ? { encryptedPassword: device.encryptedPassword } : {}), id, name: device.name.trim(), origin: url.origin, startMode, windowScale, openAtStartup: device.openAtStartup, audio: validateAudio(device.audio) };
  });
  return { keyboard: validateKeyboard(input.keyboard), version: 1, devices: normalized, controlEnabled: input.controlEnabled, muted: input.muted };
}

/** @param {string} file */
function readConfig(file) {
  try { return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return defaults();
    throw error;
  }
}

/** @param {string} file @param {unknown} value */
function writeConfig(file, value) {
  const config = validateConfig(value);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return config;
}

/** @param {{id: string, origin: string}} device */
function partitionFor(device) {
  const hash = createHash('sha256').update(device.origin).digest('hex').slice(0, 16);
  return `persist:glkvm-${device.id}-${hash}`;
}
module.exports = { defaults, validateConfig, readConfig, writeConfig, partitionFor };
