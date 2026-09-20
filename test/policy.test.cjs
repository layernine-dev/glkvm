const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rootCertificates } = require('node:tls');
const { devices, isDeviceURL } = require('../src/devices.cjs');
const { fingerprint, isPinned } = require('../src/certificates.cjs');

test('navigation stays on the selected device origin', () => {
  for (const device of devices) {
    assert.ok(isDeviceURL(`${device.origin}/#/login`, device));
    assert.ok(!isDeviceURL(`${device.origin}.evil.test/`, device));
    assert.ok(!isDeviceURL(device.origin.replace('https:', 'http:'), device));
    assert.ok(!isDeviceURL(`${device.origin}:444/`, device));
    assert.ok(!isDeviceURL(device.origin.replace('https://', 'https://admin:password@'), device));
    assert.ok(!isDeviceURL('file:///etc/passwd', device));
    assert.ok(!isDeviceURL('not a URL', device));
  }
  assert.ok(!isDeviceURL('https://other.test', devices[0]));
});

test('certificate exceptions require both the exact host and certificate', () => {
  const cert = rootCertificates[0];
  const hash = fingerprint(cert);
  assert.ok(hash);
  const pins = { 'device.test': hash };
  assert.ok(isPinned(pins, 'device.test', cert));
  assert.ok(!isPinned(pins, 'different.test', cert));
  assert.ok(!isPinned(pins, 'device.test', rootCertificates[1]));
  assert.ok(!isPinned(pins, 'device.test', 'invalid certificate'));
  assert.equal(fingerprint(''), null);
});
