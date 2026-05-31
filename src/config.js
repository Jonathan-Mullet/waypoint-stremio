const crypto = require('crypto');
const { encrypt, decrypt } = require('./crypto');

const CIPHER_KEY = () => process.env.CIPHER_KEY || '';
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Compute user_key from an access_token.
// Called at encryption time so the key is stable regardless of token rotation.
function deriveUserKey(access_token) {
  return crypto.createHash('sha256').update(String(access_token).slice(0, 32)).digest('hex').slice(0, 16);
}

// Encrypt config object → URL-safe blob. Derives and embeds user_key.
function encryptConfig(config) {
  const blob = { ...config, user_key: deriveUserKey(config.access_token) };
  return encrypt(JSON.stringify(blob), CIPHER_KEY());
}

// Decrypt + validate URL config param. Returns resolved config with expiry metadata.
async function resolveConfig(encoded) {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid config encoding');

  let raw;
  try { raw = decrypt(encoded, CIPHER_KEY()); }
  catch { throw new Error('config decryption failed'); }

  let config;
  try { config = JSON.parse(raw); }
  catch { throw new Error('config parse failed'); }

  // Version dispatch — add cases here for v2, v3, etc.
  if (config.v !== 1) throw new Error('unsupported config version');

  const required = ['client_id', 'client_secret', 'access_token', 'refresh_token', 'expires_at', 'user_key'];
  for (const field of required) {
    if (!config[field]) throw new Error(`config missing required field: ${field}`);
  }

  if (config.expires_at <= Date.now()) {
    throw Object.assign(new Error('Trakt token expired — reconnect required'), { code: 'TOKEN_EXPIRED' });
  }

  const expiringWarning = config.expires_at - Date.now() <= FOURTEEN_DAYS_MS;
  return { ...config, expiringWarning };
}

module.exports = { resolveConfig, encryptConfig, deriveUserKey };
