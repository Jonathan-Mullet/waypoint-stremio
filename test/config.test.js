// test/config.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const TEST_KEY = 'a'.repeat(64);
process.env.CIPHER_KEY = TEST_KEY;

const { resolveConfig, encryptConfig } = require('../src/config.js');

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
  const tampered = enc.slice(0, -1) + (enc.at(-1) === 'A' ? 'B' : 'A');
  await assert.rejects(() => resolveConfig(tampered));
});

test('resolveConfig: unsupported version → throws', async () => {
  await assert.rejects(() => resolveConfig(encryptConfig(makeConfig({ v: 99 }))), /unsupported/i);
});

test('resolveConfig: missing required field → throws', async () => {
  const cfg = makeConfig(); delete cfg.access_token;
  await assert.rejects(() => resolveConfig(encryptConfig(cfg)), /missing/i);
});

test('resolveConfig: expired token → throws TOKEN_EXPIRED', async () => {
  const enc = encryptConfig(makeConfig({ expires_at: Date.now() - 1000 }));
  const err = await resolveConfig(enc).catch(e => e);
  assert.strictEqual(err.code, 'TOKEN_EXPIRED');
});

test('resolveConfig: token expiring within 14 days → expiringWarning: true', async () => {
  const enc = encryptConfig(makeConfig({ expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
  const resolved = await resolveConfig(enc);
  assert.strictEqual(resolved.expiringWarning, true);
});

test('resolveConfig: token valid 30+ days → no warning', async () => {
  const enc = encryptConfig(makeConfig());
  const resolved = await resolveConfig(enc);
  assert.ok(!resolved.expiringWarning);
});
