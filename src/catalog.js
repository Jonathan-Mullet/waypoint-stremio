const trakt = require('./providers/trakt');
const cinemeta = require('./cinemeta');
const playbackCache = require('./playback-cache');
const { createCache } = require('./cache');
const { fmtResumeTime } = require('./utils');

const _cwCache = createCache({ maxSize: 1000, ttlMs: 30 * 1000 });
const _wlCache = createCache({ maxSize: 1000, ttlMs: 5 * 60 * 1000 });

function _episodeScore(it) {
  return (Number(it.season) || 0) * 10000 + (Number(it.episode) || 0);
}

function _toMeta(it, type) {
  return {
    id: it.imdb, type,
    name: it.title || it.imdb,
    poster: cinemeta.posterUrl(it.imdb),
    background: cinemeta.backgroundUrl(it.imdb),
    ...(it.year ? { year: it.year } : {}),
  };
}

// opts allows test injection: { _getPlayback, _getRuntimeMinutes }
async function buildContinueWatching(tokens, wantMovies, opts = {}) {
  const cacheKey = `${tokens.user_key}:cw:${wantMovies ? 'm' : 's'}`;
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

  const type = wantMovies ? 'movie' : 'series';

  let candidates;
  if (wantMovies) {
    // De-duplicate movies by imdb, keep highest progress
    const byImdb = new Map();
    for (const it of items) {
      if (it.type !== 'movie' || !it.imdb) continue;
      const prev = byImdb.get(it.imdb);
      if (!prev || it.progress > prev.progress) byImdb.set(it.imdb, it);
    }
    candidates = [...byImdb.values()];
  } else {
    // De-duplicate shows to deepest episode per show
    const byShow = new Map();
    for (const it of items) {
      if (it.type !== 'episode' || !it.imdb) continue;
      const prev = byShow.get(it.imdb);
      if (!prev || _episodeScore(it) > _episodeScore(prev)) byShow.set(it.imdb, it);
    }
    candidates = [...byShow.values()];
  }

  const runtimes = await Promise.allSettled(
    candidates.map(it => _getRuntimeMinutes(type, it.imdb).catch(() => null))
  );

  const metas = candidates.map((it, i) => {
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

// opts allows test injection: { _getWatchlist }
async function buildWatchlist(tokens, wantMovies, opts = {}) {
  const kind = wantMovies ? 'movies' : 'shows';
  const cacheKey = `${tokens.user_key}:wl:${kind}`;
  const cached = _wlCache.get(cacheKey);
  if (cached) return cached;

  const _getWatchlist = opts._getWatchlist || ((t, k) => trakt.getWatchlist(t, k));
  const type = wantMovies ? 'movie' : 'series';

  let items;
  try { items = await _getWatchlist(tokens, kind); }
  catch (e) {
    if (String(e.message).includes('401')) throw Object.assign(e, { code: 'TOKEN_EXPIRED' });
    return [];
  }

  const metas = items.map(it => _toMeta(it, type));
  _wlCache.set(cacheKey, metas);
  return metas;
}

function _resetCachesForTesting() { _cwCache.reset(); _wlCache.reset(); }

module.exports = { buildContinueWatching, buildWatchlist, _episodeScore, _resetCachesForTesting };
