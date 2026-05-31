const { createCache } = require('./cache');

const CINEMETA = 'https://v3-cinemeta.strem.io';
const METAHUB  = 'https://images.metahub.space';

// Separate "not found" sentinel so we can distinguish null (not-found) from undefined (not cached)
const NOT_FOUND = Symbol('NOT_FOUND');

const _runtimeCache = createCache({ maxSize: 10000, ttlMs: 24 * 60 * 60 * 1000 });
const _metaCache    = createCache({ maxSize: 10000, ttlMs: 60 * 1000 });

function posterUrl(imdbId)     { return `${METAHUB}/poster/medium/${imdbId}/img`; }
function backgroundUrl(imdbId) { return `${METAHUB}/background/medium/${imdbId}/img`; }

async function getRuntimeMinutes(type, imdbId, { _fetch = fetch } = {}) {
  const cached = _runtimeCache.get(imdbId);
  if (cached !== undefined) return cached === NOT_FOUND ? null : cached;
  try {
    const r = await _fetch(`${CINEMETA}/meta/${type}/${imdbId}.json`,
      { signal: AbortSignal.timeout(10000) });
    if (r.status >= 500) return null; // transient error — do NOT cache
    if (!r.ok) { _runtimeCache.set(imdbId, NOT_FOUND); return null; } // 404 → cache as not-found
    const data = await r.json();
    const raw = data?.meta?.runtime;
    const minutes = raw != null ? (parseInt(String(raw)) || null) : null;
    _runtimeCache.set(imdbId, minutes ?? NOT_FOUND);
    return minutes;
  } catch {
    return null; // network error — do NOT cache
  }
}

async function getMeta(type, imdbId, { _fetch = fetch } = {}) {
  const key = `${type}:${imdbId}`;
  const cached = _metaCache.get(key);
  if (cached !== undefined) return cached === NOT_FOUND ? null : cached;
  try {
    const r = await _fetch(`${CINEMETA}/meta/${type}/${imdbId}.json`,
      { signal: AbortSignal.timeout(10000) });
    if (r.status >= 500) return null; // transient error — do NOT cache (mirror getRuntimeMinutes)
    const data = r.ok ? await r.json() : null;
    const meta = data?.meta || null;
    _metaCache.set(key, meta ?? NOT_FOUND); // 404 (not found) or found → cache
    return meta;
  } catch {
    return null; // network error — do NOT cache
  }
}

function _resetCachesForTesting() {
  _runtimeCache.reset();
  _metaCache.reset();
}

module.exports = { posterUrl, backgroundUrl, getRuntimeMinutes, getMeta, _resetCachesForTesting };
