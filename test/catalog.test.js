// test/catalog.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildContinueWatchingMixed, MAX_ITEMS, _resetCachesForTesting } =
  require('../src/catalog.js');

const TOKENS = { client_id: 'cid', access_token: 'tok', user_key: 'user1' };
const TOKENS2 = { client_id: 'cid', access_token: 'tok2', user_key: 'user2' }; // same app, different account

// In-progress (resume) items, with duplicates to exercise newest-wins dedup.
function makePlayback() {
  return [
    { type: 'movie',   imdb: 'tt0816692', title: 'Interstellar', year: 2014, progress: 45, paused_at: '2026-05-20T00:00:00Z' },
    { type: 'movie',   imdb: 'tt0816692', title: 'Interstellar', year: 2014, progress: 70, paused_at: '2026-05-28T00:00:00Z' }, // newer dupe
    { type: 'episode', imdb: 'tt0903747', title: 'Breaking Bad', season: 2, episode: 5, episode_title: 'Breakage', progress: 60, paused_at: '2026-05-30T00:00:00Z' },
    { type: 'episode', imdb: 'tt0903747', title: 'Breaking Bad', season: 1, episode: 3, episode_title: 'Early',    progress: 30, paused_at: '2026-05-10T00:00:00Z' }, // older dupe
    { type: 'movie',   imdb: 'tt1375666', title: 'Inception',    year: 2010, progress: 20, paused_at: '2026-05-25T00:00:00Z' },
  ];
}
const noHistory = async () => [];

// Each test calls _resetCachesForTesting() in its body so the module-level
// _cwCache singleton never leaks state between tests.

test('continue watching: movies and series in ONE row, interleaved newest-first', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: async () => makePlayback(),
    _getHistory: noHistory,
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
    _getHistory: noHistory,
    _getRuntimeMinutes: async () => 100,
  });
  const interstellar = metas.find(m => m.id === 'tt0816692');
  assert.ok(interstellar.description.includes('70%'), 'keeps the newer 70% entry, not the older 45%');
  const bb = metas.find(m => m.id === 'tt0903747');
  assert.ok(bb.description.includes('S2E5'), 'keeps the newer S2E5 entry, not the older S1E3');
});

test('continue watching: in-progress cards have progress and a resume hint', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: async () => makePlayback(),
    _getHistory: noHistory,
    _getRuntimeMinutes: async () => 100,
  });
  assert.ok(metas[0].description.includes('% watched'));
  assert.ok(metas[0].description.includes('▶ Resume'));
});

test('continue watching: omits resume hint when runtime unavailable', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: async () => makePlayback(),
    _getHistory: noHistory,
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
  const m1 = await buildContinueWatchingMixed(TOKENS,  { _getPlayback: getPlayback, _getHistory: noHistory, _getRuntimeMinutes: async () => 100 });
  const m2 = await buildContinueWatchingMixed(TOKENS2, { _getPlayback: getPlayback, _getHistory: noHistory, _getRuntimeMinutes: async () => 100 });
  assert.strictEqual(m1[0].id, 'tt0816692');
  assert.strictEqual(m2[0].id, 'tt1375666');
});

test('continue watching: returns empty array on Trakt playback failure', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: async () => { throw new Error('network'); },
    _getHistory: noHistory,
    _getRuntimeMinutes: async () => null,
  });
  assert.strictEqual(metas.length, 0);
});

// ── History backlog ──────────────────────────────────────────────────────────

test('backlog: recently-watched history backfills the row, interleaved by time', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: async () => [
      { type: 'movie', imdb: 'ttA', title: 'A', progress: 45, paused_at: '2026-05-28T00:00:00Z' },
    ],
    _getHistory: async () => [
      { type: 'episode', imdb: 'ttB', title: 'B', season: 1, episode: 2, episode_title: 'b2', watched_at: '2026-05-30T00:00:00Z' },
      { type: 'movie',   imdb: 'ttC', title: 'C', watched_at: '2026-05-20T00:00:00Z' },
    ],
    _getRuntimeMinutes: async () => 100,
  });
  // Ordered purely by recency across resume + history: B(05-30) → A(05-28) → C(05-20).
  assert.deepStrictEqual(metas.map(m => m.id), ['ttB', 'ttA', 'ttC']);
  assert.ok(metas[0].description.includes('✓ Watched'), 'history item shows a watched marker');
  assert.ok(metas[0].description.includes('S1E2'));
  assert.ok(metas[1].description.includes('45%'), 'in-progress item still shows resume %');
});

test('backlog: an in-progress resume entry is never overwritten by history', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: async () => [
      { type: 'episode', imdb: 'ttX', title: 'X', season: 3, episode: 7, progress: 24, paused_at: '2026-05-25T00:00:00Z' },
    ],
    // Newer history entry for the same show must NOT replace the resume point.
    _getHistory: async () => [
      { type: 'episode', imdb: 'ttX', title: 'X', season: 3, episode: 6, episode_title: 'e6', watched_at: '2026-05-28T00:00:00Z' },
    ],
    _getRuntimeMinutes: async () => 100,
  });
  assert.strictEqual(metas.length, 1);
  assert.ok(metas[0].description.includes('S3E7'), 'keeps resume episode, not the newer watched one');
  assert.ok(metas[0].description.includes('24%'));
});

test('backlog: total list is capped at MAX_ITEMS', async () => {
  _resetCachesForTesting();
  const big = Array.from({ length: MAX_ITEMS + 50 }, (_, i) => ({
    type: 'movie', imdb: 'tt' + (100000 + i), title: 'M' + i, watched_at: `2026-04-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: noHistory,
    _getHistory: async () => big,
    _getRuntimeMinutes: async () => 100,
  });
  assert.strictEqual(metas.length, MAX_ITEMS);
});

test('backlog: history failure does not break the resume row', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatchingMixed(TOKENS, {
    _getPlayback: async () => [{ type: 'movie', imdb: 'ttA', title: 'A', progress: 45, paused_at: '2026-05-28T00:00:00Z' }],
    _getHistory: async () => { throw new Error('Trakt history 500'); },
    _getRuntimeMinutes: async () => 100,
  });
  assert.strictEqual(metas.length, 1);
  assert.strictEqual(metas[0].id, 'ttA');
});
