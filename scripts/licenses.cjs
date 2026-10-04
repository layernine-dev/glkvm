const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** Collect full license/notice texts from the actual pruned runtime tree.
 * @param {string} appDirectory @param {string} destination
 */
function collectRuntimeLicenses(appDirectory, destination) {
  fs.mkdirSync(destination, { recursive: true });
  /** @type {string[]} */
  const entries = [];
  /** @param {string} directory */
  function visitModules(directory) {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory).sort()) {
      if (name.startsWith('.')) continue;
      const packageDirectory = path.join(directory, name);
      if (name.startsWith('@')) { visitModules(packageDirectory); continue; }
      const manifestFile = path.join(packageDirectory, 'package.json');
      if (!fs.existsSync(manifestFile)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const files = fs.readdirSync(packageDirectory).filter(file => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(file) && fs.statSync(path.join(packageDirectory, file)).isFile());
      const supplement = path.join(__dirname, '../third_party', `${manifest.name}@${manifest.version}`);
      const hasLicense = files.some(file => /^(licen[sc]e|copying)/i.test(file));
      if (!hasLicense && !fs.existsSync(path.join(supplement, 'LICENSE.txt'))) throw new Error(`Missing license text for shipped dependency ${manifest.name}@${manifest.version}`);
      const relative = `${manifest.name.replaceAll('/', '__')}@${manifest.version}`;
      fs.mkdirSync(path.join(destination, relative), { recursive: true });
      for (const file of files) fs.copyFileSync(path.join(packageDirectory, file), path.join(destination, relative, file));
      if (!hasLicense) fs.cpSync(supplement, path.join(destination, relative), { recursive: true });
      entries.push(`${manifest.name}@${manifest.version}: ${manifest.license || 'see included license'} (${relative}/)`);
      visitModules(path.join(packageDirectory, 'node_modules'));
    }
  }
  visitModules(path.join(appDirectory, 'node_modules'));
  fs.copyFileSync(path.join(appDirectory, 'LICENSE'), path.join(destination, 'GLKVM-LICENSE.txt'));
  fs.writeFileSync(path.join(destination, 'README.txt'), `GLKVM Clean third-party notices\n\nElectron: Electron-LICENSE.txt\nChromium and bundled components: LICENSES.chromium.html\n\nRuntime JavaScript packages:\n${entries.join('\n')}\n\nBuild-only tooling is not distributed in the application.\n`);
  /** @type {Record<string, string>} */
  const hashes = {};
  /** @param {string} directory */
  function inventory(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inventory(file);
      else if (entry.name !== 'manifest.json') hashes[path.relative(destination, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  inventory(destination);
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(hashes, null, 2) + '\n');
}

/** Preserve Electron's own texts from the downloaded runtime before packaging.
 * @param {string} extracted
 */
function preserveElectronLicenses(extracted) {
  const resources = path.join(extracted, 'Electron.app/Contents/Resources');
  const destination = path.join(resources, 'licenses');
  fs.mkdirSync(destination, { recursive: true });
  for (const [sourceName, outputName] of [['LICENSE', 'Electron-LICENSE.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
    const source = [path.join(extracted, sourceName), path.join(resources, sourceName)].find(file => fs.existsSync(file));
    if (!source || fs.statSync(source).size === 0) throw new Error(`Electron distribution is missing ${sourceName}`);
    fs.copyFileSync(source, path.join(destination, outputName));
  }
}

/** @param {string} appPath */
function verifyLicenses(appPath) {
  const directory = path.join(appPath, 'Contents/Resources/licenses');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  for (const required of ['GLKVM-LICENSE.txt', 'Electron-LICENSE.txt', 'LICENSES.chromium.html', 'README.txt']) {
    if (!manifest[required]) throw new Error(`Missing bundled notice: ${required}`);
  }
  for (const [file, hash] of Object.entries(manifest)) {
    if (createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex') !== hash) throw new Error(`Bundled notice changed: ${file}`);
  }
  console.log(`Verified ${Object.keys(manifest).length} bundled license/notice files.`);
}
module.exports = { collectRuntimeLicenses, preserveElectronLicenses, verifyLicenses };
if (require.main === module) {
  try { verifyLicenses(process.argv[2] || path.join(__dirname, '../dist/GLKVM Clean-darwin-arm64/GLKVM Clean.app')); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
