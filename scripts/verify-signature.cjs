const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { resolveSigningIdentity } = require('./signing-identity.cjs');
const catalogName = 'glkvm-audio-catalog';

/** @param {string[]} args */
function codesign(args) {
  const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Code signature verification failed.');
  return result.stdout + result.stderr;
}

/** @param {string} appPath @param {string} signingIdentity */
function verifySignature(appPath, signingIdentity) {
  codesign(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const frameworks = path.join(appPath, 'Contents/Frameworks');
  const helpers = fs.readdirSync(frameworks).filter(name => name.endsWith('.app'));
  const uuids = new Set();
  for (const bundle of [appPath, ...helpers.map(name => path.join(frameworks, name))]) {
    const details = codesign(['--display', '--verbose=4', bundle]);
    const executable = details.match(/^Executable=(.+)$/m)?.[1];
    if (!executable) throw new Error(`Missing executable: ${bundle}`);
    const uuidResult = spawnSync('/usr/bin/dwarfdump', ['--uuid', executable], { encoding: 'utf8' });
    const uuid = uuidResult.stdout?.match(/^UUID: ([A-F0-9-]+)/m)?.[1];
    if (uuidResult.status !== 0 || !uuid || uuids.has(uuid)) throw new Error(`Missing or duplicate executable UUID: ${bundle}`);
    uuids.add(uuid);
    const requirement = codesign(['--display', '--requirements', '-', bundle]);
    const identifier = details.match(/^Identifier=(.+)$/m)?.[1];
    if (!details.includes(`Authority=${signingIdentity}\n`) || !/^TeamIdentifier=[A-Z0-9]+$/m.test(details) || !/^CodeDirectory .*flags=.*\bruntime\b/m.test(details)) {
      throw new Error(`Unexpected signer or missing hardened runtime: ${bundle}`);
    }
    if (bundle === appPath ? identifier !== 'dev.layernine.glkvm-clean' : !identifier?.startsWith('dev.layernine.glkvm-clean.helper')) {
      throw new Error(`Unexpected bundle identifier: ${bundle}`);
    }
    if (!requirement.includes(`identifier "${identifier}"`) || !requirement.includes(`certificate leaf[subject.CN] = "${signingIdentity}"`) || /designated =>.*cdhash/.test(requirement)) {
      throw new Error(`The code identity is not stable across updates: ${bundle}`);
    }
  }
  // The device catalog only reads CoreAudio properties: no entitlements.
  const catalog = path.join(appPath, 'Contents/Resources', catalogName);
  const details = codesign(['--display', '--verbose=4', catalog]);
  const entitlements = codesign(['--display', '--entitlements', '-', '--xml', catalog]);
  if (!details.includes(`Authority=${signingIdentity}\n`) || !/^Identifier=dev\.layernine\.glkvm-clean\.audio-catalog$/m.test(details) || !/^CodeDirectory .*flags=.*\bruntime\b/m.test(details) || /<key>/.test(entitlements)) {
    throw new Error(`Unexpected signature for the audio device catalog: ${catalog}`);
  }
  console.log(`Verified signed app, ${helpers.length} helpers and the audio device catalog: ${signingIdentity}`);
}

module.exports = { verifySignature, catalogName };
if (require.main === module) {
  const appPath = process.argv[2];
  if (!appPath) { console.error('Usage: node scripts/verify-signature.cjs /path/to/GLKVM\\ Clean.app'); process.exitCode = 1; }
  else {
    try { verifySignature(path.resolve(appPath), resolveSigningIdentity()); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}
