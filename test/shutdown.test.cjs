const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setupShutdown } = require('../src/shutdown.cjs');

test('a stalled renderer or network service cannot indefinitely veto Quit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings = t.mock.method(console, 'warn', () => {});
  let quits = 0;
  const app = Object.assign(new EventEmitter(), { isReady: () => true, quit: () => { quits++; } });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, stop: () => {}, loadURL: () => new Promise(() => {}) });
  setupShutdown({
    app: /** @type {any} */ (app),
    windows: () => [/** @type {any} */ ({ isDestroyed: () => false, webContents: contents })],
    sessions: () => [/** @type {any} */ ({ closeAllConnections: () => new Promise(() => {}) })],
    prepare: () => {}, quitAndInstall: () => assert.fail('Unexpected update restart'),
  });
  let prevented = 0;
  app.emit('before-quit', { preventDefault() { prevented++; } });
  app.emit('before-quit', { preventDefault() { prevented++; } });
  assert.equal(prevented, 2);
  assert.equal(quits, 0);
  t.mock.timers.tick(3000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quits, 0);
  t.mock.timers.tick(3000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quits, 1, 'Quit continues after both cleanup deadlines');
  assert.equal(warnings.mock.callCount(), 2);
});

test('a failed session does not skip other session cleanup or an update restart', async t => {
  t.mock.method(console, 'warn', () => {});
  let restarts = 0;
  let prepared = 0;
  /** @type {() => void} */
  let finish = () => {};
  const pending = new Promise(resolve => { finish = () => resolve(undefined); });
  const app = Object.assign(new EventEmitter(), { isReady: () => true, quit: () => assert.fail('Update Quit must use the installer') });
  const shutdown = setupShutdown({
    app: /** @type {any} */ (app), windows: () => [],
    sessions: () => [
      /** @type {any} */ ({ closeAllConnections: async () => { throw new Error('Network service unavailable'); } }),
      /** @type {any} */ ({ closeAllConnections: () => pending }),
    ],
    prepare: () => { prepared++; }, quitAndInstall: () => { restarts++; },
  });
  shutdown.quitAndInstall();
  shutdown.quitAndInstall();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prepared, 1);
  assert.equal(restarts, 0, 'The failed first session does not skip the pending second one');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restarts, 1);
});
