// Replaces the native CoreAudio catalog with a scripted list. Its UIDs are the raw IDs
// of Chromium's fake devices (--use-fake-device-for-media-stream), so resolution runs
// the real hashing against real page enumeration without touching audio hardware.
// Load before src/main.cjs.
const catalog = require('../src/audio-catalog.cjs');
/** @typedef {import('../src/audio-catalog.cjs').NativeDevice} NativeDevice */
/** @type {NativeDevice[]} */
let devices = [];
/** @type {Set<(devices: NativeDevice[]) => void>} */
const listeners = new Set();
let running = false;
catalog.watchCatalog = (_executable, onChange) => ({
  start() { if (running) return; running = true; listeners.add(onChange); setImmediate(() => { if (running) onChange(devices); }); },
  stop() { running = false; listeners.delete(onChange); },
});
/** @param {string} uid @param {string} name @param {Partial<NativeDevice>} [extra] @returns {NativeDevice} */
const device = (uid, name, extra = {}) => ({ uid, name, input: uid.includes('input'), output: uid.includes('output'), alive: true, transport: 'Virtual', ...extra });
const fakeDevices = () => [
  device('fake_audio_input_1', 'Fake Audio Input 1'), device('fake_audio_input_2', 'Fake Audio Input 2'),
  device('fake_audio_output_1', 'Fake Audio Output 1'), device('fake_audio_output_2', 'Fake Audio Output 2'),
];
module.exports = {
  device, fakeDevices,
  /** @param {NativeDevice[]} list */
  setDevices(list) { devices = list; for (const listener of listeners) listener(list); },
  isRunning: () => running,
};
