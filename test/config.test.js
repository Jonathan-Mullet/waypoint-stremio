// test/config.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const TEST_KEY = 'a'.repeat(64);
process.env.CIPHER_KEY = TEST_KEY;

const { resolveConfig, encryptConfig, _resetTokenCacheForTesting } = require('../src/config.js');

// A valid 1-day token is still within the refresh threshold? No — threshold is 1h,
// so a token with >1h life is used as-is and never triggers a refresh in tests.
const DAY = 24 * 60 * 60 * 1000;

function makeConfig(overrides = {}) {
  const access_token = 'acc_tok_' + Math.random().toString(36).slice(2);
  return {
    v: 1,
    client_id: 'cid123',
    client_secret: 'csec456',
    access_token,
    refresh_token: 'ref_tok',
    expires_at: Date.now() + 90 * 24 * 60 * 60 * 1000,
    user_key: crypto.createHash('sha256').update(access_token.slice(0,32)).digest('hex').slice(0,16),
    ...overrides,
  };
}

test('encryptConfig produces base64url string', () => {
  assert.match(encryptConfig(makeConfig()), /^[A-Za-z0-9_-]+$/);
});

test('resolveConfig decrypts and returns config', async () => {
  const cfg = makeConfig();
  const resolved = await resolveConfig(encryptConfig(cfg));
  assert.strictEqual(resolved.client_id, 'cid123');
  assert.strictEqual(resolved.access_token, cfg.access_token);
  assert.strictEqual(resolved.user_key, cfg.user_key);
});

test('resolveConfig: invalid base64url chars → throws', async () => {
  await assert.rejects(() => resolveConfig('not valid!!'), /invalid/i);
});

test('resolveConfig: tampered ciphertext → throws', async () => {
  const enc = encryptConfig(makeConfig());
  // Tamper a mid-string character (not the last) to avoid base64url padding no-op
  const mid = Math.floor(enc.length / 2);
  const tampered = enc.slice(0, mid) + (enc[mid] === 'A' ? 'B' : 'A') + enc.slice(mid + 1);
  await assert.rejects(() => resolveConfig(tampered));
});

test('resolveConfig: unsupported version → throws', async () => {
  await assert.rejects(() => resolveConfig(encryptConfig(makeConfig({ v: 99 }))), /unsupported/i);
});

test('resolveConfig: missing required field → throws', async () => {
  const cfg = makeConfig(); delete cfg.access_token;
  await assert.rejects(() => resolveConfig(encryptConfig(cfg)), /missing/i);
});

test('resolveConfig: valid token (>1h life) is returned as-is, no refresh', async () => {
  _resetTokenCacheForTesting();
  let refreshed = false;
  const cfg = makeConfig({ expires_at: Date.now() + DAY });
  const resolved = await resolveConfig(encryptConfig(cfg), {
    _refresh: async () => { refreshed = true; throw new Error('should not be called'); },
  });
  assert.strictEqual(resolved.access_token, cfg.access_token);
  assert.strictEqual(refreshed, false, 'a token with >1h life must not be refreshed');
});

test('resolveConfig: expired token is refreshed and returns the fresh access token', async () => {
  _resetTokenCacheForTesting();
  const enc = encryptConfig(makeConfig({ expires_at: Date.now() - 1000 }));
  const resolved = await resolveConfig(enc, {
    _refresh: async () => ({ access_token: 'fresh_acc', refresh_token: 'fresh_ref', expires_at: Date.now() + DAY }),
  });
  assert.strictEqual(resolved.access_token, 'fresh_acc');
  assert.ok(resolved.expires_at > Date.now());
});

test('resolveConfig: expired token + failing refresh → TOKEN_EXPIRED', async () => {
  _resetTokenCacheForTesting();
  const enc = encryptConfig(makeConfig({ expires_at: Date.now() - 1000 }));
  const err = await resolveConfig(enc, {
    _refresh: async () => { throw new Error('refresh failed'); },
  }).catch(e => e);
  assert.strictEqual(err.code, 'TOKEN_EXPIRED');
});

test('resolveConfig: concurrent refreshes for one user collapse into a single Trakt call', async () => {
  _resetTokenCacheForTesting();
  const enc = encryptConfig(makeConfig({ expires_at: Date.now() - 1000 }));
  let calls = 0;
  const _refresh = async () => {
    calls++;
    await new Promise(r => setTimeout(r, 20)); // latency so the parallel calls overlap
    return { access_token: 'shared_acc', refresh_token: 'rotated_ref', expires_at: Date.now() + DAY };
  };
  // Stremio fires the catalog + several meta requests at once — simulate that burst.
  const results = await Promise.all([
    resolveConfig(enc, { _refresh }),
    resolveConfig(enc, { _refresh }),
    resolveConfig(enc, { _refresh }),
  ]);
  assert.strictEqual(calls, 1, 'concurrent refreshes must share one refresh (Trakt rotates the token)');
  for (const r of results) assert.strictEqual(r.access_token, 'shared_acc');
});

test('resolveConfig: a refreshed token is cached and reused without re-refreshing', async () => {
  _resetTokenCacheForTesting();
  const cfg = makeConfig({ expires_at: Date.now() - 1000 });
  const enc = encryptConfig(cfg);
  let calls = 0;
  const _refresh = async () => { calls++; return { access_token: 'cached_acc', refresh_token: 'cached_ref', expires_at: Date.now() + DAY }; };
  await resolveConfig(enc, { _refresh });           // first: refreshes
  const second = await resolveConfig(enc, { _refresh }); // second: should use cache (token now valid >1h)
  assert.strictEqual(calls, 1, 'second resolve must reuse the cached fresh token');
  assert.strictEqual(second.access_token, 'cached_acc');
});
