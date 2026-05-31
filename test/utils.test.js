// test/utils.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { fmtResumeTime, sanitize } = require('../src/utils.js');

test('fmtResumeTime: under 1 hour', () => {
  assert.strictEqual(fmtResumeTime(0), '0m 00s');
  assert.strictEqual(fmtResumeTime(90), '1m 30s');
  assert.strictEqual(fmtResumeTime(3599), '59m 59s');
});

test('fmtResumeTime: 1 hour or more', () => {
  assert.strictEqual(fmtResumeTime(3600), '1h 00m');
  assert.strictEqual(fmtResumeTime(5400), '1h 30m');
  assert.strictEqual(fmtResumeTime(7384), '2h 03m');
});

test('fmtResumeTime: negative and fractional', () => {
  assert.strictEqual(fmtResumeTime(-10), '0m 00s');
  assert.strictEqual(fmtResumeTime(61.9), '1m 01s');
});

test('sanitize: redacts token, secret, password, key fields', () => {
  const result = sanitize({
    access_token: 'abc',
    client_secret: 'xyz',
    client_id: 'pub123',      // 'id' alone does not match
    name: 'test',
    password: 'hunter2',
    api_key: 'secret',        // matches /key/i
    trakt_api_key: 'tok',     // matches /key/i
  });
  assert.strictEqual(result.access_token, '[redacted]');
  assert.strictEqual(result.client_secret, '[redacted]');
  assert.strictEqual(result.password, '[redacted]');
  assert.strictEqual(result.api_key, '[redacted]');
  assert.strictEqual(result.trakt_api_key, '[redacted]');
  assert.strictEqual(result.client_id, 'pub123');
  assert.strictEqual(result.name, 'test');
});

test('sanitize: handles non-object gracefully', () => {
  assert.strictEqual(sanitize(null), null);
  assert.strictEqual(sanitize('string'), 'string');
  assert.strictEqual(sanitize(42), 42);
});
