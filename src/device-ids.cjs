// Maps a native CoreAudio device UID to the deviceId Chromium exposes to one
// connection's page. This is the only code that depends on Electron/Chromium
// internals; test/device-id-app.cjs verifies it against enumerateDevices().
//
// Chromium (content/browser/media/media_devices_util.cc, GetHMACForRawMediaDeviceID):
//   deviceId = hex(HMAC-SHA256(key = origin.Serialize(), rawId + device_id_salt))
// with 'default'/'communications' passed through. On macOS rawId is the CoreAudio
// kAudioDevicePropertyDeviceUID (media/audio/mac/core_audio_util_mac.cc).
// Electron (shell/browser/electron_browser_client.cc GetMediaDeviceIDSalt) always
// allows persistent IDs, so device_id_salt is the session's pref
// "electron.media.device_id_salt" (shell/browser/media/media_device_id_salt.cc).
// It is created on the session's first media device request and written with the
// session's Preferences file (JsonPrefStore, committed after up to 10 seconds).
// Clearing cookies replaces it. There is no API to read it, so the file is read
// without ever being written. Never log the salt: it would make IDs linkable.
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** The versions whose sources were checked; another runtime must be re-verified. */
const verifiedRuntime = { electron: '44.5.1', chrome: '152.0.7977.130' };
const saltPattern = /^[0-9A-F]{32}$/;

/** @param {string} origin serialized origin, e.g. https://glkvm.local @param {string} uid @param {string} salt */
function browserDeviceId(origin, uid, salt) {
  return createHmac('sha256', origin).update(uid, 'utf8').update(salt, 'utf8').digest('hex');
}

/** @param {string} storagePath session.getStoragePath() @returns {string | null} */
function readDeviceIdSalt(storagePath) {
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(storagePath, 'Preferences'), 'utf8'));
    const salt = prefs?.electron?.media?.device_id_salt;
    return typeof salt === 'string' && saltPattern.test(salt) ? salt : null;
  } catch { return null; }
}

/** Whether this runtime is the one the mapping was verified for. @param {NodeJS.ProcessVersions} versions */
function supportedRuntime(versions) {
  return versions.electron === verifiedRuntime.electron && versions.chrome === verifiedRuntime.chrome;
}

module.exports = { browserDeviceId, readDeviceIdSalt, supportedRuntime, verifiedRuntime };
