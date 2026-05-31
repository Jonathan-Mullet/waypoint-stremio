// test/catalog.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildContinueWatching, buildWatchlist, _episodeScore, _resetCachesForTesting } =
  require('../src/catalog.js');

const TOKENS = { client_id: 'cid', access_token: 'tok', user_key: 'user1' };
const TOKENS2 = { client_id: 'cid', access_token: 'tok2', user_key: 'user2' }; // same app, different account

function makePlayback() {
  return [
    { type: 'movie',   imdb: 'tt0816692', title: 'Interstellar', year: 2014, progress: 45 },
    { type: 'movie',   imdb: 'tt0816692', title: 'Interstellar', year: 2014, progress: 70 }, // dupe movie
    { type: 'episode', imdb: 'tt0903747', title: 'Breaking Bad', season: 2, episode: 5, episode_title: 'Breakage', progress: 60 },
    { type: 'episode', imdb: 'tt0903747', title: 'Breaking Bad', season: 1, episode: 3, episode_title: 'Early', progress: 30 },
  ];
}

// Each test calls _resetCachesForTesting() in its body so the module-level
// _cwCache / _wlCache singletons never leak state between tests.

test('buildContinueWatching movies: returns only movies, deduplicated (highest progress)', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatching(TOKENS, true, {
    _getPlayback: async () => makePlayback(),
    _getRuntimeMinutes: async () => 169,
  });
  assert.strictEqual(metas.length, 1);
  assert.strictEqual(metas[0].id, 'tt0816692');
  assert.ok(metas[0].description.includes('70%'), 'should keep highest-progress duplicate');
});

test('buildContinueWatching movies: description includes progress and resume hint', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatching(TOKENS, true, {
    _getPlayback: async () => makePlayback(),
    _getRuntimeMinutes: async () => 169,
  });
  assert.ok(metas[0].description.includes('70% watched'));
  assert.ok(metas[0].description.includes('▶ Resume'));
});

test('buildContinueWatching series: de-duplicates to deepest episode per show', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatching(TOKENS, false, {
    _getPlayback: async () => makePlayback(),
    _getRuntimeMinutes: async () => 47,
  });
  assert.strictEqual(metas.length, 1);
  assert.ok(metas[0].description.includes('S2E5'));
});

test('buildContinueWatching: omits resume hint when runtime unavailable', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatching(TOKENS, true, {
    _getPlayback: async () => makePlayback(),
    _getRuntimeMinutes: async () => null,
  });
  assert.ok(!metas[0].description.includes('▶ Resume'));
});

test('buildContinueWatching: two users with same client_id get independent results', async () => {
  _resetCachesForTesting();
  let callCount = 0;
  const getPlayback = async (tokens) => {
    callCount++;
    return tokens.user_key === 'user1'
      ? [{ type: 'movie', imdb: 'tt0816692', title: 'Interstellar', year: 2014, progress: 50 }]
      : [{ type: 'movie', imdb: 'tt1375666', title: 'Inception',    year: 2010, progress: 80 }];
  };
  const m1 = await buildContinueWatching(TOKENS,  true, { _getPlayback: getPlayback, _getRuntimeMinutes: async () => 100 });
  const m2 = await buildContinueWatching(TOKENS2, true, { _getPlayback: getPlayback, _getRuntimeMinutes: async () => 100 });
  assert.strictEqual(m1[0].id, 'tt0816692');
  assert.strictEqual(m2[0].id, 'tt1375666');
});

test('buildContinueWatching: returns empty array on Trakt failure', async () => {
  _resetCachesForTesting();
  const metas = await buildContinueWatching(TOKENS, true, {
    _getPlayback: async () => { throw new Error('network'); },
    _getRuntimeMinutes: async () => null,
  });
  assert.strictEqual(metas.length, 0);
});

test('buildWatchlist movies: returns movie metas', async () => {
  _resetCachesForTesting();
  const metas = await buildWatchlist(TOKENS, true, {
    _getWatchlist: async () => [{ type: 'movie', imdb: 'tt1160419', title: 'Dune', year: 2021 }],
  });
  assert.strictEqual(metas[0].id, 'tt1160419');
  assert.strictEqual(metas[0].type, 'movie');
});

test('_episodeScore: higher season beats higher episode in lower season', () => {
  assert.ok(_episodeScore({ season: 2, episode: 4 }) > _episodeScore({ season: 1, episode: 8 }));
});
