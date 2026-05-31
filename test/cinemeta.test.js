// test/cinemeta.test.js
const { test } = require('node:test');
const assert = require('node:assert');

function mockFetch(status, body) {
  return async () => ({ ok: status < 400, status, json: async () => body });
}

const cinemeta = require('../src/cinemeta.js');

// Reset caches before each test to prevent cross-test pollution
// (module-level caches are singletons — same IMDb ID in two tests would cache-hit)
test.beforeEach(() => cinemeta._resetCachesForTesting());

test('posterUrl returns metahub URL', () => {
  assert.strictEqual(
    cinemeta.posterUrl('tt0816692'),
    'https://images.metahub.space/poster/medium/tt0816692/img'
  );
});

test('getRuntimeMinutes: parses integer runtime', async () => {
  const mins = await cinemeta.getRuntimeMinutes('movie', 'tt0816692',
    { _fetch: mockFetch(200, { meta: { runtime: 169 } }) });
  assert.strictEqual(mins, 169);
});

test('getRuntimeMinutes: parses string runtime', async () => {
  const mins = await cinemeta.getRuntimeMinutes('series', 'tt0903747',
    { _fetch: mockFetch(200, { meta: { runtime: '47' } }) });
  assert.strictEqual(mins, 47);
});

test('getRuntimeMinutes: returns null on 5xx — NOT cached', async () => {
  const mins = await cinemeta.getRuntimeMinutes('movie', 'tt0000001',
    { _fetch: mockFetch(500, {}) });
  assert.strictEqual(mins, null);
  // Verify it's not cached: a second call with a successful mock should hit Cinemeta
  let called = false;
  await cinemeta.getRuntimeMinutes('movie', 'tt0000001', {
    _fetch: async () => { called = true; return { ok: true, status: 200, json: async () => ({ meta: { runtime: 90 } }) }; }
  });
  assert.ok(called, '5xx result should NOT be cached; second call should hit Cinemeta');
});

test('getRuntimeMinutes: returns null on 404 — IS cached', async () => {
  await cinemeta.getRuntimeMinutes('movie', 'tt9999999', { _fetch: mockFetch(404, {}) });
  let called = false;
  await cinemeta.getRuntimeMinutes('movie', 'tt9999999', {
    _fetch: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; }
  });
  assert.ok(!called, '404 null should be cached; second call should NOT hit Cinemeta');
});

test('getMeta: returns meta object', async () => {
  const meta = await cinemeta.getMeta('movie', 'tt0816692',
    { _fetch: mockFetch(200, { meta: { id: 'tt0816692', name: 'Interstellar', runtime: 169 } }) });
  assert.strictEqual(meta.name, 'Interstellar');
  assert.strictEqual(meta.runtime, 169);
});

test('getMeta: returns null on 404 — IS cached', async () => {
  const meta = await cinemeta.getMeta('movie', 'tt0000001', { _fetch: mockFetch(404, {}) });
  assert.strictEqual(meta, null);
});

test('getMeta: returns null on 5xx — NOT cached', async () => {
  const meta = await cinemeta.getMeta('movie', 'tt0000002', { _fetch: mockFetch(503, {}) });
  assert.strictEqual(meta, null);
  // A 5xx must not poison the cache: the next call should hit Cinemeta and succeed
  let called = false;
  const meta2 = await cinemeta.getMeta('movie', 'tt0000002', {
    _fetch: async () => { called = true; return { ok: true, status: 200, json: async () => ({ meta: { name: 'Recovered' } }) }; }
  });
  assert.ok(called, '5xx result must NOT be cached');
  assert.strictEqual(meta2.name, 'Recovered');
});
