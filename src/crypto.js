const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const NONCE_BYTES = 12;  // 96-bit nonce (GCM recommendation)
const TAG_BYTES = 16;    // 128-bit auth tag
const MIN_BYTES = NONCE_BYTES + TAG_BYTES + 1;

// Layout: nonce(12) | tag(16) | ciphertext → base64url
function encrypt(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ciphertext]).toString('base64url');
}

function decrypt(encoded, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const buf = Buffer.from(encoded, 'base64url');
  if (buf.length < MIN_BYTES) throw new Error('ciphertext too short');
  const nonce      = buf.subarray(0, NONCE_BYTES);
  const tag        = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
