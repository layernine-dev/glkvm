const { packager } = require('@electron/packager');
const { personalizeExecutables } = require('./executable-uuid.cjs');
const { version } = require('../package.json');
const path = require('node:path');
const { signingIdentity, verifySignature } = require('./verify-signature.cjs');

packager({
  dir: path.join(__dirname, '..'),
  out: path.join(__dirname, '../dist'),
  name: 'GLKVM Clean',
  icon: path.join(__dirname, '../assets/GLKVM.icns'),
  appBundleId: 'dev.layernine.glkvm-clean',
  helperBundleId: 'dev.layernine.glkvm-clean.helper',
  appVersion: version,
  buildVersion: version,
  platform: 'darwin', arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  overwrite: true, asar: true,
  afterExtract: [({ buildPath }) => personalizeExecutables(buildPath, 'dev.layernine.glkvm-clean')],
  extendInfo: {
    NSLocalNetworkUsageDescription: 'Connect to your configured GLKVM devices on the local network.',
  },
  osxSign: {
    identity: signingIdentity,
    type: 'development',
    identityValidation: true,
    strictVerify: true,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: () => ({
      entitlements: path.join(__dirname, 'entitlements.plist'),
      hardenedRuntime: true,
      timestamp: 'none',
    }),
  },
  ignore: [/^\/test($|\/)/, /^\/scripts($|\/)/, /^\/tsconfig\.json$/, /^\/bun\.lock$/, /^\/README\.md$/],
}).then((paths) => paths.forEach((output) => {
  verifySignature(path.join(output, 'GLKVM Clean.app'));
  console.log(output);
})).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
