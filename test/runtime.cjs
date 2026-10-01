const { app, safeStorage } = require('electron');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');

if (!app.isPackaged) {
  console.error('GUI fixtures require the signed GLKVM bundle. Run bun run test:gui.');
  app.exit(1);
  throw new Error('Generic Electron is not a supported GUI test runtime.');
}

// Fixtures exercise saved-password workflows without accessing the user's keychain.
const key = randomBytes(32);
/** @param {string} value */
function encrypt(value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}
/** @param {Buffer} value */
function decrypt(value) {
  const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
  cipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
}
safeStorage.isEncryptionAvailable = () => true;
safeStorage.isAsyncEncryptionAvailable = async () => true;
safeStorage.encryptString = encrypt;
safeStorage.decryptString = decrypt;
safeStorage.encryptStringAsync = async value => encrypt(value);
safeStorage.decryptStringAsync = async value => ({ result: decrypt(value), shouldReEncrypt: false });
