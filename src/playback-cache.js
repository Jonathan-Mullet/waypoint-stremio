const { createCache } = require('./cache');
const trakt = require('./providers/trakt');

// Per-user playback cache. Keyed by user_key (not client_id — two users can share a Trakt app).
const _cache = createCache({ maxSize: 1000, ttlMs: 30 * 1000 });

// Fetch playback for tokens, using cache. Throws on provider error WITHOUT caching
// (a failed fetch must not poison the slot — the next request retries).
// opts.provider allows injection of a different HistoryProvider (for testing).
async function getPlaybackCached(tokens, opts = {}) {
  const cached = _cache.get(tokens.user_key);
  if (cached !== undefined) return cached;
  const provider = opts.provider || trakt;
  const items = await provider.getPlayback(tokens, opts); // throws → nothing cached
  _cache.set(tokens.user_key, items);
  return items;
}

function _resetCacheForTesting() { _cache.reset(); }

module.exports = { getPlaybackCached, _resetCacheForTesting };
