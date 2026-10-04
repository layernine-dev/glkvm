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

test('connection presentation defaults migrate and invalid values are rejected', () => {
  const legacy = defaults();
  delete legacy.devices[0].startMode;
  delete legacy.devices[0].windowScale;
  const migrated = validateConfig(legacy);
  assert.equal(migrated.devices[0].startMode, 'window-decoration-less');
  assert.equal(migrated.devices[0].windowScale, null);
  for (const windowScale of [0, -1, 3, '1.5']) {
    assert.throws(() => validateConfig({ ...legacy, devices: [{ ...legacy.devices[0], windowScale }] }));
  }
  assert.throws(() => validateConfig({ ...legacy, devices: [{ ...legacy.devices[0], startMode: 'unknown' }] }));
});

test('startup audio persists independently per connection and malformed values cannot be saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-config-'));
  const file = path.join(dir, 'settings.json');
  try {
    const value = defaults();
    value.devices.push({ id: 'lab', name: 'Lab', origin: 'https://lab.test', openAtStartup: false });
    const glkvm = /** @type {import('../src/audio.cjs').AudioSettings} */ (value.devices[0].audio);
    glkvm.startup = { speaker: true, microphone: false };
    const saved = writeConfig(file, value);
    assert.deepEqual(readConfig(file).devices.map(device => device.audio?.startup), [{ speaker: true, microphone: false }, { speaker: false, microphone: false }]);
    const before = fs.readFileSync(file, 'utf8');
    const broken = JSON.parse(before);
    broken.devices[1].audio.startup = { speaker: 'yes', microphone: false };
    assert.throws(() => writeConfig(file, broken));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    fs.writeFileSync(file, JSON.stringify(broken));
    assert.throws(() => readConfig(file), /startup audio/, 'A malformed file is reported, not silently reset');
    const legacy = JSON.parse(before);
    for (const device of legacy.devices) delete device.audio.startup;
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.deepEqual(readConfig(file).devices.map(device => device.audio?.startup), [{ speaker: false, microphone: false }, { speaker: false, microphone: false }], 'Older files migrate with both off');
    assert.equal(saved.devices[0].audio?.startup.speaker, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
