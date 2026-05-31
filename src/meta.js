const cinemeta = require('./cinemeta');
const playbackCache = require('./playback-cache');
const { createCache } = require('./cache');
const { fmtResumeTime } = require('./utils');

// Per-user meta cache: user_key:type:imdbId → augmented meta (or null sentinel)
const _metaCache = createCache({ maxSize: 10000, ttlMs: 60 * 1000 });
const NULL_SENTINEL = Symbol('NULL');

function _pickDeepestEpisode(items, imdbId) {
  return items
    .filter(x => x.type === 'episode' && x.imdb === imdbId)
    .reduce((best, e) => {
      if (!best) return e;
      return (Number(e.season) * 10000 + Number(e.episode)) >
             (Number(best.season) * 10000 + Number(best.episode)) ? e : best;
    }, null);
}

// opts allows test injection: { _getPlayback, _getCinemetaMeta }
async function buildMeta(tokens, type, imdbId, opts = {}) {
  const cacheKey = `${tokens.user_key}:${type}:${imdbId}`;
  const cached = _metaCache.get(cacheKey);
  if (cached !== undefined) return cached === NULL_SENTINEL ? null : cached;

  const _getPlayback = opts._getPlayback || (t => playbackCache.getPlaybackCached(t));
  const _getCinemetaMeta = opts._getCinemetaMeta || ((t, id) => cinemeta.getMeta(t, id));

  // Track whether playback was fetched cleanly. A transient Trakt failure yields
  // an empty list, but we must NOT cache "no hint" in that case — otherwise a brief
  // Trakt blip suppresses the resume hint for a full 60s even after recovery.
  let playback, playbackOk = true;
  try { playback = await _getPlayback(tokens); }
  catch { playback = []; playbackOk = false; }

  // Short-circuit: title not in progress → return null (Stremio falls back to Cinemeta)
  const inProgress = type === 'movie'
    ? playback.find(x => x.type === 'movie' && x.imdb === imdbId)
    : _pickDeepestEpisode(playback, imdbId);

  if (!inProgress) {
    // Only cache the negative result when playback was fetched cleanly — a genuine
    // "not in progress". A failed fetch returns null but stays uncached so it retries.
    if (playbackOk) _metaCache.set(cacheKey, NULL_SENTINEL);
    return null;
  }

  const baseMeta = await _getCinemetaMeta(type, imdbId);
  if (!baseMeta) {
    // baseMeta may be null from a transient Cinemeta error — do NOT cache here.
    // cinemeta.getMeta caches genuine 404s itself; transient 5xx/network return
    // uncached null, so the next request retries.
    return null;
  }

  // Extract runtime from the already-fetched Cinemeta meta — no second API call
  const rawRuntime = baseMeta.runtime;
  const minutes = rawRuntime != null ? (parseInt(String(rawRuntime)) || null) : null;
  const resumeSecs = minutes ? (inProgress.progress / 100) * minutes * 60 : null;
  const timeHint = resumeSecs != null ? ` — Resume ~${fmtResumeTime(resumeSecs)}` : '';
  const pct = Math.round(inProgress.progress);

  const resumeLine = type === 'movie'
    ? `▶ Trakt: ${pct}% watched${timeHint}`
    : `▶ Trakt: S${inProgress.season}E${inProgress.episode} at ${pct}%${timeHint}`;

  const meta = { ...baseMeta };
  meta.description = `${resumeLine}\n\n${baseMeta.description || ''}`.trim();

  if (type === 'series' && Array.isArray(meta.videos)) {
    meta.videos = meta.videos.map(v =>
      (v.season === inProgress.season && v.episode === inProgress.episode)
        ? { ...v, title: `▶ ${v.title || `S${v.season}E${v.episode}`}` }
        : v
    );
  }

  _metaCache.set(cacheKey, meta);
  return meta;
}

function _resetCachesForTesting() { _metaCache.reset(); }

module.exports = { buildMeta, _resetCachesForTesting };
