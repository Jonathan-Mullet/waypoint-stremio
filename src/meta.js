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
  // Two complementary Trakt signals, fetched tolerantly:
  //   /sync/playback        → the partially-watched episode you're mid-way through
  //                           (the resume point — this is what "Continue Watching" uses)
  //   /shows/.../progress   → the next episode to start AFTER cleanly-finished ones
  // Active watchers who rely on Stremio's partial scrobbling have NO completed marks
  // (completed=0) but DO have a live resume point, so playback is the PRIMARY source.
  // Watched-progress only wins when the resume point is stale (behind what you've
  // already watched) or to suppress the hint entirely when you're fully caught up.
  let progress = null, progressOk = true;
  try { progress = await _getProgress(tokens, imdbId); }
  catch { progressOk = false; }

  let playback = [], playbackOk = true;
  try { playback = await _getPlayback(tokens); }
  catch { playbackOk = false; }

  // Both sources down → don't cache a negative; let the next request retry.
  if (!progressOk && !playbackOk) return null;

  // Fully caught up (every aired episode watched, nothing up next) → show a "watched /
  // caught up" marker so finished shows still get a hint, ignoring any stale resume
  // point Trakt may have left behind.
  if (progress && progress.completed > 0 && !progress.next_episode) {
    const baseMeta = await _getCinemetaMeta('series', imdbId);
    if (!baseMeta) return null;
    const n = progress.aired || progress.completed;
    const meta = { ...baseMeta };
    meta.description = `✓ Trakt — Caught up · all ${n} episode${n === 1 ? '' : 's'} watched\n\n${baseMeta.description || ''}`.trim();
    _metaCache.set(cacheKey, meta);
    return meta;
  }

  // Resume point: the most-recently-paused in-progress episode for this show.
  const resume = playback
    .filter(x => x.type === 'episode' && x.imdb === imdbId && x.progress > 0 && x.progress < 100)
    .sort((a, b) => new Date(b.paused_at || 0) - new Date(a.paused_at || 0))[0] || null;

  // Up-next: only meaningful once at least one episode is cleanly watched.
  const nextUp = (progress && progress.completed > 0 && progress.next_episode) ? progress.next_episode : null;

  // Prefer the live resume point unless it's stale (strictly behind the next cleanly-
  // unwatched episode), in which case up-next is the real target.
  let chosen, isResume;
  if (resume && nextUp) {
    if (_cmpEp(resume.season, resume.episode, nextUp.season, nextUp.number) >= 0) { chosen = resume; isResume = true; }
    else { chosen = nextUp; isResume = false; }
  } else if (resume) { chosen = resume; isResume = true; }
  else if (nextUp) { chosen = nextUp; isResume = false; }
  else {
    // Nothing in progress and nothing up next (not started, or empty sources).
    if (progressOk && playbackOk && progress) _metaCache.set(cacheKey, NULL_SENTINEL);
    return null;
  }

  const baseMeta = await _getCinemetaMeta('series', imdbId);
  if (!baseMeta) return null;
  const minutes = _runtimeMin(baseMeta.runtime);

  const season = chosen.season;
  const number = isResume ? chosen.episode : chosen.number;
  const epTitleText = isResume ? chosen.episode_title : chosen.title;
  const label = `S${season}E${number}`;
  const epTitle = epTitleText ? ` · ${epTitleText}` : '';

  let resumeLine;
  if (isResume) {
    const resumeSecs = minutes ? (chosen.progress / 100) * minutes * 60 : null;
    const timeHint = resumeSecs != null ? ` — resume ~${fmtResumeTime(resumeSecs)}` : '';
    resumeLine = `▶ Trakt — Resume ${label}${epTitle} · ${Math.round(chosen.progress)}%${timeHint}`;
  } else {
    resumeLine = `▶ Trakt — Up next: ${label}${epTitle}`;
  }

  const meta = { ...baseMeta };
  meta.description = `${resumeLine}\n\n${baseMeta.description || ''}`.trim();

  // Annotate the episode list itself so the resume hint travels with each episode —
  // users shouldn't have to memorise the show-level hint. Every in-progress episode
  // gets its own "· 60% — resume ~14m"; the up-next target also gets the ▶ prefix.
  // CRITICAL: only ever modify the existing `name` field — never add `title`. Stremio's
  // Video struct aliases `title`→`name` (same field); having BOTH triggers a serde
  // duplicate-field error that fails the entire series meta (Stremio then falls back
  // to Cinemeta, hiding the hint). Cinemeta sends episode titles in `name`.
  const resumeByEp = new Map(); // "season:episode" → "60% — resume ~14m"
  for (const p of playback) {
    if (p.type !== 'episode' || p.imdb !== imdbId || !(p.progress > 0 && p.progress < 100)) continue;
    const secs = minutes ? (p.progress / 100) * minutes * 60 : null;
    const timeHint = secs != null ? ` — resume ~${fmtResumeTime(secs)}` : '';
    resumeByEp.set(`${p.season}:${p.episode}`, `${Math.round(p.progress)}%${timeHint}`);
  }
  if (Array.isArray(meta.videos)) {
    meta.videos = meta.videos.map(v => {
      const resumeInfo = resumeByEp.get(`${v.season}:${v.episode}`);
      if (resumeInfo) return { ...v, name: `▶ ${v.name || `S${v.season}E${v.episode}`} · ${resumeInfo}` };
      if (Number(v.season) === Number(season) && Number(v.episode) === Number(number)) {
        return { ...v, name: `▶ ${v.name || label}` };
      }
      return v;
    });
  }

  _metaCache.set(cacheKey, meta);
  return meta;
}

// Compare two (season, episode) pairs. >0 if a is after b, 0 if equal, <0 if before.
function _cmpEp(s1, e1, s2, e2) { return (s1 - s2) || (e1 - e2); }

function _runtimeMin(raw) {
  return raw != null ? (parseInt(String(raw)) || null) : null;
}

function _resetCachesForTesting() { _metaCache.reset(); }

module.exports = { buildMeta, _resetCachesForTesting };
