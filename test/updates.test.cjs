const { test } = require('node:test');
const assert = require('node:assert/strict');
const { updatesEnabled } = require('../src/updates.cjs');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('only explicitly marked release bundles can contact the update service', () => {
  assert.equal(updatesEnabled({}, true, 'darwin', 'arm64'), false);
  assert.equal(updatesEnabled({ glkvmUpdates: false }, true, 'darwin', 'arm64'), false);
  assert.equal(updatesEnabled({ glkvmUpdates: true }, false, 'darwin', 'arm64'), false);
  assert.equal(updatesEnabled({ glkvmUpdates: true }, true, 'darwin', 'x64'), false);
  assert.equal(updatesEnabled({ glkvmUpdates: true }, true, 'linux', 'arm64'), false);
  assert.equal(updatesEnabled({ glkvmUpdates: true }, true, 'darwin', 'arm64'), true);
});

test('manual checks avoid duplicate downloads, report errors, and release input on update quit', async () => {
  const loaded = { exports: /** @type {any} */ ({}) };
  let stopped = 0, checks = 0, released = 0, restarts = 0;
  /** @type {any[]} */
  const messages = [];
  const app = Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '0.1.22' });
  const autoUpdater = Object.assign(new EventEmitter(), {
    checkForUpdates() { checks++; autoUpdater.emit('checking-for-update'); },
    quitAndInstall() { restarts++; autoUpdater.emit('before-quit-for-update'); },
  });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/updates.cjs'), 'utf8'), {
    module: loaded, process: { platform: 'darwin', arch: 'arm64' },
    require: () => ({ UpdateSourceType: { ElectronPublicUpdateService: 0 }, updateElectronApp: () => ({ stopUpdates: () => { stopped++; } }) }),
  });
  const updates = loaded.exports.setupUpdates({ app, autoUpdater, manifest: { glkvmUpdates: true }, releaseInput: () => { released++; }, dialog: { showMessageBox: async (/** @type {any} */ options) => { messages.push(options); return { response: 1 }; } } });
  updates.check(); updates.check();
  assert.equal(checks, 1, 'No concurrent manual download');
  autoUpdater.emit('error', new Error('offline'));
  assert.equal(messages.length, 1);
  autoUpdater.emit('error', new Error('background failure'));
  assert.equal(messages.length, 1, 'Background errors are quiet');
  updates.check(); autoUpdater.emit('update-not-available');
  assert.match(messages[1].message, /up to date/);
  autoUpdater.emit('update-downloaded');
  assert.equal(stopped, 1, 'Stop polling after a download is ready');
  updates.check(); await Promise.resolve();
  assert.equal(checks, 2);
  assert.equal(restarts, 0, 'Later never interrupts a session');
  autoUpdater.emit('before-quit-for-update');
  assert.equal(released, 1);
});
