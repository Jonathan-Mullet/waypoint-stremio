// test/crypto.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { encrypt, decrypt } = require('../src/crypto.js');

const KEY = 'a'.repeat(64); // 32 bytes as hex

test('encrypt produces base64url output (no +, /, =)', () => {
  assert.match(encrypt('hello', KEY), /^[A-Za-z0-9_-]+$/);
});

test('encrypt+decrypt roundtrip', () => {
  const plain = JSON.stringify({ v: 1, client_id: 'test', access_token: 'tok' });
  assert.strictEqual(decrypt(encrypt(plain, KEY), KEY), plain);
});

test('two encryptions of same plaintext differ (random nonce)', () => {
  assert.notStrictEqual(encrypt('same', KEY), encrypt('same', KEY));
});

test('decrypt throws on tampered ciphertext', () => {
  const enc = encrypt('hello', KEY);
  const tampered = enc.slice(0, -1) + (enc.at(-1) === 'A' ? 'B' : 'A');
  assert.throws(() => decrypt(tampered, KEY));
});

test('decrypt throws on wrong key', () => {
  assert.throws(() => decrypt(encrypt('hello', KEY), 'b'.repeat(64)));
});

test('decrypt throws on too-short input', () => {
  assert.throws(() => decrypt('short', KEY));
});
