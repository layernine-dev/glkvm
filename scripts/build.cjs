const { packager } = require('@electron/packager');
const { personalizeExecutables } = require('./executable-uuid.cjs');
const { version } = require('../package.json');
const fs = require('node:fs');
const path = require('node:path');
const { resolveSigningIdentity } = require('./signing-identity.cjs');
const { verifySignature, catalogName } = require('./verify-signature.cjs');
const { spawnSync } = require('node:child_process');

/** Compile the read-only CoreAudio catalog; it is signed with the app as a nested executable. */
function buildCatalog() {
  const directory = path.join(__dirname, '../dist/native');
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, catalogName);
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos12.0`, path.join(__dirname, '../native/audio-catalog.swift'), '-o', output], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Could not compile the audio device catalog.');
  return output;
}

/** @param {{tests?: boolean}} [options] */
async function buildApp({ tests = false } = {}) {
  // Resolve once so packaging and verification use the same certificate.
  const signingIdentity = resolveSigningIdentity();
  const catalog = buildCatalog();
  const paths = await packager({
    dir: path.join(__dirname, '..'),
    out: path.join(__dirname, tests ? '../dist/test-runtime' : '../dist'),
    name: 'GLKVM Clean',
    icon: path.join(__dirname, '../assets/GLKVM.icns'),
    appBundleId: 'dev.layernine.glkvm-clean',
    helperBundleId: 'dev.layernine.glkvm-clean.helper',
    appVersion: version,
    buildVersion: version,
    platform: 'darwin', arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    overwrite: true, asar: true, extraResource: [catalog],
    afterExtract: [({ buildPath }) => personalizeExecutables(buildPath, 'dev.layernine.glkvm-clean')],
    afterCopy: tests ? [({ buildPath }) => {
      const file = path.join(buildPath, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      manifest.main = 'test/bootstrap.cjs';
      fs.writeFileSync(file, JSON.stringify(manifest));
    }] : [],
    extendInfo: {
      NSLocalNetworkUsageDescription: 'Connect to your configured GLKVM devices on the local network.',
      NSMicrophoneUsageDescription: 'Send your selected microphone to a GLKVM device when you turn on its microphone.',
    },
    osxSign: {
      identity: signingIdentity,
      type: 'development',
      identityValidation: true,
      continueOnError: false,
      strictVerify: true,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: file => path.basename(file) === catalogName ? {
        entitlements: path.join(__dirname, 'catalog-entitlements.plist'),
        hardenedRuntime: true,
        timestamp: 'none',
        additionalArguments: ['--identifier', 'dev.layernine.glkvm-clean.audio-catalog'],
      } : {
        entitlements: path.join(__dirname, 'entitlements.plist'),
        hardenedRuntime: true,
        timestamp: 'none',
      },
    },
    ignore: [...(tests ? [] : [/^\/test($|\/)/]), /^\/scripts($|\/)/, /^\/native($|\/)/, /^\/tsconfig\.json$/, /^\/bun\.lock$/, /^\/bunfig\.toml$/, /^\/AGENTS\.md$/, /^\/README\.md$/],
  });
  const appPath = path.join(paths[0], 'GLKVM Clean.app');
  verifySignature(appPath, signingIdentity);
  return appPath;
}

module.exports = { buildApp };
if (require.main === module) {
  void buildApp().then(console.log).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
