const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** Give each packaged executable an app-specific UUID before code signing.
 * Preserve repeatability across rebuilds of the same Electron binary.
 * @param {Buffer} binary @param {string} identity
 */
function personalizeUUID(binary, identity) {
  if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Expected a thin 64-bit Mach-O executable.');
  const end = 32 + binary.readUInt32LE(20);
  if (end > binary.length) throw new Error('Invalid Mach-O load commands.');
  let offset = 32;
  for (let index = 0; index < binary.readUInt32LE(16); index++) {
    if (offset + 8 > end) throw new Error('Invalid Mach-O load command.');
    const size = binary.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) throw new Error('Invalid Mach-O load command size.');
    if (binary.readUInt32LE(offset) === 0x1b) {
      if (size !== 24) throw new Error('Invalid Mach-O UUID command.');
      const uuid = createHash('sha256').update(identity).update(binary.subarray(offset + 8, offset + 24)).digest().subarray(0, 16);
      uuid[6] = (uuid[6] & 0x0f) | 0x50;
      uuid[8] = (uuid[8] & 0x3f) | 0x80;
      uuid.copy(binary, offset + 8);
      return;
    }
    offset += size;
  }
  throw new Error('Missing Mach-O UUID command.');
}

/** @param {string} root @param {string} bundleId */
function personalizeExecutables(root, bundleId) {
  let count = 0;
  /** @param {string} directory */
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && directory.endsWith('.app/Contents/MacOS')) {
        const binary = fs.readFileSync(file);
        personalizeUUID(binary, `${bundleId}:${path.relative(root, file)}`);
        fs.writeFileSync(file, binary);
        count++;
      }
    }
  }
  visit(root);
  if (count !== 5) throw new Error(`Expected app and four helper executables, found ${count}.`);
}

module.exports = { personalizeUUID, personalizeExecutables };
