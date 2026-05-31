/**
 * HistoryProvider interface implemented by this module.
 * Future providers (Simkl, Plex) must export the same signatures:
 *   getPlayback(tokens, opts?) → Promise<PlaybackItem[]>
 *   getWatchlist(tokens, kind, opts?) → Promise<WatchlistItem[]>
 */
const TRAKT_API = 'https://api.trakt.tv';
const UA = 'Mozilla/5.0 (compatible; waypoint-stremio/1.0; +https://waypoint.baby-beamup.club)';

function _headers(clientId, accessToken) {
  const h = {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'trakt-api-version': '2',
    'trakt-api-key': clientId,
  };
  if (accessToken) h['Authorization'] = `Bearer ${accessToken}`;
  return h;
}

async function startDeviceCode(clientId, { _fetch = fetch } = {}) {
  const r = await _fetch(`${TRAKT_API}/oauth/device/code`, {
    method: 'POST', headers: _headers(clientId),
    body: JSON.stringify({ client_id: clientId }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Trakt device/code HTTP ${r.status}`);
  return r.json();
}

async function pollDeviceToken(clientId, clientSecret, deviceCode, { _fetch = fetch } = {}) {
  const r = await _fetch(`${TRAKT_API}/oauth/device/token`, {
    method: 'POST', headers: _headers(clientId),
    body: JSON.stringify({ code: deviceCode, client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(10000),
  });
  if ([400, 409, 429].includes(r.status)) return { status: 'pending' };
  if ([404, 410].includes(r.status)) return { status: 'expired' };
  if (r.status === 418) return { status: 'denied' };
  if (!r.ok) throw new Error(`Trakt device/token HTTP ${r.status}`);
  const d = await r.json();
  return {
    status: 'authorized',
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: Date.now() + d.expires_in * 1000,
  };
}

async function refreshToken({ client_id, client_secret, refresh_token }, { _fetch = fetch } = {}) {
  const r = await _fetch(`${TRAKT_API}/oauth/token`, {
    method: 'POST', headers: _headers(client_id),
    body: JSON.stringify({ refresh_token, client_id, client_secret,
      grant_type: 'refresh_token', redirect_uri: 'urn:ietf:wg:oauth:2.0:oob' }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Trakt token refresh HTTP ${r.status}`);
  const d = await r.json();
  return { access_token: d.access_token, refresh_token: d.refresh_token,
    expires_at: Date.now() + d.expires_in * 1000 };
}

async function getPlayback(tokens, { _fetch = fetch } = {}) {
  const r = await _fetch(`${TRAKT_API}/sync/playback/movies,episodes?extended=full&limit=100`, {
    headers: _headers(tokens.client_id, tokens.access_token),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Trakt playback HTTP ${r.status}`);
  return (await r.json()).map(it => {
    const base = { progress: typeof it.progress === 'number' ? it.progress : 0, paused_at: it.paused_at };
    if (it.type === 'movie' && it.movie?.ids?.imdb)
      return { ...base, type: 'movie', imdb: it.movie.ids.imdb, title: it.movie.title, year: it.movie.year };
    if (it.type === 'episode' && it.show?.ids?.imdb)
      return { ...base, type: 'episode', imdb: it.show.ids.imdb, title: it.show.title,
        season: it.episode.season, episode: it.episode.number, episode_title: it.episode.title };
    return null;
  }).filter(Boolean);
}

async function getWatchlist(tokens, kind, { _fetch = fetch } = {}) {
  if (kind !== 'movies' && kind !== 'shows') throw new Error(`invalid kind: ${kind}`);
  const r = await _fetch(`${TRAKT_API}/users/me/watchlist/${kind}?extended=full&limit=100`, {
    headers: _headers(tokens.client_id, tokens.access_token),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Trakt watchlist HTTP ${r.status}`);
  return (await r.json()).map(it => {
    if (kind === 'movies' && it.movie?.ids?.imdb)
      return { type: 'movie', imdb: it.movie.ids.imdb, title: it.movie.title, year: it.movie.year };
    if (kind === 'shows' && it.show?.ids?.imdb)
      return { type: 'series', imdb: it.show.ids.imdb, title: it.show.title, year: it.show.year };
    return null;
  }).filter(Boolean);
}

// Watched progress for a single show (by IMDb id). Returns the "up next" episode
// the user should watch — this is what tells them which episode/season to jump to,
// covering both "resume the partial one" and "start the next after finishing".
// Returns { completed, aired, last_watched_at, next_episode|null }.
async function getShowProgress(tokens, imdb, { _fetch = fetch } = {}) {
  const r = await _fetch(
    `${TRAKT_API}/shows/${imdb}/progress/watched?hidden=false&specials=false&count_specials=false`,
    { headers: _headers(tokens.client_id, tokens.access_token), signal: AbortSignal.timeout(10000) }
  );
  if (!r.ok) throw new Error(`Trakt progress HTTP ${r.status}`);
  const d = await r.json();
  const ne = d.next_episode;
  return {
    completed: d.completed || 0,
    aired: d.aired || 0,
    last_watched_at: d.last_watched_at || null,
    next_episode: (ne && ne.season != null && ne.number != null)
      ? { season: ne.season, number: ne.number, title: ne.title || '' }
      : null,
  };
}

module.exports = { startDeviceCode, pollDeviceToken, refreshToken, getPlayback, getWatchlist, getShowProgress };
