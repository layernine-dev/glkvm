const test = require('node:test');
const assert = require('node:assert/strict');
const { personalizeUUID } = require('../scripts/executable-uuid.cjs');

function executable() {
  const binary = Buffer.alloc(64, 0);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(1, 16);
  binary.writeUInt32LE(24, 20);
  binary.writeUInt32LE(0x1b, 32);
  binary.writeUInt32LE(24, 36);
  binary.fill(0x42, 40, 56);
  return binary;
}

test('packaged UUIDs are reproducible and distinct from Electron and other helpers', () => {
  const original = executable();
  const main = Buffer.from(original);
  const rebuild = Buffer.from(original);
  const helper = Buffer.from(original);
  personalizeUUID(main, 'dev.layernine.glkvm-clean:main');
  personalizeUUID(rebuild, 'dev.layernine.glkvm-clean:main');
  personalizeUUID(helper, 'dev.layernine.glkvm-clean:helper');
  assert.deepEqual(main, rebuild);
  assert.notDeepEqual(main.subarray(40, 56), original.subarray(40, 56));
  assert.notDeepEqual(main.subarray(40, 56), helper.subarray(40, 56));
  assert.deepEqual(main.subarray(0, 40), original.subarray(0, 40));
  assert.deepEqual(main.subarray(56), original.subarray(56));
});

test('unexpected executable formats fail packaging instead of silently retaining a shared UUID', () => {
  assert.throws(() => personalizeUUID(Buffer.alloc(12), 'app'), /Mach-O/);
  const missing = executable();
  missing.writeUInt32LE(0, 16);
  assert.throws(() => personalizeUUID(missing, 'app'), /Missing/);
  const truncated = executable();
  truncated.writeUInt32LE(100, 36);
  assert.throws(() => personalizeUUID(truncated, 'app'), /size/);
});
