const trakt = require('./providers/trakt');
const cinemeta = require('./cinemeta');
const playbackCache = require('./playback-cache');
const { createCache } = require('./cache');
const { fmtResumeTime } = require('./utils');

const _cwCache = createCache({ maxSize: 1000, ttlMs: 30 * 1000 });
const _wlCache = createCache({ maxSize: 1000, ttlMs: 5 * 60 * 1000 });

function _pausedMs(it) { return it.paused_at ? (Date.parse(it.paused_at) || 0) : 0; }

function _toMeta(it, type) {
  return {
    id: it.imdb, type,
    name: it.title || it.imdb,
    poster: cinemeta.posterUrl(it.imdb),
    background: cinemeta.backgroundUrl(it.imdb),
    ...(it.year ? { year: it.year } : {}),
  };
}

// Continue Watching as ONE recency-interleaved row: movies and shows mixed,
// most-recently-paused first (mirrors Stremio's own Continue Watching ordering).
// opts allows test injection: { _getPlayback, _getRuntimeMinutes }
async function buildContinueWatchingMixed(tokens, opts = {}) {
  const cacheKey = `${tokens.user_key}:cw:mixed`;
  const cached = _cwCache.get(cacheKey);
  if (cached) return cached;

  const _getPlayback = opts._getPlayback || (t => playbackCache.getPlaybackCached(t));
  const _getRuntimeMinutes = opts._getRuntimeMinutes || cinemeta.getRuntimeMinutes;

  let items;
  try { items = await _getPlayback(tokens); }
  catch (e) {
    if (String(e.message).includes('401')) throw Object.assign(e, { code: 'TOKEN_EXPIRED' });
    return [];
  }

  // One entry per title, keeping the most-recently-paused occurrence (movies keyed by
  // imdb, shows by show imdb so the row shows the episode you last touched).
  const byKey = new Map();
  for (const it of items) {
    if (!it.imdb || (it.type !== 'movie' && it.type !== 'episode')) continue;
    const key = `${it.type === 'movie' ? 'm' : 's'}:${it.imdb}`;
    const prev = byKey.get(key);
    if (!prev || _pausedMs(it) > _pausedMs(prev)) byKey.set(key, it);
  }
  // Newest-first across both types — this is the interleaving the user wants.
  const candidates = [...byKey.values()].sort((a, b) => _pausedMs(b) - _pausedMs(a));

  const runtimes = await Promise.allSettled(
    candidates.map(it => _getRuntimeMinutes(it.type === 'movie' ? 'movie' : 'series', it.imdb).catch(() => null))
  );

  const metas = candidates.map((it, i) => {
    const type = it.type === 'movie' ? 'movie' : 'series';
    const minutes = runtimes[i].status === 'fulfilled' ? runtimes[i].value : null;
    const resumeSecs = minutes ? (it.progress / 100) * minutes * 60 : null;
    const resumeHint = resumeSecs != null ? `▶ Resume ~${fmtResumeTime(resumeSecs)}` : null;

    const parts = it.type === 'episode'
      ? [`S${it.season}E${it.episode}${it.episode_title ? ' — ' + it.episode_title : ''}`,
         `${Math.round(it.progress)}% watched`]
      : [`${Math.round(it.progress)}% watched`];
    if (resumeHint) parts.push(resumeHint);

    return { ..._toMeta(it, type), description: parts.join(' · ') };
  });

  _cwCache.set(cacheKey, metas);
  return metas;
}

// Watchlist as ONE row: movie + show watchlist items combined. Trakt's watchlist
// carries no progress/recency here, so movies precede shows.
// opts allows test injection: { _getWatchlist }
async function buildWatchlistMixed(tokens, opts = {}) {
  const cacheKey = `${tokens.user_key}:wl:mixed`;
  const cached = _wlCache.get(cacheKey);
  if (cached) return cached;

  const _getWatchlist = opts._getWatchlist || ((t, k) => trakt.getWatchlist(t, k));

  let movies, shows;
  try {
    [movies, shows] = await Promise.all([
      _getWatchlist(tokens, 'movies'),
      _getWatchlist(tokens, 'shows'),
    ]);
  } catch (e) {
    if (String(e.message).includes('401')) throw Object.assign(e, { code: 'TOKEN_EXPIRED' });
    return [];
  }

  const metas = [
    ...movies.map(it => _toMeta(it, 'movie')),
    ...shows.map(it => _toMeta(it, 'series')),
  ];
  _wlCache.set(cacheKey, metas);
  return metas;
}

function _resetCachesForTesting() { _cwCache.reset(); _wlCache.reset(); }

module.exports = { buildContinueWatchingMixed, buildWatchlistMixed, _resetCachesForTesting };
