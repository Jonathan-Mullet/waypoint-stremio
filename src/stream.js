const cinemeta = require('./cinemeta');
const playbackCache = require('./playback-cache');
const { fmtResumeTime } = require('./utils');

// Build a single informational "resume" stream entry for an in-progress title.
// This is the most visible place Stremio lets an addon surface a resume point:
// it appears at the top of the stream list, exactly when the user is about to play.
//
// id is Stremio's stream id: "tt1234567" for a movie, "tt1234567:S:E" for an episode.
// Returns { streams: [] } when the title/episode isn't in the user's Trakt playback.
// opts allows test injection: { _getPlayback, _getRuntimeMinutes }.
async function buildResumeStream(tokens, type, id, opts = {}) {
  const _getPlayback = opts._getPlayback || (t => playbackCache.getPlaybackCached(t));
  const _getRuntimeMinutes = opts._getRuntimeMinutes || cinemeta.getRuntimeMinutes;

  const parts = String(id).split(':');
  const imdb = parts[0];
  const season = parts[1] != null ? Number(parts[1]) : null;
  const episode = parts[2] != null ? Number(parts[2]) : null;

  let playback;
  try { playback = await _getPlayback(tokens); }
  catch { return { streams: [] }; }

  // Find the matching in-progress entry.
  const inProgress = type === 'movie'
    ? playback.find(x => x.type === 'movie' && x.imdb === imdb)
    : playback.find(x => x.type === 'episode' && x.imdb === imdb
        && Number(x.season) === season && Number(x.episode) === episode);

  if (!inProgress || !(inProgress.progress > 0)) return { streams: [] };

  const pct = Math.round(inProgress.progress);
  const minutes = await _getRuntimeMinutes(type, imdb).catch(() => null);
  const resumeSecs = minutes ? (inProgress.progress / 100) * minutes * 60 : null;

  const title = resumeSecs != null
    ? `▶ Resume at ~${fmtResumeTime(resumeSecs)}  ·  ${pct}% watched`
    : `▶ ${pct}% watched on Trakt`;

  return {
    streams: [{
      name: 'Waypoint',
      title,
      // Stremio requires a playable/external field; link to the title on Trakt.
      // (Stremio can't auto-seek from an addon, so this is an informational entry.)
      externalUrl: `https://trakt.tv/search/imdb/${imdb}`,
      behaviorHints: { notWebReady: true },
    }],
  };
}

module.exports = { buildResumeStream };
