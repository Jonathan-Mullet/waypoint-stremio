// test/meta.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildMeta, _resetCachesForTesting } = require('../src/meta.js');

const TOKENS = { client_id: 'cid', access_token: 'tok', user_key: 'user1' };

const BASE_MOVIE = {
  id: 'tt0816692', name: 'Interstellar', type: 'movie',
  description: 'A team of explorers.', runtime: 169,
};

const BASE_SERIES = {
  id: 'tt0903747', name: 'Breaking Bad', type: 'series',
  description: 'A chemistry teacher.',
  runtime: 47,
  videos: [
    { id: 'tt0903747:1:1', season: 1, episode: 1, title: 'Pilot' },
    { id: 'tt0903747:2:5', season: 2, episode: 5, title: 'Breakage' },
  ],
};

test('buildMeta: returns null when title not in CW', async () => {
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'movie', 'tt0816692', {
    _getPlayback: async () => [],
    _getCinemetaMeta: async () => BASE_MOVIE,
  });
  assert.strictEqual(meta, null);
});

test('buildMeta: prepends resume hint for in-progress movie using baseMeta.runtime (no second fetch)', async () => {
  _resetCachesForTesting();
  let cinemetaCallCount = 0;
  const meta = await buildMeta(TOKENS, 'movie', 'tt0816692', {
    _getPlayback: async () => [{ type: 'movie', imdb: 'tt0816692', progress: 45 }],
    _getCinemetaMeta: async () => { cinemetaCallCount++; return { ...BASE_MOVIE }; },
  });
  assert.ok(meta.description.startsWith('▶ Trakt:'));
  assert.ok(meta.description.includes('45%'));
  assert.ok(meta.description.includes('A team of explorers.')); // original preserved
  assert.ok(meta.description.includes('resume ~'));             // time hint present (runtime=169 in baseMeta)
  assert.strictEqual(cinemetaCallCount, 1, 'must only call Cinemeta once, extracting runtime from result');
});

const seriesMeta = () => ({ ...BASE_SERIES, videos: BASE_SERIES.videos.map(v => ({ ...v })) });

test('buildMeta series: "Up next" from Trakt progress + marks that episode', async () => {
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: async () => ({ completed: 4, aired: 62, next_episode: { season: 2, number: 5, title: 'Breakage' } }),
    _getPlayback: async () => [],
    _getCinemetaMeta: async () => seriesMeta(),
  });
  assert.ok(meta.description.startsWith('▶ Trakt — Up next: S2E5'));
  assert.ok(meta.description.includes('Breakage'));
  const ep = meta.videos.find(v => v.season === 2 && v.episode === 5);
  assert.ok(ep.title.startsWith('▶ '), 'up-next episode marked in the list');
});

test('buildMeta series: up-next episode partway watched → Resume with %', async () => {
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: async () => ({ completed: 4, aired: 62, next_episode: { season: 2, number: 5, title: 'Breakage' } }),
    _getPlayback: async () => [{ type: 'episode', imdb: 'tt0903747', season: 2, episode: 5, progress: 60 }],
    _getCinemetaMeta: async () => seriesMeta(),
  });
  assert.ok(meta.description.startsWith('▶ Trakt — Resume S2E5'));
  assert.ok(meta.description.includes('60%'));
  assert.ok(meta.description.includes('resume ~')); // runtime 47 present
});

test('buildMeta series: not started (completed 0) → null', async () => {
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: async () => ({ completed: 0, aired: 62, next_episode: { season: 1, number: 1, title: 'Pilot' } }),
    _getCinemetaMeta: async () => seriesMeta(),
  });
  assert.strictEqual(meta, null);
});

test('buildMeta series: caught up (no next_episode) → null', async () => {
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: async () => ({ completed: 62, aired: 62, next_episode: null }),
    _getCinemetaMeta: async () => seriesMeta(),
  });
  assert.strictEqual(meta, null);
});

test('buildMeta series: transient progress failure → null, NOT cached', async () => {
  _resetCachesForTesting();
  let mode = 'down';
  const getProgress = async () => {
    if (mode === 'down') throw new Error('Trakt 500');
    return { completed: 4, aired: 62, next_episode: { season: 2, number: 5, title: 'Breakage' } };
  };
  const first = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: getProgress, _getPlayback: async () => [], _getCinemetaMeta: async () => seriesMeta(),
  });
  assert.strictEqual(first, null);
  mode = 'up';
  const second = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: getProgress, _getPlayback: async () => [], _getCinemetaMeta: async () => seriesMeta(),
  });
  assert.ok(second && second.description.includes('Up next: S2E5'),
    'after recovery the hint appears — transient failure was not cached');
});

test('buildMeta: returns null when Cinemeta unavailable', async () => {
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'movie', 'tt0816692', {
    _getPlayback: async () => [{ type: 'movie', imdb: 'tt0816692', progress: 45 }],
    _getCinemetaMeta: async () => null,
  });
  assert.strictEqual(meta, null);
});

test('buildMeta: hint without timestamp when runtime missing from baseMeta', async () => {
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'movie', 'tt0816692', {
    _getPlayback: async () => [{ type: 'movie', imdb: 'tt0816692', progress: 45 }],
    _getCinemetaMeta: async () => ({ ...BASE_MOVIE, runtime: null }),
  });
  assert.ok(meta.description.includes('45%'));
  assert.ok(!meta.description.includes('Resume ~'));
});

test('buildMeta: transient playback failure returns null but is NOT cached', async () => {
  _resetCachesForTesting();
  // First call: Trakt is down → playback fetch throws → returns null, must not cache
  let mode = 'down';
  const getPlayback = async () => {
    if (mode === 'down') throw new Error('Trakt 500');
    return [{ type: 'movie', imdb: 'tt0816692', progress: 45 }];
  };
  const first = await buildMeta(TOKENS, 'movie', 'tt0816692', {
    _getPlayback: getPlayback, _getCinemetaMeta: async () => ({ ...BASE_MOVIE }),
  });
  assert.strictEqual(first, null);
  // Trakt recovers → the next call must re-fetch (negative result was not cached)
  mode = 'up';
  const second = await buildMeta(TOKENS, 'movie', 'tt0816692', {
    _getPlayback: getPlayback, _getCinemetaMeta: async () => ({ ...BASE_MOVIE }),
  });
  assert.ok(second && second.description.includes('45%'),
    'after Trakt recovers, hint must appear — transient failure must not have been cached');
});
