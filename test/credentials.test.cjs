const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults } = require('../src/config.cjs');
const { publicConfig, prepareConfig, readPassword } = require('../src/credentials.cjs');

// A deterministic storage adapter exercises policy; the app integration test
// separately verifies real safeStorage encryption and automatic sign-in.
const storage = {
  isAsyncEncryptionAvailable: async () => true,
  /** @param {string} value */
  encryptStringAsync: async value => Buffer.from(value),
  /** @param {Buffer} value */
  decryptStringAsync: async value => ({ result: value.toString() }),
};
test('passwords are write-only, retained on rename, removed explicitly, and bound to the origin', async () => {
  const initial = defaults();
  const saved = await prepareConfig({ ...initial, devices: [{ ...initial.devices[0], password: 'test secret' }] }, initial, storage);
  assert.equal(await readPassword(saved.devices[0], storage), 'test secret');
  const visible = publicConfig(saved);
  assert.equal(visible.devices[0].hasPassword, true);
  assert.ok(!JSON.stringify(visible).includes('encryptedPassword'));
  const renamed = await prepareConfig({ ...visible, devices: [{ ...visible.devices[0], name: 'Office', password: '' }] }, saved, storage);
  assert.equal(renamed.devices[0].encryptedPassword, saved.devices[0].encryptedPassword);
  const removed = await prepareConfig({ ...visible, devices: [{ ...visible.devices[0], removePassword: true }] }, saved, storage);
  assert.equal(removed.devices[0].encryptedPassword, undefined);
  const moved = await prepareConfig({ ...saved, devices: [{ ...saved.devices[0], origin: 'https://other.test' }] }, saved, storage);
  assert.equal(moved.devices[0].encryptedPassword, undefined);
  assert.equal(await readPassword({ ...saved.devices[0], origin: 'https://other.test' }, storage), null);
  const forged = await prepareConfig(saved, initial, storage);
  assert.equal(forged.devices[0].encryptedPassword, undefined);
  await assert.rejects(prepareConfig({ ...initial, devices: [{ ...initial.devices[0], password: 'secret' }] }, initial, { ...storage, isAsyncEncryptionAvailable: async () => false }), /unavailable/);
});
