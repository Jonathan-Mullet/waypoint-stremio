const trakt = require('./providers/trakt');
const cinemeta = require('./cinemeta');
const playbackCache = require('./playback-cache');
const { createCache } = require('./cache');
const { fmtResumeTime } = require('./utils');

const _cwCache = createCache({ maxSize: 1000, ttlMs: 30 * 1000 });

// How many titles the row holds. The home preview shows the first few; "See All"
// pages through the rest, so this doubles as the backlog depth.
const MAX_ITEMS = 100;

function _ts(it) {
  const v = it.paused_at || it.watched_at;
  return v ? (Date.parse(v) || 0) : 0;
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

// Continue Watching as ONE recency-interleaved row: in-progress resume points
// (from /sync/playback) plus a backlog of recently-watched history (/sync/history),
// movies and shows mixed, newest activity first. Resume entries always win dedup so
// a finished re-watch in history never hides where you actually left off.
// opts allows test injection: { _getPlayback, _getHistory, _getRuntimeMinutes }
async function buildContinueWatchingMixed(tokens, opts = {}) {
  const cacheKey = `${tokens.user_key}:cw:mixed`;
  const cached = _cwCache.get(cacheKey);
  if (cached) return cached;

  const _getPlayback = opts._getPlayback || (t => playbackCache.getPlaybackCached(t));
  const _getHistory  = opts._getHistory  || (t => trakt.getHistory(t));
  const _getRuntimeMinutes = opts._getRuntimeMinutes || cinemeta.getRuntimeMinutes;

  let playback;
  try { playback = await _getPlayback(tokens); }
  catch (e) {
    if (String(e.message).includes('401')) throw Object.assign(e, { code: 'TOKEN_EXPIRED' });
    return [];
  }
  // History is a best-effort backlog — its failure must not break the resume row.
  let history = [];
  try { history = await _getHistory(tokens); } catch { history = []; }

  // One entry per title (movies keyed by imdb, shows by show imdb). Resume entries
  // are sticky; among same-class entries the most recent wins.
  const byKey = new Map();
  const consider = (it, isResume) => {
    if (!it.imdb || (it.type !== 'movie' && it.type !== 'episode')) return;
    const key = `${it.type === 'movie' ? 'm' : 's'}:${it.imdb}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...it, _resume: isResume }); return; }
    if (isResume && !prev._resume) { byKey.set(key, { ...it, _resume: true }); return; }
    if (!isResume && prev._resume) return;
    if (_ts(it) > _ts(prev)) byKey.set(key, { ...it, _resume: isResume });
  };
  for (const it of playback) consider(it, true);
  for (const it of history)  consider(it, false);

  const candidates = [...byKey.values()]
    .sort((a, b) => _ts(b) - _ts(a))
    .slice(0, MAX_ITEMS);

  // Runtime (for the resume-time hint) only matters for in-progress items — don't
  // fan out a Cinemeta fetch for every history entry.
  const runtimes = await Promise.allSettled(
    candidates.map(it => it._resume
      ? _getRuntimeMinutes(it.type === 'movie' ? 'movie' : 'series', it.imdb).catch(() => null)
      : Promise.resolve(null))
  );

  const metas = candidates.map((it, i) => {
    const type = it.type === 'movie' ? 'movie' : 'series';
    const epLabel = it.type === 'episode'
      ? `S${it.season}E${it.episode}${it.episode_title ? ' — ' + it.episode_title : ''}`
      : null;

    let parts;
    if (it._resume) {
      const minutes = runtimes[i].status === 'fulfilled' ? runtimes[i].value : null;
      const resumeSecs = minutes ? (it.progress / 100) * minutes * 60 : null;
      parts = epLabel ? [epLabel, `${Math.round(it.progress)}% watched`] : [`${Math.round(it.progress)}% watched`];
      if (resumeSecs != null) parts.push(`▶ Resume ~${fmtResumeTime(resumeSecs)}`);
    } else {
      parts = epLabel ? [epLabel, '✓ Watched'] : ['✓ Watched'];
    }
    return { ..._toMeta(it, type), description: parts.join(' · ') };
  });

  _cwCache.set(cacheKey, metas);
  return metas;
}

function _resetCachesForTesting() { _cwCache.reset(); }

module.exports = { buildContinueWatchingMixed, MAX_ITEMS, _resetCachesForTesting };
