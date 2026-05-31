// test/catalog.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildContinueWatchingMixed, buildWatchlistMixed, _resetCachesForTesting } =
  require('../src/catalog.js');

const TOKENS = { client_id: 'cid', access_token: 'tok', user_key: 'user1' };
const TOKENS2 = { client_id: 'cid', access_token: 'tok2', user_key: 'user2' }; // same app, different account

// Movies and shows interleaved across time; the most-recently-paused entry per
// title should win dedup, and the whole row should be ordered newest-first.
function makePlayback() {
  return [
    { type: 'movie',   imdb: 'tt0816692', title: 'Interstellar', year: 2014, progress: 45, paused_at: '2026-05-20T00:00:00Z' },
    { type: 'movie',   imdb: 'tt0816692', title: 'Interstellar', year: 2014, progress: 70, paused_at: '2026-05-28T00:00:00Z' }, // newer dupe
    { type: 'episode', imdb: 'tt0903747', title: 'Breaking Bad', season: 2, episode: 5, episode_title: 'Breakage', progress: 60, paused_at: '2026-05-30T00:00:00Z' },
    { type: 'episode', imdb: 'tt0903747', title: 'Breaking Bad', season: 1, episode: 3, episode_title: 'Early',    progress: 30, paused_at: '2026-05-10T00:00:00Z' }, // older dupe
    { type: 'movie',   imdb: 'tt1375666', title: 'Inception',    year: 2010, progress: 20, paused_at: '2026-05-25T00:00:00Z' },
  ];
}

// Each test calls _resetCachesForTesting() in its body so the module-level
// _cwCache / _wlCache singletons never leak state between tests.

test('continue watching: movies and series in ONE row, interleaved newest-first', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: async () => makePlayback(),
    _getRuntimeMinutes: async () => 100,
  });
  // 3 distinct titles after dedup (Interstellar, Breaking Bad, Inception).
  assert.strictEqual(metas.length, 3);
  // Newest-first: BB S2E5 (05-30) → Interstellar (05-28) → Inception (05-25).
  assert.deepStrictEqual(metas.map(m => m.id), ['tt0903747', 'tt0816692', 'tt1375666']);
  // The series sits ABOVE the movies — proves true interleaving, not concatenation.
  assert.strictEqual(metas[0].type, 'series');
  assert.strictEqual(metas[1].type, 'movie');
});

test('continue watching: dedup keeps the most-recently-paused occurrence', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: async () => makePlayback(),
    _getRuntimeMinutes: async () => 100,
  });
  const interstellar = metas.find(m => m.id === 'tt0816692');
  assert.ok(interstellar.description.includes('70%'), 'keeps the newer 70% entry, not the older 45%');
  const bb = metas.find(m => m.id === 'tt0903747');
  assert.ok(bb.description.includes('S2E5'), 'keeps the newer S2E5 entry, not the older S1E3');
});

test('continue watching: each card has progress and a resume hint', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: async () => makePlayback(),
    _getRuntimeMinutes: async () => 100,
  });
  assert.ok(metas[0].description.includes('% watched'));
  assert.ok(metas[0].description.includes('▶ Resume'));
});

test('continue watching: omits resume hint when runtime unavailable', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: async () => makePlayback(),
    _getRuntimeMinutes: async () => null,
  });
  assert.ok(!metas[0].description.includes('▶ Resume'));
});

test('continue watching: two users with same client_id get independent results', async () => {
  _resetCachesForTesting();
  const getPlayback = async (tokens) =>
    tokens.user_key === 'user1'
      ? [{ type: 'movie', imdb: 'tt0816692', title: 'Interstellar', year: 2014, progress: 50, paused_at: '2026-05-01T00:00:00Z' }]
      : [{ type: 'movie', imdb: 'tt1375666', title: 'Inception',    year: 2010, progress: 80, paused_at: '2026-05-01T00:00:00Z' }];
  const m1 = await buildContinueWatchingMixed(TOKENS,  { _getPlayback: getPlayback, _getRuntimeMinutes: async () => 100 });
  const m2 = await buildContinueWatchingMixed(TOKENS2, { _getPlayback: getPlayback, _getRuntimeMinutes: async () => 100 });
  assert.strictEqual(m1[0].id, 'tt0816692');
  assert.strictEqual(m2[0].id, 'tt1375666');
});

test('continue watching: returns empty array on Trakt failure', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: async () => { throw new Error('network'); },
    _getRuntimeMinutes: async () => null,
  });
  assert.strictEqual(metas.length, 0);
});

test('watchlist: movie and show watchlist items combined into one row', async () => {
  _resetCachesForTesting();
  const metas = await buildWatchlistMixed(TOKENS, {
    _getWatchlist: async (_t, kind) => kind === 'movies'
      ? [{ type: 'movie', imdb: 'tt1160419', title: 'Dune', year: 2021 }]
      : [{ type: 'series', imdb: 'tt0903747', title: 'Breaking Bad', year: 2008 }],
  });
  const ids = metas.map(m => m.id).sort();
  assert.deepStrictEqual(ids, ['tt0903747', 'tt1160419']);
  assert.strictEqual(metas.find(m => m.id === 'tt1160419').type, 'movie');
  assert.strictEqual(metas.find(m => m.id === 'tt0903747').type, 'series');
});
