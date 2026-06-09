// test/trakt.test.js
const { test, mock } = require('node:test');
const assert = require('node:assert');

function mockFetch(status, body) {
  return mock.fn(async () => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

const { startDeviceCode, pollDeviceToken, refreshToken, getPlayback, getWatchlist, getShowProgress } =
  require('../src/providers/trakt.js');

test('startDeviceCode returns device flow data', async () => {
  const _fetch = mockFetch(200, {
    device_code: 'dc123', user_code: 'ABCD-1234',
    verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5,
  });
  const r = await startDeviceCode('cid', { _fetch });
  assert.strictEqual(r.user_code, 'ABCD-1234');
});

test('pollDeviceToken: 400 → pending', async () => {
  const r = await pollDeviceToken('id', 'sec', 'dc', { _fetch: mockFetch(400, {}) });
  assert.strictEqual(r.status, 'pending');
});

test('pollDeviceToken: 429 → pending', async () => {
  const r = await pollDeviceToken('id', 'sec', 'dc', { _fetch: mockFetch(429, {}) });
  assert.strictEqual(r.status, 'pending');
});

test('pollDeviceToken: 200 → authorized with tokens', async () => {
  const now = Date.now();
  const r = await pollDeviceToken('id', 'sec', 'dc', {
    _fetch: mockFetch(200, { access_token: 'acc', refresh_token: 'ref', expires_in: 7776000 }),
  });
  assert.strictEqual(r.status, 'authorized');
  assert.strictEqual(r.access_token, 'acc');
  assert.ok(r.expires_at > now);
});

test('pollDeviceToken: 418 → denied', async () => {
  const r = await pollDeviceToken('id', 'sec', 'dc', { _fetch: mockFetch(418, {}) });
  assert.strictEqual(r.status, 'denied');
});

test('pollDeviceToken: 410 → expired', async () => {
  const r = await pollDeviceToken('id', 'sec', 'dc', { _fetch: mockFetch(410, {}) });
  assert.strictEqual(r.status, 'expired');
});

test('refreshToken returns new token pair', async () => {
  const r = await refreshToken(
    { client_id: 'id', client_secret: 'sec', refresh_token: 'old' },
    { _fetch: mockFetch(200, { access_token: 'new_acc', refresh_token: 'new_ref', expires_in: 7776000 }) }
  );
  assert.strictEqual(r.access_token, 'new_acc');
  assert.ok(r.expires_at > Date.now());
});

test('refreshToken throws on HTTP error', async () => {
  await assert.rejects(
    () => refreshToken({ client_id: 'id', client_secret: 'sec', refresh_token: 'x' },
      { _fetch: mockFetch(401, {}) }),
    /401/
  );
});

test('getPlayback normalises movies and episodes, filters missing imdb', async () => {
  const _fetch = mockFetch(200, [
    { type: 'movie', progress: 45,
      movie: { title: 'Inception', year: 2010, ids: { imdb: 'tt1375666' } } },
    { type: 'episode', progress: 60,
      show: { title: 'Breaking Bad', ids: { imdb: 'tt0903747' } },
      episode: { season: 2, number: 5, title: 'Breakage' } },
    { type: 'movie', progress: 10,
      movie: { title: 'Unknown', ids: {} } },  // no imdb → filtered
  ]);
  const items = await getPlayback({ client_id: 'id', access_token: 'tok' }, { _fetch });
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].imdb, 'tt1375666');
  assert.strictEqual(items[1].season, 2);
  assert.strictEqual(items[1].episode_title, 'Breakage');
});

test('getWatchlist normalises movies and shows', async () => {
  const mFetch = mockFetch(200, [{ movie: { title: 'Dune', year: 2021, ids: { imdb: 'tt1160419' } } }]);
  const sFetch = mockFetch(200, [{ show: { title: 'Severance', year: 2022, ids: { imdb: 'tt11280740' } } }]);
  const movies = await getWatchlist({ client_id: 'id', access_token: 'tok' }, 'movies', { _fetch: mFetch });
  const shows  = await getWatchlist({ client_id: 'id', access_token: 'tok' }, 'shows',  { _fetch: sFetch });
  assert.strictEqual(movies[0].type, 'movie');
  assert.strictEqual(shows[0].type, 'series');
});

test('getWatchlist throws on invalid kind', async () => {
  await assert.rejects(
    () => getWatchlist({ client_id: 'id', access_token: 'tok' }, 'invalid'),
    /kind/i
  );
});

test('getShowProgress returns next_episode + per-episode watched set', async () => {
  const _fetch = mockFetch(200, {
    aired: 96, completed: 24, last_watched_at: '2026-05-30T06:23:00.000Z',
    next_episode: { season: 1, number: 25, title: 'The World Seed' },
    seasons: [
      { number: 1, episodes: [
        { number: 1, completed: true },
        { number: 2, completed: true },
        { number: 3, completed: false },
      ] },
    ],
  });
  const r = await getShowProgress({ client_id: 'id', access_token: 'tok' }, 'tt2250192', { _fetch });
  assert.strictEqual(r.completed, 24);
  assert.deepStrictEqual(r.next_episode, { season: 1, number: 25, title: 'The World Seed' });
  assert.deepStrictEqual(r.watched, ['1:1', '1:2'], 'only completed episodes, as "season:number"');
});

test('getShowProgress: null next_episode + empty watched when no seasons present', async () => {
  const _fetch = mockFetch(200, { aired: 96, completed: 96, next_episode: null });
  const r = await getShowProgress({ client_id: 'id', access_token: 'tok' }, 'tt2250192', { _fetch });
  assert.strictEqual(r.next_episode, null);
  assert.strictEqual(r.completed, 96);
  assert.deepStrictEqual(r.watched, []);
});
