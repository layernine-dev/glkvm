require('./runtime.cjs');
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

app.setName('GLKVM Clean');
const childMode = process.argv.includes('--child');
const directory = childMode ? process.argv.at(-1) : fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-single-instance-'));
assert.ok(directory);
app.setPath('userData', directory);

if (childMode) {
  // Report errors to the parent instead of opening a native exception dialog.
  process.on('uncaughtException', error => { console.error(error.message); app.exit(1); });
  app.on('will-quit', () => console.log(JSON.stringify({ ready: app.isReady() })));
  require('../src/main.cjs');
} else {
  assert.ok(app.requestSingleInstanceLock(), 'The test holds its own isolated instance lock');
  let handoffs = 0;
  app.on('second-instance', () => { handoffs++; });
  app.whenReady().then(async () => {
    try {
      const child = spawn(process.execPath, ['--glkvm-test=single-instance', '--child', directory], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      const timer = setTimeout(() => child.kill(), 10000);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      }).finally(() => clearTimeout(timer));
      assert.equal(code, 0, errors);
      assert.deepEqual(JSON.parse(output.trim()), { ready: false }, 'A duplicate instance exits before readiness');
      assert.equal(handoffs, 1, 'The running instance receives one activation request');
      console.log('PASS: duplicate launch hands off to the running app and exits before readiness without an exception');
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
