const { spawnSync } = require('node:child_process');

// Set to an exact identity name from `security find-identity -v -p codesigning`.
const overrideVariable = 'GLKVM_SIGNING_IDENTITY';

/** @param {string} output */
function parseIdentities(output) {
  /** @type {Map<string, Set<string>>} */
  const identities = new Map();
  for (const [, hash, name] of output.matchAll(/^\s*\d+\) ([A-F0-9]{40}) "(Apple Development: [^"]+)"$/gm)) {
    identities.set(name, (identities.get(name) || new Set()).add(hash));
  }
  return identities;
}

/** Pick the valid Apple Development identity used to sign and verify the bundle.
 * @param {string} output @param {string | undefined} override
 */
function selectSigningIdentity(output, override) {
  const identities = parseIdentities(output);
  const names = [...identities.keys()];
  const listed = names.length ? `Valid Apple Development identities: ${names.join('; ')}.` : 'No valid Apple Development identity is available in the Keychain.';
  const name = override ?? (names.length === 1 ? names[0] : undefined);
  if (override !== undefined && !identities.has(override)) {
    throw new Error(`${overrideVariable}="${override}" is not a valid Apple Development identity. ${listed}`);
  }
  if (!name) {
    throw new Error(`${names.length ? 'Multiple signing identities found' : 'No signing identity found'}. ${listed} Set ${overrideVariable} to the exact identity name.`);
  }
  if (/** @type {Set<string>} */ (identities.get(name)).size > 1) {
    throw new Error(`Several valid certificates are named "${name}"; remove the duplicate before signing.`);
  }
  return name;
}

function resolveSigningIdentity() {
  const result = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Could not list code signing identities.');
  return selectSigningIdentity(result.stdout, process.env[overrideVariable] || undefined);
}

module.exports = { parseIdentities, selectSigningIdentity, resolveSigningIdentity };
