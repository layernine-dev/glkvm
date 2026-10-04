const { packager } = require('@electron/packager');
const { personalizeExecutables } = require('./executable-uuid.cjs');
const { version } = require('../package.json');
const fs = require('node:fs');
const path = require('node:path');
const { resolveSigningIdentity } = require('./signing-identity.cjs');
const { verifySignature, catalogName } = require('./verify-signature.cjs');
const { spawnSync } = require('node:child_process');
const { collectRuntimeLicenses, preserveElectronLicenses, verifyLicenses } = require('./licenses.cjs');

/** Compile the read-only CoreAudio catalog; it is signed with the app as a nested executable.
 * @param {string} minimumMacOS */
function buildCatalog(minimumMacOS) {
  const directory = path.join(__dirname, '../dist/native');
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, catalogName);
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-j', '2', '-O', '-swift-version', '5', '-target', `arm64-apple-macos${minimumMacOS}`, path.join(__dirname, '../native/audio-catalog.swift'), '-o', output], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not compile the audio device catalog.');
  return output;
}

/** @param {{tests?: boolean, release?: boolean, appVersion?: string}} [options] */
async function buildApp({ tests = false, release = false, appVersion = version } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Builds require Apple Silicon and macOS.');
  if (tests && release) throw new Error('Test bundles cannot be release bundles.');
  const systemVersion = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' });
  if (systemVersion.status !== 0 || !/^\d+\./.test(systemVersion.stdout)) throw new Error('Cannot determine macOS version.');
  const minimumMacOS = `${systemVersion.stdout.trim().split('.')[0]}.0`;
  // Resolve once so packaging and verification use the same certificate.
  const signingIdentity = resolveSigningIdentity(release ? 'release' : 'development');
  const catalog = buildCatalog(minimumMacOS);
  const paths = await packager({
    dir: path.join(__dirname, '..'),
    out: path.join(__dirname, tests ? '../dist/test-runtime' : '../dist'),
    name: 'GLKVM Clean',
    icon: path.join(__dirname, '../assets/GLKVM.icns'),
    appBundleId: 'dev.layernine.glkvm-clean',
    helperBundleId: 'dev.layernine.glkvm-clean.helper',
    appVersion,
    buildVersion: appVersion,
    platform: 'darwin', arch: 'arm64',
    overwrite: true, asar: true, extraResource: [catalog],
    afterExtract: [({ buildPath }) => {
      preserveElectronLicenses(buildPath);
      personalizeExecutables(buildPath, 'dev.layernine.glkvm-clean');
    }],
    afterCopy: [({ buildPath }) => {
      const file = path.join(buildPath, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (tests) manifest.main = 'test/bootstrap.cjs';
      manifest.glkvmUpdates = release && require('../release.json').updatesEnabled === true;
      fs.writeFileSync(file, JSON.stringify(manifest));
    }],
    afterPrune: [({ buildPath }) => collectRuntimeLicenses(buildPath, path.join(buildPath, '../licenses'))],
    extendInfo: {
      LSMinimumSystemVersion: minimumMacOS,
      NSLocalNetworkUsageDescription: 'Connect to your configured GLKVM devices on the local network.',
      NSMicrophoneUsageDescription: 'Send your selected microphone to a GLKVM device when you turn on its microphone.',
    },
    osxSign: {
      identity: signingIdentity,
      type: release ? 'distribution' : 'development',
      identityValidation: true,
      continueOnError: false,
      strictVerify: true,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: file => path.basename(file) === catalogName ? {
        entitlements: path.join(__dirname, 'catalog-entitlements.plist'),
        hardenedRuntime: true,
        timestamp: release ? 'http://timestamp.apple.com/ts01' : 'none',
        additionalArguments: ['--identifier', 'dev.layernine.glkvm-clean.audio-catalog'],
      } : {
        entitlements: path.join(__dirname, 'entitlements.plist'),
        hardenedRuntime: true,
        timestamp: release ? 'http://timestamp.apple.com/ts01' : 'none',
      },
    },
    ignore: [...(tests ? [] : [/^\/test($|\/)/]), /^\/\.[^/]+($|\/)/, /^\/third_party($|\/)/, /^\/docs($|\/)/, /^\/scripts($|\/)/, /^\/native($|\/)/, /^\/release\.json$/, /^\/tsconfig\.json$/, /^\/bun\.lock$/, /^\/bunfig\.toml$/, /^\/AGENTS\.md$/, /^\/CONTRIBUTING\.md$/, /^\/README\.md$/],
  });
  const appPath = path.join(paths[0], 'GLKVM Clean.app');
  verifySignature(appPath, signingIdentity, release);
  verifyLicenses(appPath);
  return appPath;
}

module.exports = { buildApp };
if (require.main === module) {
  void buildApp().then(console.log).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
