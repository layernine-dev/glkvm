const test = require('node:test');
const assert = require('node:assert/strict');
const { selectSigningIdentity } = require('../scripts/signing-identity.cjs');

const uwe = 'Apple Development: Uwe Schwarz (54988A349V)';
const christian = 'Apple Development: Christian Erben (KVK3AXT9XV)';
/** @param {...[string, string]} entries */
function listing(...entries) {
  const lines = entries.map(([hash, name], index) => `  ${index + 1}) ${hash.repeat(40)} "${name}"`);
  return `${lines.join('\n')}\n     ${entries.length} valid identities found\n`;
}

test('the only valid Apple Development identity is selected automatically', () => {
  assert.equal(selectSigningIdentity(listing(['A', christian]), undefined), christian);
  assert.equal(selectSigningIdentity(listing(['A', uwe], ['B', 'Developer ID Application: Uwe Schwarz (TEAM123456)']), undefined), uwe);
});

test('an explicit override must exactly match a valid identity', () => {
  const output = listing(['A', uwe], ['B', christian]);
  assert.equal(selectSigningIdentity(output, uwe), uwe);
  assert.throws(() => selectSigningIdentity(output, 'Apple Development: Uwe Schwarz'), /GLKVM_SIGNING_IDENTITY="Apple Development: Uwe Schwarz" is not a valid.*Christian Erben/);
  assert.throws(() => selectSigningIdentity(listing(['A', christian]), uwe), /not a valid/);
});

test('missing or ambiguous identities fail instead of signing ad hoc', () => {
  assert.throws(() => selectSigningIdentity('     0 valid identities found\n', undefined), /No signing identity found.*Keychain.*GLKVM_SIGNING_IDENTITY/);
  assert.throws(() => selectSigningIdentity(listing(['A', uwe], ['B', christian]), undefined), /Multiple signing identities.*Uwe Schwarz.*Christian Erben.*GLKVM_SIGNING_IDENTITY/);
  assert.throws(() => selectSigningIdentity(listing(['A', uwe], ['B', uwe]), undefined), /Several valid certificates/);
});
