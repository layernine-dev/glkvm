require('./runtime.cjs');
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-browser-'));
app.setPath('userData', directory);

/** @param {Electron.BrowserWindow} win @param {string} expression */
async function waitFor(win, expression) {
  for (let i = 0; i < 80; i++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${expression}`);
}
app.whenReady().then(async () => {
  /** @type {{width: number, height: number}[]} */
  const sizes = [];
  let loginRequests = 0;
  ipcMain.on('glkvm:login-required', () => { loginRequests++; });
  ipcMain.on('glkvm:video-size', (_event, size) => sizes.push(size));
  const win = new BrowserWindow({ width: 960, height: 540, frame: false, roundedCorners: false, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  /** @type {string[]} */
  const errors = [];
  win.webContents.on('preload-error', (_event, _preload, error) => errors.push(error.message));
  /** @param {boolean} controlEnabled @param {boolean} [moving] */
  async function mode(controlEnabled, moving = false) {
    win.webContents.send('glkvm:mode', { controlEnabled, moving });
    await waitFor(win, `document.documentElement.hasAttribute('data-glkvm-control') === ${controlEnabled && !moving}`);
  }
  try {
    await win.loadFile(path.join(__dirname, 'fixture.html'));
    assert.equal(await win.webContents.executeJavaScript('typeof require'), 'undefined');
    assert.equal(await win.webContents.executeJavaScript('typeof settings'), 'undefined');
    assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.body).visibility'), 'hidden');
    await win.webContents.executeJavaScript("document.querySelector('#password').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A' });
    assert.equal(await win.webContents.executeJavaScript('window.inputEvents'), 0);
    await win.webContents.executeJavaScript('window.connect()');
    await waitFor(win, "document.documentElement.hasAttribute('data-glkvm-clean') && document.querySelector('#glkvm-clean-status').hidden");
    assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('#toolbar')).visibility"), 'hidden');
    assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('#stream-video')).visibility"), 'visible');
    assert.deepEqual(sizes.at(-1), { width: 640, height: 360 });
    const before = await win.webContents.executeJavaScript("document.querySelector('#stream-video').getVideoPlaybackQuality().totalVideoFrames");
    await waitFor(win, `document.querySelector('#stream-video').getVideoPlaybackQuality().totalVideoFrames > ${before}`);
    // Experimental pause releases local playback while preserving the live stream.
    win.webContents.send('glkvm:background-video', true);
    await waitFor(win, "document.querySelector('#stream-video').paused");
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('#stream-video').srcObject.getVideoTracks()[0].readyState"), 'live');
    await win.webContents.executeJavaScript("void document.querySelector('#stream-video').play()");
    await waitFor(win, "document.querySelector('#stream-video').paused");
    win.webContents.send('glkvm:background-video', false);
    await waitFor(win, "!document.querySelector('#stream-video').paused");
    const resumed = await win.webContents.executeJavaScript("document.querySelector('#stream-video').getVideoPlaybackQuality().totalVideoFrames");
    await waitFor(win, `document.querySelector('#stream-video').getVideoPlaybackQuality().totalVideoFrames > ${resumed}`);
    // A video paused by the page must stay paused after the experiment is disabled.
    await win.webContents.executeJavaScript("document.querySelector('#stream-video').pause()");
    win.webContents.send('glkvm:background-video', true);
    await new Promise(resolve => setTimeout(resolve, 600));
    win.webContents.send('glkvm:background-video', false);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('#stream-video').paused"), true);
    await win.webContents.executeJavaScript("document.querySelector('#stream-video').play()");
    const pixels = (await win.webContents.capturePage()).toBitmap();
    for (const [x, y] of [[480, 270], [200, 2], [2, 270], [958, 270], [480, 538]]) {
      const offset = (y * 960 + x) * 4;
      assert.ok(pixels[offset + 1] > 150 && pixels[offset + 2] < 80, `Video reaches frame edge (${x}, ${y}) without vendor chrome`);
    }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B' });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 480, y: 270, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 480, y: 270, button: 'left', clickCount: 1 });
    assert.equal(await win.webContents.executeJavaScript('window.inputEvents'), 0);
    assert.equal(await win.webContents.executeJavaScript('window.mouseEvents'), 0);
    await mode(true);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 480, y: 270 });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 480, y: 270, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 480, y: 270, button: 'left', clickCount: 1 });
    await waitFor(win, 'window.mouseEvents === 1');
    assert.deepEqual(await win.webContents.executeJavaScript('window.lastPoint'), { x: .5, y: .5, target: 'video-wrapper' });
    assert.equal(await win.webContents.executeJavaScript('document.activeElement.id'), 'stream-box');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B' });
    await waitFor(win, 'window.inputEvents === 1 && window.keyReleases === 1');
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: 480, y: 270, deltaY: 100, canScroll: true });
    await waitFor(win, 'window.scrollEvents > 0');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 480, y: 270, button: 'left' });
    await waitFor(win, 'window.inputEvents === 2 && window.mouseEvents === 2');
    await mode(false);
    await waitFor(win, 'window.keyReleases === 2 && window.mouseReleases === 2');
    assert.equal(await win.webContents.executeJavaScript('document.activeElement.id'), '');
    await mode(true, true);
    assert.equal(await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('#glkvm-clean-drag')).display"), 'block');
    await mode(true);
    win.setContentSize(800, 800);
    await waitFor(win, "Math.round(document.querySelector('#video-wrapper').getBoundingClientRect().height) === 450");
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 400, y: 400 });
    await waitFor(win, 'window.lastPoint.x === .5 && window.lastPoint.y === .5');
    await win.webContents.executeJavaScript('window.disconnect()');
    await waitFor(win, "!document.querySelector('#glkvm-clean-status').hidden");
    await win.webContents.executeJavaScript('window.connect(800, 600)');
    await waitFor(win, "document.querySelector('#stream-video').videoWidth === 800 && document.querySelector('#glkvm-clean-status').hidden");
    assert.deepEqual(sizes.at(-1), { width: 800, height: 600 });
    await win.webContents.executeJavaScript('window.logout()');
    await waitFor(win, "!document.querySelector('#glkvm-clean-status').hidden && document.querySelector('#glkvm-clean-status').textContent.includes('Sign in')");
    assert.equal(await win.webContents.executeJavaScript('getComputedStyle(document.body).visibility'), 'hidden');
    await win.webContents.executeJavaScript('window.connect()');
    await waitFor(win, "document.querySelector('#glkvm-clean-status').hidden");
    win.webContents.send('glkvm:mode', { controlEnabled: true, moving: false, options: true });
    await waitFor(win, "document.documentElement.hasAttribute('data-glkvm-options')");
    const requestsBeforeExpiry = loginRequests;
    await win.webContents.executeJavaScript('window.logout()');
    await waitFor(win, "document.querySelector('#password') !== null");
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(loginRequests, requestsBeforeExpiry + 1, 'Expired sessions request automatic login exactly once with options visible');
    assert.deepEqual(errors, []);
    console.log('PASS: protected login/logout, isolation, edge-to-edge live video, view-only gate, native player input, coordinates, scroll, key/button release, drag mode, reconnect, aspect changes, logout');
    fs.rmSync(directory, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    fs.rmSync(directory, { recursive: true, force: true });
    app.exit(1);
  }
});
