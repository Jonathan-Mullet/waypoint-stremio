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
  // Cinemeta sends episode titles in `name` (NOT `title`).
  videos: [
    { id: 'tt0903747:1:1', season: 1, episode: 1, name: 'Pilot' },
    { id: 'tt0903747:2:5', season: 2, episode: 5, name: 'Breakage' },
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
  assert.ok(ep.name.startsWith('▶ '), 'up-next episode marked via name field');
  // Regression guard: must NOT add a `title` field — Stremio aliases title→name,
  // and having both triggers a serde duplicate-field error that fails the meta.
  assert.strictEqual(ep.title, undefined, 'must not add a title field (collides with name)');
});

test('buildMeta series: each in-progress episode carries its own resume hint in the videos list', async () => {
  _resetCachesForTesting();
  const base = () => ({
    ...BASE_SERIES, runtime: 50,
    videos: [
      { id: 'a', season: 1, episode: 1, name: 'Pilot' },
      { id: 'b', season: 2, episode: 5, name: 'Breakage' },
    ],
  });
  const meta = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: async () => ({ completed: 4, aired: 62, next_episode: { season: 2, number: 5, title: 'Breakage' } }),
    _getPlayback: async () => [
      { type: 'episode', imdb: 'tt0903747', season: 2, episode: 5, progress: 60, paused_at: '2026-05-30T00:00:00Z' },
      { type: 'episode', imdb: 'tt0903747', season: 1, episode: 1, progress: 25, paused_at: '2026-05-10T00:00:00Z' },
    ],
    _getCinemetaMeta: async () => base(),
  });
  const e25 = meta.videos.find(v => v.season === 2 && v.episode === 5);
  const e11 = meta.videos.find(v => v.season === 1 && v.episode === 1);
  // The episode you're resuming shows its own % + time right in the list.
  assert.ok(e25.name.startsWith('▶ ') && e25.name.includes('60%'), e25.name);
  assert.ok(e25.name.includes('resume ~'), e25.name);
  // A second in-progress episode is annotated too — not just the chosen one.
  assert.ok(e11.name.startsWith('▶ ') && e11.name.includes('25%'), e11.name);
  // Regression guard: still never add a colliding `title` field.
  assert.strictEqual(e25.title, undefined);
  assert.strictEqual(e11.title, undefined);
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

test('buildMeta series: not started, nothing in progress (completed 0, no playback) → null', async () => {
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: async () => ({ completed: 0, aired: 62, next_episode: { season: 1, number: 1, title: 'Pilot' } }),
    _getPlayback: async () => [],
    _getCinemetaMeta: async () => seriesMeta(),
  });
  assert.strictEqual(meta, null);
});

test('buildMeta series: fully watched / caught up → "Caught up" hint (Off Campus case)', async () => {
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: async () => ({ completed: 8, aired: 8, next_episode: null }),
    _getPlayback: async () => [],
    _getCinemetaMeta: async () => seriesMeta(),
  });
  assert.ok(meta, 'finished shows must still get a hint, not null');
  assert.ok(meta.description.startsWith('✓ Trakt — Caught up'), meta.description);
  assert.ok(meta.description.includes('8'));
});

test('buildMeta series: caught up wins over a stale lingering partial', async () => {
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: async () => ({ completed: 62, aired: 62, next_episode: null }),
    // Trakt sometimes leaves an old paused entry behind; caught-up still shows the marker.
    _getPlayback: async () => [{ type: 'episode', imdb: 'tt0903747', season: 2, episode: 5, progress: 50, paused_at: '2026-01-01T00:00:00Z' }],
    _getCinemetaMeta: async () => seriesMeta(),
  });
  assert.ok(meta.description.startsWith('✓ Trakt — Caught up'), meta.description);
  assert.ok(meta.description.includes('62'));
});

test('buildMeta series: in-progress episode with completed=0 (Stremio partial scrobble) → Resume hint', async () => {
  // The real bug: a user mid-episode who never cleanly *finished* one has completed=0
  // in progress/watched but a live resume point in /sync/playback. The hint must come
  // from the playback resume point, not bail on completed===0.
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: async () => ({ completed: 0, aired: 62, next_episode: { season: 1, number: 1, title: 'Pilot' } }),
    _getPlayback: async () => [
      { type: 'episode', imdb: 'tt0903747', season: 2, episode: 5, progress: 79, episode_title: 'Breakage', paused_at: '2026-05-31T03:00:00Z' },
    ],
    _getCinemetaMeta: async () => seriesMeta(),
  });
  assert.ok(meta, 'must produce a hint from partial playback even with completed=0');
  assert.ok(meta.description.startsWith('▶ Trakt — Resume S2E5'), meta.description);
  assert.ok(meta.description.includes('79%'));
  const ep = meta.videos.find(v => v.season === 2 && v.episode === 5);
  assert.ok(ep.name.startsWith('▶ '), 'resume episode marked via name field');
  assert.strictEqual(ep.title, undefined, 'must not add a title field (collides with name)');
});

test('buildMeta series: most-recent partial wins when several episodes are in progress', async () => {
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: async () => ({ completed: 0, aired: 62, next_episode: { season: 1, number: 1, title: 'Pilot' } }),
    _getPlayback: async () => [
      { type: 'episode', imdb: 'tt0903747', season: 1, episode: 3, progress: 16, paused_at: '2026-05-23T00:00:00Z' },
      { type: 'episode', imdb: 'tt0903747', season: 2, episode: 5, progress: 40, episode_title: 'Breakage', paused_at: '2026-05-30T00:00:00Z' },
    ],
    _getCinemetaMeta: async () => seriesMeta(),
  });
  assert.ok(meta.description.startsWith('▶ Trakt — Resume S2E5'), meta.description);
});

test('buildMeta series: stale partial behind watched frontier → Up next wins', async () => {
  // User has cleanly watched past an old paused episode; the up-next target is ahead
  // of the lingering resume point, so up-next should win (matches the SAO case).
  _resetCachesForTesting();
  const meta = await buildMeta(TOKENS, 'series', 'tt0903747', {
    _getProgress: async () => ({ completed: 3, aired: 25, next_episode: { season: 1, number: 25, title: 'The World Seed' } }),
    _getPlayback: async () => [
      { type: 'episode', imdb: 'tt0903747', season: 1, episode: 23, progress: 12, paused_at: '2026-05-30T00:00:00Z' },
    ],
    _getCinemetaMeta: async () => seriesMeta(),
  });
  assert.ok(meta.description.startsWith('▶ Trakt — Up next: S1E25'), meta.description);
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
