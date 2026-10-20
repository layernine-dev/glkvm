const { spawn } = require('node:child_process');
const path = require('node:path');
const { buildApp } = require('./build.cjs');

async function main() {
  const tests = process.argv.slice(2);
  if (tests.some(test => !['single-instance', 'browser', 'app', 'keyboard-app', 'audio-app', 'startup-audio-app', 'device-id-app', 'device-real-app', 'shutdown-app'].includes(test))) {
    throw new Error('Unknown GUI test.');
  }
  const appPath = await buildApp({ tests: tests.length > 0 });
  const executable = path.join(appPath, 'Contents/MacOS/GLKVM Clean');
  // Reopen after each complete native teardown. A will-quit callback alone
  // cannot prove that Chromium and its network service actually exited.
  const scenarios = (tests.length ? tests : [null]).flatMap(test => test === 'shutdown-app' ? [test, test, test] : [test]);
  for (const test of scenarios) {
    let shutdownOutput = '';
    const child = spawn(executable, test ? [`--glkvm-test=${test}`] : [], { stdio: test === 'shutdown-app' ? ['inherit', 'pipe', 'inherit'] : 'inherit' });
    child.stdout?.on('data', chunk => { process.stdout.write(chunk); shutdownOutput += chunk; });
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
      if (test === 'shutdown-app') {
        const match = shutdownOutput.match(/^GLKVM_SHUTDOWN_PROCESSES (\[[\d,]+\])$/m);
        if (!match || !shutdownOutput.includes('PASS: Quit drains')) throw new Error('Shutdown assertions did not complete.');
        const pids = /** @type {number[]} */ (JSON.parse(match[1]));
        const alive = () => pids.filter(pid => {
          try { process.kill(pid, 0); return true; }
          catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ESRCH') return false; throw error; }
        });
        for (let i = 0; i < 50 && alive().length; i++) await new Promise(resolve => setTimeout(resolve, 100));
        if (alive().length) throw new Error(`Shutdown left processes alive: ${alive().join(', ')}`);
        console.log('PASS: Main process and all helpers exited; the signed bundle can reopen.');
      }
    } finally { if (timer) clearTimeout(timer); }
  }
}

void main().catch(error => { console.error(error.message); process.exitCode = 1; });
