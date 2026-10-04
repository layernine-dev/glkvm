const { spawnSync } = require('node:child_process');

// Set to an exact identity name from `security find-identity -v -p codesigning`.
const overrideVariable = 'GLKVM_SIGNING_IDENTITY';

/** @param {string} output @param {'development' | 'release'} [mode] */
function parseIdentities(output, mode = 'development') {
  /** @type {Map<string, Set<string>>} */
  const identities = new Map();
  const prefix = mode === 'release' ? 'Developer ID Application: ' : 'Apple Development: ';
  for (const [, hash, name] of output.matchAll(/^\s*\d+\) ([A-F0-9]{40}) "([^"]+)"$/gm)) {
    if (!name.startsWith(prefix)) continue;
    identities.set(name, (identities.get(name) || new Set()).add(hash));
  }
  return identities;
}

/** Pick the valid Apple Development identity used to sign and verify the bundle.
 * @param {string} output @param {string | undefined} override
 * @param {'development' | 'release'} [mode]
 */
function selectSigningIdentity(output, override, mode = 'development') {
  const identities = parseIdentities(output, mode);
  const names = [...identities.keys()];
  const kind = mode === 'release' ? 'Developer ID Application' : 'Apple Development';
  const variable = mode === 'release' ? 'GLKVM_RELEASE_SIGNING_IDENTITY' : overrideVariable;
  const listed = names.length ? `Valid ${kind} identities: ${names.join('; ')}.` : `No valid ${kind} identity is available in the Keychain.`;
  const name = override ?? (names.length === 1 ? names[0] : undefined);
  if (override !== undefined && !identities.has(override)) {
    throw new Error(`${variable}="${override}" is not a valid ${kind} identity. ${listed}`);
  }
  if (!name) {
    throw new Error(`${names.length ? 'Multiple signing identities found' : 'No signing identity found'}. ${listed} Set ${variable} to the exact identity name.`);
  }
  if (/** @type {Set<string>} */ (identities.get(name)).size > 1) {
    throw new Error(`Several valid certificates are named "${name}"; remove the duplicate before signing.`);
  }
  return name;
}

/** @param {'development' | 'release'} [mode] */
function resolveSigningIdentity(mode = 'development') {
  const result = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Could not list code signing identities.');
  return selectSigningIdentity(result.stdout, process.env[mode === 'release' ? 'GLKVM_RELEASE_SIGNING_IDENTITY' : overrideVariable] || undefined, mode);
}

module.exports = { parseIdentities, selectSigningIdentity, resolveSigningIdentity };
