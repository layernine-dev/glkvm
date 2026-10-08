const { spawn } = require('node:child_process');
const path = require('node:path');
const { buildApp } = require('./build.cjs');

async function main() {
  const tests = process.argv.slice(2);
  if (tests.some(test => !['single-instance', 'browser', 'app', 'keyboard-app', 'audio-app', 'startup-audio-app', 'device-id-app', 'device-real-app'].includes(test))) {
    throw new Error('Unknown GUI test.');
  }
  const appPath = await buildApp({ tests: tests.length > 0 });
  const executable = path.join(appPath, 'Contents/MacOS/GLKVM Clean');
  for (const test of tests.length ? tests : [null]) {
    const child = spawn(executable, test ? [`--glkvm-test=${test}`] : [], { stdio: 'inherit' });
    const timer = test ? setTimeout(() => {
      console.error(`GUI test timed out: ${test}`);
      child.kill('SIGKILL');
    }, test === 'startup-audio-app' ? 300000 : 120000) : null;
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      if (code !== 0) throw new Error(`${test || 'App'} exited with code ${code}.`);
    } finally { if (timer) clearTimeout(timer); }
  }
}

void main().catch(error => { console.error(error.message); process.exitCode = 1; });
