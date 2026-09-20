const devices = Object.freeze([
  { id: 'glkvm', name: 'GLKVM', origin: 'https://glkvm.local' },
]);

/** @param {string} value @param {{origin: string}} device */
function isDeviceURL(value, device) {
  try {
    const url = new URL(value);
    return url.origin === device.origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

module.exports = { devices, isDeviceURL };
