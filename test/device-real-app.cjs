require('./runtime.cjs');
const { app, BrowserWindow, session, systemPreferences } = require('electron');
const { createServer } = require('node:http');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaults } = require('../src/config.cjs');
const { catalogPath, parseCatalog } = require('../src/audio-catalog.cjs');
const { browserDeviceId, readDeviceIdSalt } = require('../src/device-ids.cjs');

// Real hardware, read-only: the signed catalog vs the Settings dropdowns with no
// connection window, and native UID -> deviceId vs enumerateDevices() in two
// temporary sessions. Permission checks only expose IDs; every request is denied.
// Nothing is captured or played, and no default device is changed.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glkvm-real-'));
const evidence = process.env.GLKVM_AUDIO_EVIDENCE;
app.setPath('userData', directory);
const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Device ID proof</title>'); });
/** @param {() => unknown | Promise<unknown>} condition @param {string} label @param {number} [tries] */
async function waitFor(condition, label, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

server.listen(0, '127.0.0.1', async () => {
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const config = defaults();
  config.devices = [{ id: 'closed', name: 'Closed', origin: `http://127.0.0.1:${port}`, openAtStartup: false }];
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(config));
  const access = systemPreferences.getMediaAccessStatus('microphone');
  await app.whenReady();
  /** @type {string[]} */
  const requests = [];
  require('../src/main.cjs');
  try {
    const native = /** @type {import('../src/audio-catalog.cjs').NativeDevice[]} */ (parseCatalog(execFileSync(catalogPath(process.resourcesPath), { encoding: 'utf8' }).trim()));
    assert.ok(native, 'The signed catalog runs');
    const inputs = native.filter(device => device.input);
    const outputs = native.filter(device => device.output);

    await waitFor(() => BrowserWindow.getAllWindows().some(win => win.getTitle() === 'GLKVM Clean Settings'), 'settings');
    const settings = /** @type {Electron.BrowserWindow} */ (BrowserWindow.getAllWindows().find(win => win.getTitle() === 'GLKVM Clean Settings'));
    await waitFor(() => !settings.webContents.isLoading() && settings.webContents.executeJavaScript("document.querySelectorAll('.audio-foreground-output option').length > 1"), 'settings device list');
    assert.deepEqual(BrowserWindow.getAllWindows().map(win => win.getTitle()), ['GLKVM Clean Settings'], 'No connection window');
    /** @type {string[][]} */
    const shown = await settings.webContents.executeJavaScript(`['.audio-foreground-input', '.audio-background-input', '.audio-foreground-output', '.audio-background-output'].map(selector => [...document.querySelector(selector).options].filter(option => option.value.startsWith('uid:')).map(option => option.value.slice(4)))`);
    for (const list of shown.slice(0, 2)) assert.deepEqual(list, inputs.map(device => device.uid), 'Every native input in both microphone dropdowns');
    for (const list of shown.slice(2)) assert.deepEqual(list, outputs.map(device => device.uid), 'Every native output in both speaker dropdowns');
    const labels = await settings.webContents.executeJavaScript("[...document.querySelector('.audio-foreground-input').options, ...document.querySelector('.audio-foreground-output').options].map(option => option.textContent)");
    if (evidence) fs.writeFileSync(path.join(evidence, 'settings-all-devices-real.png'), (await settings.webContents.capturePage()).toPNG());

    // Mapping proof in two fresh temporary sessions at two origins.
    const proofs = [];
    for (const [name, origin] of [['proof-a', `http://127.0.0.1:${port}`], ['proof-b', `http://localhost:${port}`]]) {
      const ses = session.fromPartition(`persist:${name}`);
      ses.setPermissionCheckHandler((_contents, permission, _origin, details) => permission === 'speaker-selection' || (permission === 'media' && details.mediaType === 'audio'));
      ses.setPermissionRequestHandler((_contents, permission, callback) => { requests.push(permission); callback(false); });
      const win = new BrowserWindow({ show: false, webPreferences: { partition: `persist:${name}`, sandbox: true, contextIsolation: true } });
      await win.loadURL(`${origin}/`);
      /** @type {{kind: string, deviceId: string, label: string}[]} */
      const listed = await win.webContents.executeJavaScript("navigator.mediaDevices.enumerateDevices().then(list => list.filter(device => device.kind !== 'videoinput' && device.deviceId !== 'default').map(device => ({ kind: device.kind, deviceId: device.deviceId, label: device.label })))");
      const storage = /** @type {string} */ (ses.getStoragePath());
      await waitFor(() => readDeviceIdSalt(storage), 'persisted salt', 250);
      const salt = /** @type {string} */ (readDeviceIdSalt(storage));
      /** @type {string[]} */
      const unmatched = [];
      const result = { origin, inputs: 0, outputs: 0, unmatched };
      for (const [kind, devices] of /** @type {const} */ ([['audioinput', inputs], ['audiooutput', outputs]])) {
        const page = listed.filter(device => device.kind === kind);
        const mapped = devices.map(device => browserDeviceId(origin, device.uid, salt));
        for (const device of devices) if (!page.some(item => item.deviceId === browserDeviceId(origin, device.uid, salt))) result.unmatched.push(`${kind} native ${device.name}`);
        for (const item of page) if (!mapped.includes(item.deviceId)) result.unmatched.push(`${kind} page ${item.label}`);
        if (kind === 'audioinput') result.inputs = page.length; else result.outputs = page.length;
      }
      proofs.push(result);
      win.destroy();
    }
    const report = { versions: { electron: process.versions.electron, chrome: process.versions.chrome }, nativeInputs: inputs.map(device => `${device.name} [${device.transport || 'no transport'}]`), nativeOutputs: outputs.map(device => `${device.name} [${device.transport || 'no transport'}]`), settingsLabels: labels, settingsCounts: shown.map(list => list.length), proofs, requests, microphoneAccess: { before: access, after: systemPreferences.getMediaAccessStatus('microphone') } };
    console.log(JSON.stringify(report, null, 2));
    if (evidence) fs.writeFileSync(path.join(evidence, 'device-real-app.json'), `${JSON.stringify(report, null, 2)}\n`);
    for (const proof of proofs) {
      assert.deepEqual(proof.unmatched, [], `Every native device maps to exactly one enumerated ID at ${proof.origin}`);
      assert.deepEqual([proof.inputs, proof.outputs], [inputs.length, outputs.length]);
    }
    assert.deepEqual(requests, [], 'No permission was requested');
    assert.equal(systemPreferences.getMediaAccessStatus('microphone'), access, 'Microphone access status unchanged');
    console.log(`PASS: real hardware read-only — ${inputs.length} inputs / ${outputs.length} outputs in the signed Settings dropdowns without a connection window; exact UID->deviceId mapping at two origins; no permission request`);
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { server.close(); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
