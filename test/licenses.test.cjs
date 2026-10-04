const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectRuntimeLicenses, preserveElectronLicenses, verifyLicenses } = require('../scripts/licenses.cjs');

test('packaged notices retain Electron, Chromium and nested runtime licenses; tampering fails', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-licenses-'));
  try {
    fs.writeFileSync(path.join(directory, 'LICENSE'), 'Electron license');
    fs.writeFileSync(path.join(directory, 'LICENSES.chromium.html'), 'Chromium notices');
    preserveElectronLicenses(directory);
    const app = path.join(directory, 'Electron.app/Contents/Resources/app');
    fs.mkdirSync(path.join(app, 'node_modules/example/node_modules/child'), { recursive: true });
    fs.writeFileSync(path.join(app, 'LICENSE'), 'GLKVM license');
    for (const [relative, name] of [['example', 'example'], ['example/node_modules/child', 'child']]) {
      const folder = path.join(app, 'node_modules', relative);
      fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT' }));
      fs.writeFileSync(path.join(folder, 'LICENSE'), `${name} copyright and license`);
    }
    const notices = path.join(app, '../licenses');
    collectRuntimeLicenses(app, notices);
    verifyLicenses(path.join(directory, 'Electron.app'));
    assert.equal(fs.readFileSync(path.join(notices, 'child@1.0.0/LICENSE'), 'utf8'), 'child copyright and license');
    fs.writeFileSync(path.join(notices, 'LICENSES.chromium.html'), 'truncated');
    assert.throws(() => verifyLicenses(path.join(directory, 'Electron.app')), /changed/);
    fs.unlinkSync(path.join(app, 'node_modules/example/LICENSE'));
    assert.throws(() => collectRuntimeLicenses(app, notices), /Missing license text.*example/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
