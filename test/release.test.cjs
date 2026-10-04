const { test } = require('node:test');
const assert = require('node:assert/strict');
const { versionAt, compareVersions } = require('../scripts/release.cjs');
const { selectSigningIdentity } = require('../scripts/signing-identity.cjs');

test('release versions increase in main history order and remain stable on retry', () => {
  assert.equal(versionAt('0.1.21', 0), '0.1.21');
  assert.equal(versionAt('0.1.21', 1), '0.1.22');
  assert.equal(versionAt('0.1.21', 9), '0.1.30');
  assert.equal(versionAt('0.1.21', 9), versionAt('0.1.21', 9));
  assert.throws(() => versionAt('0.1.21', -1));
  assert.throws(() => versionAt('0.1.21', 0.5));
  assert.throws(() => versionAt('0.1.21-beta', 1));
  assert.ok(compareVersions('0.1.100', '0.1.99') > 0);
  assert.ok(compareVersions('0.2.0', '0.1.100') > 0);
});

test('release signing cannot fall back to a development identity', () => {
  const development = 'Apple Development: Alice Example (AAAAAAAAAA)';
  const release = 'Developer ID Application: Alice Example (AAAAAAAAAA)';
  const listing = `  1) ${'A'.repeat(40)} "${development}"\n  2) ${'B'.repeat(40)} "${release}"\n`;
  assert.equal(selectSigningIdentity(listing, undefined), development);
  assert.equal(selectSigningIdentity(listing, undefined, 'release'), release);
  assert.throws(() => selectSigningIdentity(listing, development, 'release'), /not a valid Developer ID/);
  assert.throws(() => selectSigningIdentity(listing.split('\n')[0], undefined, 'release'), /No valid Developer ID Application/);
});
