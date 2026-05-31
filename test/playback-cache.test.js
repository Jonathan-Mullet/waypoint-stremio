// test/playback-cache.test.js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const playbackCache = require('../src/playback-cache.js');

beforeEach(() => playbackCache._resetCacheForTesting());

test('first call hits the provider; second call within TTL does not', async () => {
  let calls = 0;
  const provider = { getPlayback: async () => { calls++; return [{ imdb: 'tt1', progress: 10 }]; } };
  const tokens = { user_key: 'userA', client_id: 'c', access_token: 't' };

  const a = await playbackCache.getPlaybackCached(tokens, { provider });
  const b = await playbackCache.getPlaybackCached(tokens, { provider });
  assert.strictEqual(calls, 1, 'second call must be served from cache');
  assert.deepStrictEqual(a, b);
});

test('different user_key keeps results isolated', async () => {
  const provider = {
    getPlayback: async (tokens) =>
      [{ imdb: tokens.user_key === 'userA' ? 'tt-A' : 'tt-B', progress: 5 }],
  };
  const a = await playbackCache.getPlaybackCached({ user_key: 'userA' }, { provider });
  const b = await playbackCache.getPlaybackCached({ user_key: 'userB' }, { provider });
  assert.strictEqual(a[0].imdb, 'tt-A');
  assert.strictEqual(b[0].imdb, 'tt-B');
});

test('provider errors propagate (caller handles, nothing cached)', async () => {
  let calls = 0;
  const provider = { getPlayback: async () => { calls++; throw new Error('Trakt 500'); } };
  const tokens = { user_key: 'userC' };

  await assert.rejects(() => playbackCache.getPlaybackCached(tokens, { provider }), /500/);
  // A failed fetch must NOT poison the cache — the next call retries the provider
  await assert.rejects(() => playbackCache.getPlaybackCached(tokens, { provider }), /500/);
  assert.strictEqual(calls, 2, 'errors must not be cached; each call retries');
});

test('_resetCacheForTesting clears the cache', async () => {
  let calls = 0;
  const provider = { getPlayback: async () => { calls++; return []; } };
  const tokens = { user_key: 'userD' };
  await playbackCache.getPlaybackCached(tokens, { provider });
  playbackCache._resetCacheForTesting();
  await playbackCache.getPlaybackCached(tokens, { provider });
  assert.strictEqual(calls, 2, 'after reset, provider is called again');
});
