const crypto = require('crypto');
const { encrypt, decrypt } = require('./crypto');
const { createCache } = require('./cache');
const { refreshToken } = require('./providers/trakt');

const CIPHER_KEY = () => process.env.CIPHER_KEY || '';

// Trakt access tokens are short-lived (~7 days) and Trakt ROTATES the refresh
// token on every refresh. We keep the latest rotated token pair in memory keyed
// by user_key. The URL-embedded pair is the cold-start seed: for the first ~7
// days the embedded access token is valid and no refresh happens, so restarts
// are harmless. After it expires we refresh (using the latest refresh token) and
// cache the result. NOTE: because the embedded refresh token is single-use once
// rotated, a container restart AFTER the embedded access token has expired can
// require the user to re-authenticate (the in-memory rotated token is gone and
// the embedded one is already consumed). Persistent storage of the rotated token
// would remove that edge — a future enhancement if Beamup restarts prove frequent.
const _tokenCache = createCache({ maxSize: 50000, ttlMs: 90 * 24 * 60 * 60 * 1000 });
// Refresh when the access token has less than this much life left.
const REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

// In-flight refreshes, keyed by user_key, to dedupe concurrent refreshes. Stremio
// fires the catalog + several meta requests in PARALLEL; without this each would call
// Trakt's refresh with the same refresh_token, but Trakt rotates the refresh token on
// first use — so all but the first would fail with an already-consumed token (and, if
// the embedded access token is also expired, surface a spurious "reconnect"). Sharing
// one refresh per user_key means concurrent callers all receive the single rotated pair.
const _inflightRefresh = new Map();

function _refreshShared(userKey, args, _refresh) {
  let p = _inflightRefresh.get(userKey);
  if (!p) {
    p = Promise.resolve()
      .then(() => _refresh(args))
      .then((fresh) => { _tokenCache.set(userKey, fresh); return fresh; })
      .finally(() => { _inflightRefresh.delete(userKey); });
    _inflightRefresh.set(userKey, p);
  }
  return p;
}

// Refresh implementation — overridable so tests stay hermetic (no real Trakt calls
// when resolveConfig is reached through the HTTP layer). Defaults to the real one.
let _refreshImpl = refreshToken;
function _setRefreshForTesting(fn) { _refreshImpl = fn; }
function _resetTokenCacheForTesting() { _tokenCache.reset(); _inflightRefresh.clear(); }

// Compute user_key from an access_token. Called at encryption time so the key is
// stable for the life of the install regardless of later token rotation.
function deriveUserKey(access_token) {
  return crypto.createHash('sha256').update(String(access_token).slice(0, 32)).digest('hex').slice(0, 16);
}

// Encrypt config object → URL-safe blob. Derives and embeds user_key.
function encryptConfig(config) {
  const blob = { ...config, user_key: deriveUserKey(config.access_token) };
  return encrypt(JSON.stringify(blob), CIPHER_KEY());
}

// Decrypt + validate URL config param, refreshing the Trakt access token when
// needed. Returns a resolved config carrying a currently-valid access_token.
// opts._refresh is injectable for tests.
async function resolveConfig(encoded, { _refresh = _refreshImpl } = {}) {
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

  // Start from the URL-embedded token, then prefer any fresher cached token.
  let access_token = config.access_token;
  let refresh_token = config.refresh_token;
  let expires_at = config.expires_at;

  const cached = _tokenCache.get(config.user_key);
  if (cached) {
    refresh_token = cached.refresh_token; // always use the latest rotated refresh token
    if (cached.expires_at > expires_at) {
      access_token = cached.access_token;
      expires_at = cached.expires_at;
    }
  }

  // Refresh when the access token is expired or about to expire. Concurrent requests
  // for the same user share ONE refresh (see _refreshShared) so the rotated refresh
  // token isn't consumed by a race.
  if (expires_at - Date.now() < REFRESH_THRESHOLD_MS) {
    try {
      const fresh = await _refreshShared(config.user_key, {
        client_id: config.client_id,
        client_secret: config.client_secret,
        refresh_token,
      }, _refresh);
      access_token = fresh.access_token;
      expires_at = fresh.expires_at;
    } catch (e) {
      // Refresh failed. If the access token is already dead, the user must reconnect.
      if (expires_at <= Date.now()) {
        throw Object.assign(new Error('Trakt token expired — reconnect required'), { code: 'TOKEN_EXPIRED' });
      }
      // Otherwise the current access token is still valid for a short while; proceed.
    }
  }

  return { ...config, access_token, expires_at };
}

module.exports = { resolveConfig, encryptConfig, deriveUserKey, _setRefreshForTesting, _resetTokenCacheForTesting };
