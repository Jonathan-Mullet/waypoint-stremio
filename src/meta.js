const cinemeta = require('./cinemeta');
const trakt = require('./providers/trakt');
const playbackCache = require('./playback-cache');
const { createCache } = require('./cache');
const { fmtResumeTime } = require('./utils');

// Per-user meta cache: user_key:type:imdbId → augmented meta (or null sentinel)
const _metaCache = createCache({ maxSize: 10000, ttlMs: 60 * 1000 });
const NULL_SENTINEL = Symbol('NULL');

// Build the augmented Cinemeta meta with a Trakt resume/up-next line.
//   movies  → resume hint from /sync/playback (partial progress)
//   series  → "Up next" from Trakt's watched-progress (the episode/season to jump
//             into), enriched with a resume % if that episode is partway watched.
// Returns null for titles with nothing to surface so Stremio falls back to Cinemeta.
// opts allows test injection: { _getPlayback, _getCinemetaMeta, _getProgress }.
async function buildMeta(tokens, type, imdbId, opts = {}) {
  const cacheKey = `${tokens.user_key}:${type}:${imdbId}`;
  const cached = _metaCache.get(cacheKey);
  if (cached !== undefined) return cached === NULL_SENTINEL ? null : cached;

  const _getPlayback     = opts._getPlayback     || (t => playbackCache.getPlaybackCached(t));
  const _getCinemetaMeta = opts._getCinemetaMeta || ((t, id) => cinemeta.getMeta(t, id));
  const _getProgress     = opts._getProgress     || ((t, id) => trakt.getShowProgress(t, id));

  const result = type === 'movie'
    ? await _buildMovie(tokens, imdbId, cacheKey, _getPlayback, _getCinemetaMeta)
    : await _buildSeries(tokens, imdbId, cacheKey, _getPlayback, _getCinemetaMeta, _getProgress);
  return result;
}

async function _buildMovie(tokens, imdbId, cacheKey, _getPlayback, _getCinemetaMeta) {
  let playback, playbackOk = true;
  try { playback = await _getPlayback(tokens); }
  catch { playback = []; playbackOk = false; }

  const inProgress = playback.find(x => x.type === 'movie' && x.imdb === imdbId && x.progress > 0);
  if (!inProgress) {
    if (playbackOk) _metaCache.set(cacheKey, NULL_SENTINEL);
    return null;
  }

  const baseMeta = await _getCinemetaMeta('movie', imdbId);
  if (!baseMeta) return null;

  const minutes = _runtimeMin(baseMeta.runtime);
  const resumeSecs = minutes ? (inProgress.progress / 100) * minutes * 60 : null;
  const timeHint = resumeSecs != null ? ` — resume ~${fmtResumeTime(resumeSecs)}` : '';
  const meta = { ...baseMeta };
  meta.description = `▶ Trakt: ${Math.round(inProgress.progress)}% watched${timeHint}\n\n${baseMeta.description || ''}`.trim();
  _metaCache.set(cacheKey, meta);
  return meta;
}

async function _buildSeries(tokens, imdbId, cacheKey, _getPlayback, _getCinemetaMeta, _getProgress) {
  // Up-next is the source of truth for "which episode to jump into".
  let progress, progressOk = true;
  try { progress = await _getProgress(tokens, imdbId); }
  catch { progress = null; progressOk = false; }

  // Not started, or fully caught up → nothing to surface; defer to Cinemeta.
  if (!progress || progress.completed === 0 || !progress.next_episode) {
    if (progressOk && progress) _metaCache.set(cacheKey, NULL_SENTINEL);
    return null;
  }
  const next = progress.next_episode;

  const baseMeta = await _getCinemetaMeta('series', imdbId);
  if (!baseMeta) return null;

  // If the up-next episode is itself partway watched, enrich with a resume point.
  let playback = [];
  try { playback = await _getPlayback(tokens); } catch { /* hint still works without it */ }
  const partial = playback.find(x =>
    x.type === 'episode' && x.imdb === imdbId &&
    Number(x.season) === Number(next.season) && Number(x.episode) === Number(next.number) && x.progress > 0);

  const label = `S${next.season}E${next.number}`;
  const epTitle = next.title ? ` · ${next.title}` : '';
  let resumeLine;
  if (partial) {
    const minutes = _runtimeMin(baseMeta.runtime);
    const resumeSecs = minutes ? (partial.progress / 100) * minutes * 60 : null;
    const timeHint = resumeSecs != null ? ` — resume ~${fmtResumeTime(resumeSecs)}` : '';
    resumeLine = `▶ Trakt — Resume ${label}${epTitle} · ${Math.round(partial.progress)}%${timeHint}`;
  } else {
    resumeLine = `▶ Trakt — Up next: ${label}${epTitle}`;
  }

  const meta = { ...baseMeta };
  meta.description = `${resumeLine}\n\n${baseMeta.description || ''}`.trim();

  // Mark the up-next episode in the episode list so it's obvious which one to pick.
  if (Array.isArray(meta.videos)) {
    meta.videos = meta.videos.map(v =>
      (Number(v.season) === Number(next.season) && Number(v.episode) === Number(next.number))
        ? { ...v, title: `▶ ${v.title || label}` }
        : v
    );
  }

  _metaCache.set(cacheKey, meta);
  return meta;
}

function _runtimeMin(raw) {
  return raw != null ? (parseInt(String(raw)) || null) : null;
}

function _resetCachesForTesting() { _metaCache.reset(); }

module.exports = { buildMeta, _resetCachesForTesting };
