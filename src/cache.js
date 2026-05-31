// LRU cache with TTL. Uses a Map (insertion-ordered) for O(1) LRU.
// Per-entry TTL override: pass ttlMs as third arg to set().
// reset() is exported for test isolation.
function createCache({ maxSize, ttlMs }) {
  const map = new Map(); // key → { value, expiresAt }

  function get(key) {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) { map.delete(key); return undefined; }
    map.delete(key); map.set(key, entry); // refresh LRU position
    return entry.value;
  }

  function set(key, value, ttlOverride) {
    if (map.has(key)) map.delete(key);
    while (map.size >= maxSize) map.delete(map.keys().next().value);
    map.set(key, { value, expiresAt: Date.now() + (ttlOverride ?? ttlMs) });
  }

  function size() { return map.size; }
  function reset() { map.clear(); }

  return { get, set, size, reset };
}

module.exports = { createCache };
