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
  const _getCinemetaMeta = opts._getCinemetaMeta || ((mtype, id) => cinemeta.getMeta(mtype, id));
  const _getProgress     = opts._getProgress     || ((t, id) => trakt.getShowProgress(t, id));

  return type === 'movie'
    ? await _buildMovie(tokens, imdbId, cacheKey, _getPlayback, _getCinemetaMeta)
    : await _buildSeries(tokens, imdbId, cacheKey, _getPlayback, _getCinemetaMeta, _getProgress);
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
  //   /shows/.../progress   → the next episode to start AFTER cleanly-finished ones,
  //                           plus the per-episode `watched` set
  // Active watchers who rely on partial scrobbling have NO completed marks (completed=0)
  // but DO have a live resume point, so playback is the PRIMARY source. Watched-progress
  // only wins when the resume point is stale (behind what you've already watched) or to
  // suppress the hint entirely when fully caught up.
  let progress = null, progressOk = true;
  try { progress = await _getProgress(tokens, imdbId); }
  catch { progressOk = false; }

  let playback = [], playbackOk = true;
  try { playback = await _getPlayback(tokens); }
  catch { playbackOk = false; }

  // Both sources down → don't cache a negative; let the next request retry.
  if (!progressOk && !playbackOk) return null;

  // Per-episode completed set (authoritative + order-independent). Drives the ✓ marks
  // and lets a finished episode override any stale leftover playback partial.
  const watchedSet = new Set((progress && progress.watched) || []);

  // In-progress partials for this show, newest entry per episode, EXCLUDING any episode
  // Trakt already marks completed (a finished episode with a leftover resume point is
  // done, not "in progress" — this also guards against scrobblers that never clear the
  // playback point on completion). "season:episode" → playback entry.
  const newestByEp = new Map();
  for (const p of playback) {
    if (p.type !== 'episode' || p.imdb !== imdbId || !(p.progress > 0 && p.progress < 100)) continue;
    const key = `${p.season}:${p.episode}`;
    if (watchedSet.has(key)) continue;
    const prev = newestByEp.get(key);
    if (!prev || new Date(p.paused_at || 0) > new Date(prev.paused_at || 0)) newestByEp.set(key, p);
  }

  // Fully caught up (every aired episode watched, nothing up next) → "caught up" marker,
  // and ✓ every episode in the list. Ignores any stale resume point Trakt left behind.
  if (progress && progress.completed > 0 && !progress.next_episode) {
    const baseMeta = await _getCinemetaMeta('series', imdbId);
    if (!baseMeta) return null;
    const n = progress.aired || progress.completed;
    const meta = { ...baseMeta };
    meta.description = `✓ Trakt — Caught up · all ${n} episode${n === 1 ? '' : 's'} watched\n\n${baseMeta.description || ''}`.trim();
    meta.videos = _annotateEpisodes(meta.videos, { watchedSet, partials: new Map(), targetKey: null, targetIsResume: false });
    _metaCache.set(cacheKey, meta);
    return meta;
  }

  // Resume point: the most-recently-paused in-progress episode (already excludes any
  // episode Trakt marks completed). Linear max scan — cheaper than sorting the whole set.
  let resume = null;
  for (const p of newestByEp.values()) {
    if (!resume || new Date(p.paused_at || 0) > new Date(resume.paused_at || 0)) resume = p;
  }

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

  // Per-episode resume strings ("60% — resume ~14m") for the in-progress (non-completed)
  // episodes, so the list shows where each partial sits.
  const partials = new Map(); // "season:episode" → "60% — resume ~14m"
  for (const [key, p] of newestByEp) {
    const secs = minutes ? (p.progress / 100) * minutes * 60 : null;
    const timeHint = secs != null ? ` — resume ~${fmtResumeTime(secs)}` : '';
    partials.set(key, `${Math.round(p.progress)}%${timeHint}`);
  }
  meta.videos = _annotateEpisodes(meta.videos, {
    watchedSet, partials, targetKey: `${season}:${number}`, targetIsResume: isResume,
  });

  _metaCache.set(cacheKey, meta);
  return meta;
}

// Annotate each episode in Cinemeta's videos list with exactly one status glyph:
//   ▶  the single actionable target (resume %, or up-next) — at most ONE
//   ✓  watched (Trakt marks it completed) — wins over any lingering partial
//   ◐  a different in-progress episode, with its %
//   (unchanged)  not started
// CRITICAL: only ever MODIFY the existing `name` field — never add `title`. Stremio's
// Video struct aliases `title`→`name` (same field); having both triggers a serde
// duplicate-field error that fails the entire series meta (Stremio falls back to
// Cinemeta, hiding the hint). Cinemeta sends episode titles in `name`.
function _annotateEpisodes(videos, { watchedSet, partials, targetKey, targetIsResume }) {
  if (!Array.isArray(videos)) return videos;
  return videos.map(v => {
    const key = `${v.season}:${v.episode}`;
    const base = v.name || `S${v.season}E${v.episode}`;
    if (targetKey && key === targetKey) {
      const info = targetIsResume ? partials.get(key) : null;
      return { ...v, name: info ? `▶ ${base} · ${info}` : `▶ ${base}` };
    }
    if (watchedSet.has(key)) return { ...v, name: `✓ ${base}` };
    const info = partials.get(key);
    if (info) return { ...v, name: `◐ ${base} · ${info}` };
    return v;
  });
}

// Compare two (season, episode) pairs. >0 if a is after b, 0 if equal, <0 if before.
function _cmpEp(s1, e1, s2, e2) { return (s1 - s2) || (e1 - e2); }

function _runtimeMin(raw) {
  return raw != null ? (parseInt(String(raw)) || null) : null;
}

function _resetCachesForTesting() { _metaCache.reset(); }

module.exports = { buildMeta, _resetCachesForTesting };
