const { packager } = require('@electron/packager');
const { personalizeExecutables } = require('./executable-uuid.cjs');
const { version } = require('../package.json');
const fs = require('node:fs');
const path = require('node:path');
const { resolveSigningIdentity } = require('./signing-identity.cjs');
const { verifySignature } = require('./verify-signature.cjs');

/** @param {{tests?: boolean}} [options] */
async function buildApp({ tests = false } = {}) {
  // Resolve once so packaging and verification use the same certificate.
  const signingIdentity = resolveSigningIdentity();
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
    overwrite: true, asar: true,
    afterExtract: [({ buildPath }) => personalizeExecutables(buildPath, 'dev.layernine.glkvm-clean')],
    afterCopy: tests ? [({ buildPath }) => {
      const file = path.join(buildPath, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      manifest.main = 'test/bootstrap.cjs';
      fs.writeFileSync(file, JSON.stringify(manifest));
    }] : [],
    extendInfo: {
      NSLocalNetworkUsageDescription: 'Connect to your configured GLKVM devices on the local network.',
    },
    osxSign: {
      identity: signingIdentity,
      type: 'development',
      identityValidation: true,
      continueOnError: false,
      strictVerify: true,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: () => ({
        entitlements: path.join(__dirname, 'entitlements.plist'),
        hardenedRuntime: true,
        timestamp: 'none',
      }),
    },
    ignore: [...(tests ? [] : [/^\/test($|\/)/]), /^\/scripts($|\/)/, /^\/tsconfig\.json$/, /^\/bun\.lock$/, /^\/bunfig\.toml$/, /^\/AGENTS\.md$/, /^\/README\.md$/],
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
