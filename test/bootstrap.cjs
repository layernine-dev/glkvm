const { app } = require('electron');
const path = require('node:path');
require('./runtime.cjs');

process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
process.on('uncaughtException', error => { console.error(error); app.exit(1); });

const test = process.argv.find(argument => argument.startsWith('--glkvm-test='))?.slice('--glkvm-test='.length);
if (!test || !['single-instance', 'browser', 'app', 'keyboard-app', 'connection-cover-app', 'audio-app', 'startup-audio-app', 'device-id-app', 'device-real-app'].includes(test)) {
  throw new Error('Select a GUI test through scripts/run-app.cjs.');
}
require(path.join(__dirname, `${test}.cjs`));
