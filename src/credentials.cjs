const { validateConfig } = require('./config.cjs');
/** @typedef {import('./config.cjs').Config} Config */
/** @typedef {import('./config.cjs').Device} Device */
/** @typedef {{isAsyncEncryptionAvailable(): Promise<boolean>, encryptStringAsync(value: string): Promise<Buffer>, decryptStringAsync(value: Buffer): Promise<{result: string}>}} Storage */

/** @param {Config} config */
function publicConfig(config) {
  return { ...config, devices: config.devices.map(({ encryptedPassword, ...device }) => ({ ...device, hasPassword: !!encryptedPassword })) };
}

/** @param {unknown} value @param {Config} previous @param {Storage} storage */
async function prepareConfig(value, previous, storage) {
  const next = validateConfig(value);
  const input = /** @type {{devices: Array<{password?: unknown, removePassword?: unknown}>}} */ (value);
  for (const [index, device] of next.devices.entries()) {
    // Never accept ciphertext supplied by a renderer, or reuse it on another host.
    delete device.encryptedPassword;
    const old = previous.devices.find(item => item.id === device.id && item.origin === device.origin);
    const change = input.devices[index];
    if (change.password !== undefined && (typeof change.password !== 'string' || change.password.length > 4096)) throw new Error('Password must be at most 4096 characters.');
    if (typeof change.password === 'string' && change.password.length) {
      if (!await storage.isAsyncEncryptionAvailable()) throw new Error('Secure password storage is unavailable. Unlock your login keychain and try again.');
      const encrypted = await storage.encryptStringAsync(JSON.stringify({ origin: device.origin, password: change.password }));
      device.encryptedPassword = encrypted.toString('base64');
    } else if (change.removePassword !== true && old?.encryptedPassword) {
      device.encryptedPassword = old.encryptedPassword;
    }
  }
  return next;
}

/** @param {Device} device @param {Storage} storage */
async function readPassword(device, storage) {
  if (!device.encryptedPassword) return null;
  const { result } = await storage.decryptStringAsync(Buffer.from(device.encryptedPassword, 'base64'));
  const stored = JSON.parse(result);
  return stored.origin === device.origin && typeof stored.password === 'string' ? stored.password : null;
}

module.exports = { publicConfig, prepareConfig, readPassword };
