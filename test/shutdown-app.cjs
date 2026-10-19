require('./runtime.cjs');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupShutdown } = require('../src/shutdown.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-shutdown-'));
app.setPath('userData', directory);
let socketOpened = false;
let socketClosed = false;
let cleanupCalls = 0;
let cleanupComplete = false;
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>Shutdown fixture</title>');
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  assert.equal(typeof key, 'string');
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socketOpened = true;
  // The fixture sends no data: acknowledge the browser's close frame.
  socket.on('data', data => { if ((data[0] & 15) === 8) socket.end(Buffer.from([0x88, 0])); });
  socket.on('close', () => { socketClosed = true; });
  socket.on('error', () => {});
});
/** @param {() => unknown | Promise<unknown>} condition */
async function waitFor(condition) {
  for (let i = 0; i < 150; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for shutdown fixture.');
}
server.listen(0, '127.0.0.1', async () => {
  try {
    await app.whenReady();
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const connection = new BrowserWindow({ show: false, webPreferences: { partition: 'shutdown-connection', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    // This test-only remote peer stays alive during the drain so it can
    // confirm that the connection's real WebRTC transport was disconnected.
    const remote = new BrowserWindow({ show: false, webPreferences: { partition: 'shutdown-observer', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await Promise.all([connection.loadURL(origin), remote.loadURL(origin)]);
    /** @param {Electron.BrowserWindow} win @param {string} code */
    const run = (win, code) => win.webContents.executeJavaScript(code);
    await run(connection, `window.pc = new RTCPeerConnection({iceServers: []}); window.channel = pc.createDataChannel('shutdown'); window.socket = new WebSocket('${origin.replace('http:', 'ws:')}'); window.addEventListener('beforeunload', event => { event.returnValue = false; });`);
    await run(remote, `window.pc = new RTCPeerConnection({iceServers: []}); pc.ondatachannel = event => { window.channel = event.channel; }; void 0;`);
    const offer = await run(connection, `pc.createOffer().then(async offer => { await pc.setLocalDescription(offer); await new Promise(resolve => { if (pc.iceGatheringState === 'complete') resolve(); else pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); }; }); return pc.localDescription.toJSON(); })`);
    const answer = await run(remote, `pc.setRemoteDescription(${JSON.stringify(offer)}).then(() => pc.createAnswer()).then(async answer => { await pc.setLocalDescription(answer); await new Promise(resolve => { if (pc.iceGatheringState === 'complete') resolve(); else pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); }; }); return pc.localDescription.toJSON(); })`);
    await run(connection, `pc.setRemoteDescription(${JSON.stringify(answer)})`);
    await waitFor(() => run(connection, `channel.readyState === 'open' && socket.readyState === WebSocket.OPEN`));
    await waitFor(() => run(remote, `window.channel?.readyState === 'open'`));
    assert.equal(socketOpened, true);
    const ses = connection.webContents.session;
    const nativeClose = ses.closeAllConnections.bind(ses);
    ses.closeAllConnections = async () => {
      cleanupCalls++;
      assert.equal(connection.webContents.getURL(), 'about:blank', 'The connection document is gone before the session is drained');
      await nativeClose();
      assert.equal(socketClosed, true, 'Session cleanup completes after the WebSocket disconnects');
      assert.equal(await run(remote, `channel.readyState`), 'closed', 'The remote WebRTC channel has closed without a fixture delay');
      cleanupComplete = true;
    };
    setupShutdown({ app, windows: () => [connection], sessions: () => [ses, ses], prepare: () => {}, quitAndInstall: () => { throw new Error('Ordinary Quit must not install updates.'); } });
    app.once('will-quit', event => {
      event.preventDefault();
      try {
        assert.equal(cleanupCalls, 1, 'Repeated Quit and shared sessions run cleanup once');
        assert.equal(cleanupComplete, true, 'The live WebRTC transport and session finish cleanup before native shutdown');
        assert.equal(socketClosed, true, 'The WebSocket is closed before native shutdown');
        console.log('PASS: Quit unloads a live WebRTC/WebSocket page despite beforeunload, drains shared sessions once, and handles repeated Quit');
        fs.rmSync(directory, { recursive: true, force: true });
        server.close();
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    });
    app.quit();
    app.quit();
  } catch (error) {
    console.error(error);
    server.closeAllConnections();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
    app.exit(1);
  }
});
