// The Mac's audio devices, from the bundled read-only CoreAudio catalog
// (native/audio-catalog.swift). Listing needs no microphone permission and never
// opens a device, so it works without any connection window.
const { spawn } = require('node:child_process');
const path = require('node:path');

/** @typedef {{uid: string, name: string, input: boolean, output: boolean, alive: boolean, transport: string}} NativeDevice */

/** Choice labels are saved with the choice, so they stay within the settings limit (src/audio.cjs). */
const maxLabel = 120;

/** Shortens text to at most `max` UTF-16 units without splitting a character.
 * @param {string} value @param {number} max */
function fit(value, max) {
  if (value.length <= max) return value;
  let result = '';
  for (const char of value) { if (result.length + char.length > max - 1) break; result += char; }
  return `${result}…`;
}

/** @param {unknown} value @returns {string | null} */
function text(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

/** @param {unknown} line @returns {NativeDevice[] | null} */
function parseCatalog(line) {
  let value;
  try { value = JSON.parse(String(line)); } catch { return null; }
  if (!value || !Array.isArray(value.devices) || value.devices.length > 128) return null;
  /** @type {NativeDevice[]} */
  const devices = [];
  const seen = new Set();
  for (const item of value.devices) {
    const uid = text(item?.uid);
    if (!uid || seen.has(uid) || typeof item.input !== 'boolean' || typeof item.output !== 'boolean' || typeof item.alive !== 'boolean') return null;
    seen.add(uid);
    devices.push({ uid, name: fit(text(item.name) || uid, maxLabel), input: item.input, output: item.output, alive: item.alive, transport: fit(text(item.transport) || '', 32) });
  }
  return devices;
}

/** Runs the catalog in watch mode while needed and reports each snapshot.
 * @param {string} executable @param {(devices: NativeDevice[]) => void} onChange */
function watchCatalog(executable, onChange) {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let restarts = 0;
  const start = () => {
    const current = spawn(executable, ['--watch'], { stdio: ['pipe', 'pipe', 'ignore'] });
    child = current;
    let buffer = '';
    current.stdout?.setEncoding('utf8');
    current.stdout?.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1 << 20) { current.kill(); return; }
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const devices = parseCatalog(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (devices) { restarts = 0; onChange(devices); }
      }
    });
    current.on('error', () => {});
    current.on('exit', () => {
      if (child !== current) return;
      child = null;
      // A crashed catalog restarts a few times; until then the last list stays.
      if (restarts++ < 3) setTimeout(() => { if (!child && running) start(); }, 1000);
    });
  };
  let running = false;
  return {
    start() { if (running) return; running = true; restarts = 0; if (!child) start(); },
    stop() { running = false; const current = child; child = null; current?.stdin?.end(); current?.kill(); },
  };
}

/** Choice labels, unique within the list: a duplicate name gains its connection type
 * and the shortest end of its UID that tells the duplicates apart. Choices are saved
 * by UID; the label only depends on the current list, never on its order.
 * @param {NativeDevice[]} devices @returns {Map<string, string>} */
function deviceLabels(devices) {
  const sorted = [...devices].sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
  /** @type {Map<string, NativeDevice[]>} */
  const groups = new Map();
  for (const device of sorted) {
    const base = fit(device.name, maxLabel);
    groups.set(base, [...(groups.get(base) || []), device]);
  }
  /** @param {string} name @param {string} detail */
  const withDetail = (name, detail) => { const suffix = ` (${detail})`; return fit(name, maxLabel - suffix.length) + suffix; };
  /** @param {NativeDevice} device @param {number} length */
  const tail = (device, length) => { const chars = [...device.uid]; return `${chars.length > length ? '…' : ''}${chars.slice(-length).join('')}`; };
  /** @type {Map<string, string>} */
  const candidates = new Map();
  for (const [base, group] of groups) {
    if (group.length === 1) { candidates.set(group[0].uid, base); continue; }
    const distinct = (/** @type {number} */ length) => new Set(group.map(device => tail(device, length))).size === group.length;
    let length = 6;
    while (length < 24 && !distinct(length)) length++;
    const unique = distinct(length);
    group.forEach((device, index) => candidates.set(device.uid, withDetail(device.name, [device.transport, unique ? tail(device, length) : `#${index + 1}`].filter(Boolean).join(', '))));
  }
  // A generated label can still equal another device's own name; number the later ones.
  /** @type {Set<string>} */
  const used = new Set();
  /** @type {Map<string, string>} */
  const labels = new Map();
  for (const device of sorted) {
    const candidate = /** @type {string} */ (candidates.get(device.uid));
    let label = candidate;
    for (let index = 2; used.has(label); index++) { const suffix = ` #${index}`; label = fit(candidate, maxLabel - suffix.length) + suffix; }
    used.add(label); labels.set(device.uid, label);
  }
  return new Map(devices.map(device => [device.uid, /** @type {string} */ (labels.get(device.uid))]));
}

/** @param {string} resourcesPath */
function catalogPath(resourcesPath) { return path.join(resourcesPath, 'glkvm-audio-catalog'); }

module.exports = { parseCatalog, watchCatalog, deviceLabels, catalogPath };
