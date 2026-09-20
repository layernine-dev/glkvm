const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaults, validateConfig, readConfig, writeConfig, partitionFor } = require('../src/config.cjs');

test('connections survive saving, renaming, changing hosts, and removing all entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-config-'));
  const file = path.join(dir, 'settings.json');
  try {
    const initial = readConfig(file);
    assert.deepEqual(initial.devices.map(d => d.name), ['GLKVM']);
    const legacyPartition = partitionFor(initial.devices[0]);
    assert.equal(initial.devices[0].origin, 'https://glkvm.local');
    initial.devices[0].name = 'Office';
    initial.devices.push({ id: '', name: 'Lab', origin: 'https://lab.test/', openAtStartup: false });
    const saved = writeConfig(file, initial);
    assert.deepEqual(readConfig(file), saved);
    assert.equal(saved.devices[1].origin, 'https://lab.test');
    assert.ok(saved.devices[1].id);
    assert.equal(partitionFor(saved.devices[0]), legacyPartition);
    saved.devices[0].origin = 'https://new-host.test';
    assert.notEqual(partitionFor(saved.devices[0]), legacyPartition);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    saved.devices = [];
    writeConfig(file, saved);
    assert.equal(readConfig(file).devices.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('invalid settings cannot overwrite the existing file or import credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-config-'));
  const file = path.join(dir, 'settings.json');
  try {
    writeConfig(file, defaults());
    const before = fs.readFileSync(file, 'utf8');
    for (const origin of ['file:///etc/passwd', 'javascript:alert(1)', 'https://admin:secret@device.test', 'https://device.test/path', 'https://device.test/#secret', 'invalid']) {
      const value = defaults(); value.devices[0].origin = origin;
      assert.throws(() => writeConfig(file, value));
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
    const duplicate = defaults(); duplicate.devices.push({ ...duplicate.devices[0], id: 'duplicate' });
    assert.throws(() => validateConfig(duplicate));
    fs.writeFileSync(file, '{broken');
    assert.throws(() => readConfig(file));
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
