// test/cache.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { createCache } = require('../src/cache.js');

test('get returns undefined for missing key', () => {
  const c = createCache({ maxSize: 10, ttlMs: 60000 });
  assert.strictEqual(c.get('x'), undefined);
});

test('set and get roundtrip', () => {
  const c = createCache({ maxSize: 10, ttlMs: 60000 });
  c.set('k', { value: 42 });
  assert.deepStrictEqual(c.get('k'), { value: 42 });
});

test('expired entries return undefined', () => {
  const c = createCache({ maxSize: 10, ttlMs: 1 });
  c.set('k', 'v');
  return new Promise(resolve => setTimeout(() => {
    assert.strictEqual(c.get('k'), undefined);
    resolve();
  }, 10));
});

test('evicts oldest entry when maxSize reached', () => {
  const c = createCache({ maxSize: 3, ttlMs: 60000 });
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  c.set('d', 4); // evicts 'a'
  assert.strictEqual(c.get('a'), undefined);
  assert.strictEqual(c.get('d'), 4);
});

test('get refreshes LRU position', () => {
  const c = createCache({ maxSize: 2, ttlMs: 60000 });
  c.set('a', 1); c.set('b', 2);
  c.get('a'); // refresh 'a'
  c.set('c', 3); // should evict 'b', not 'a'
  assert.strictEqual(c.get('b'), undefined);
  assert.strictEqual(c.get('a'), 1);
});

test('per-entry TTL override', () => {
  const c = createCache({ maxSize: 10, ttlMs: 60000 });
  c.set('k', 'v', 1); // 1ms TTL override
  return new Promise(resolve => setTimeout(() => {
    assert.strictEqual(c.get('k'), undefined);
    resolve();
  }, 10));
});

test('size() returns current entry count', () => {
  const c = createCache({ maxSize: 10, ttlMs: 60000 });
  assert.strictEqual(c.size(), 0);
  c.set('a', 1); c.set('b', 2);
  assert.strictEqual(c.size(), 2);
});

test('reset() clears all entries', () => {
  const c = createCache({ maxSize: 10, ttlMs: 60000 });
  c.set('a', 1); c.set('b', 2);
  c.reset();
  assert.strictEqual(c.size(), 0);
  assert.strictEqual(c.get('a'), undefined);
});
