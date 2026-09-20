const { X509Certificate } = require('node:crypto');

/** @param {string} pem */
function fingerprint(pem) {
  try {
    return new X509Certificate(pem).fingerprint256;
  } catch {
    return null;
  }
}

/** @param {Record<string, string>} pins @param {string} hostname @param {string} pem */
function isPinned(pins, hostname, pem) {
  const hash = fingerprint(pem);
  return Boolean(hash && pins[hostname] === hash);
}

module.exports = { fingerprint, isPinned };
