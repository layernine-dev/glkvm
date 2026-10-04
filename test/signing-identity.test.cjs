const test = require('node:test');
const assert = require('node:assert/strict');
const { selectSigningIdentity } = require('../scripts/signing-identity.cjs');

const alice = 'Apple Development: Alice Example (AAAAAAAAAA)';
const bob = 'Apple Development: Bob Example (BBBBBBBBBB)';
/** @param {...[string, string]} entries */
function listing(...entries) {
  const lines = entries.map(([hash, name], index) => `  ${index + 1}) ${hash.repeat(40)} "${name}"`);
  return `${lines.join('\n')}\n     ${entries.length} valid identities found\n`;
}

test('the only valid Apple Development identity is selected automatically', () => {
  assert.equal(selectSigningIdentity(listing(['A', bob]), undefined), bob);
  assert.equal(selectSigningIdentity(listing(['A', alice], ['B', 'Developer ID Application: Alice Example (TEAM123456)']), undefined), alice);
});

test('an explicit override must exactly match a valid identity', () => {
  const output = listing(['A', alice], ['B', bob]);
  assert.equal(selectSigningIdentity(output, alice), alice);
  assert.throws(() => selectSigningIdentity(output, 'Apple Development: Alice Example'), /GLKVM_SIGNING_IDENTITY="Apple Development: Alice Example" is not a valid.*Bob Example/);
  assert.throws(() => selectSigningIdentity(listing(['A', bob]), alice), /not a valid/);
});

test('missing or ambiguous identities fail instead of signing ad hoc', () => {
  assert.throws(() => selectSigningIdentity('     0 valid identities found\n', undefined), /No signing identity found.*Keychain.*GLKVM_SIGNING_IDENTITY/);
  assert.throws(() => selectSigningIdentity(listing(['A', alice], ['B', bob]), undefined), /Multiple signing identities.*Alice Example.*Bob Example.*GLKVM_SIGNING_IDENTITY/);
  assert.throws(() => selectSigningIdentity(listing(['A', alice], ['B', alice]), undefined), /Several valid certificates/);
});
