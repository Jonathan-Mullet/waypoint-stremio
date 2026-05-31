const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { resolveConfig, encryptConfig } = require('./config');
const { startDeviceCode, pollDeviceToken } = require('./providers/trakt');
const { buildContinueWatchingMixed, buildWatchlistMixed } = require('./catalog');
const { buildMeta } = require('./meta');
const { log } = require('./utils');

// ── Startup validation ────────────────────────────────────────────────────────
const CIPHER_KEY = process.env.CIPHER_KEY || '';
if (!/^[0-9a-f]{64}$/i.test(CIPHER_KEY)) {
  console.error('FATAL: CIPHER_KEY must be a 64-character hex string.');
  console.error('Generate with: openssl rand -hex 32');
  process.exit(1);
}

const app = express();
const VERSION = require('../package.json').version;
const START_TIME = Date.now();

app.use(express.json({ limit: '4kb' }));

// ── Constants ─────────────────────────────────────────────────────────────────
const VALID_TYPES    = new Set(['movie', 'series']);
const VALID_CATALOGS = new Set(['waypoint-cw', 'waypoint-watchlist']);
const IMDB_RE = /^tt\d{6,8}$/;

// ── Rate limiting (keyed by sha256 of raw encoded blob — before decryption) ──
// Because rate-limiting runs BEFORE decryption, any distinct valid-charset config
// string creates a bucket. _rateBuckets is therefore HARD-CAPPED to bound memory:
// an attacker flooding unique random configs cannot grow the map without limit.
// Evicting a bucket only resets that key's quota (fail-open on rate limit) — the
// limiter exists to protect Trakt, which enforces its own per-account cap as backstop.
const _rateBuckets = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const RATE_PER_TOKEN_MS = RATE_WINDOW_MS / RATE_LIMIT; // 1000ms per token
const MAX_RATE_BUCKETS = 50_000;

function _checkRateLimit(rawKey) {
  const now = Date.now();
  let b = _rateBuckets.get(rawKey);
  if (!b) {
    // Bound the map: evict the oldest-inserted bucket when at capacity.
    if (_rateBuckets.size >= MAX_RATE_BUCKETS) {
      _rateBuckets.delete(_rateBuckets.keys().next().value);
    }
    _rateBuckets.set(rawKey, { tokens: RATE_LIMIT - 1, lastRefill: now });
    return true;
  }
  const refill = Math.floor((now - b.lastRefill) / RATE_PER_TOKEN_MS);
  if (refill > 0) {
    b.tokens = Math.min(RATE_LIMIT, b.tokens + refill);
    // Advance lastRefill by exactly the time consumed — preserves the sub-token
    // remainder so the effective rate stays accurate under sparse traffic.
    b.lastRefill += refill * RATE_PER_TOKEN_MS;
  }
  if (b.tokens <= 0) return false;
  b.tokens--;
  return true;
}
const _rateCleanupInterval = setInterval(() => {
  const cutoff = Date.now() - 2 * RATE_WINDOW_MS;
  for (const [k, v] of _rateBuckets) if (v.lastRefill < cutoff) _rateBuckets.delete(k);
}, RATE_WINDOW_MS).unref(); // .unref() so the interval doesn't prevent process exit in tests

// ── OAuth endpoint protection ─────────────────────────────────────────────────
// /api/oauth/* are anonymous and proxy outbound calls to Trakt — they are NOT
// covered by the per-config limiter above. A single GLOBAL token bucket caps
// total outbound OAuth load regardless of client. Global (not per-IP) is the
// robust choice here: Beamup sits behind a proxy, so req.ip is either shared
// across all users or spoofable via X-Forwarded-For — a per-IP map would both
// mis-throttle and reintroduce the unbounded-map DoS surface. Legitimate
// onboarding is rare (a user authorizes once), so a generous global cap of
// 120/min never affects real users but stops a flood from abusing Trakt.
const OAUTH_RATE_LIMIT = 120;
const OAUTH_PER_TOKEN_MS = RATE_WINDOW_MS / OAUTH_RATE_LIMIT; // 500ms → 120/min
let _oauthTokens = OAUTH_RATE_LIMIT;
let _oauthLastRefill = Date.now();
function _checkOAuthRateLimit() {
  const now = Date.now();
  const refill = Math.floor((now - _oauthLastRefill) / OAUTH_PER_TOKEN_MS);
  if (refill > 0) {
    _oauthTokens = Math.min(OAUTH_RATE_LIMIT, _oauthTokens + refill);
    _oauthLastRefill += refill * OAUTH_PER_TOKEN_MS;
  }
  if (_oauthTokens <= 0) return false;
  _oauthTokens--;
  return true;
}
function oauthLimiter(_req, res, next) {
  if (!_checkOAuthRateLimit()) {
    return res.status(429).set('Retry-After', '60').json({ error: 'rate limit exceeded' });
  }
  next();
}

// ── CORS (addon routes only) ──────────────────────────────────────────────────
function addonCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// ── Request logging ───────────────────────────────────────────────────────────
app.use((req, _res, next) => { req._startMs = Date.now(); next(); });
app.use((req, res, next) => {
  res.on('finish', () => log('info', 'request', {
    method: req.method, path: req.path,
    status: res.statusCode, ms: Date.now() - req._startMs,
  }));
  next();
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime_s: Math.floor((Date.now() - START_TIME) / 1000), version: VERSION });
});

// ── Static (onboarding page) ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// Stremio's "Configure" button opens <base>/configure or <base>/<config>/configure.
// Serve the onboarding page at both so the gear works (and so a base manifest, if
// ever added, can route users to setup) instead of 404ing.
const _onboardingPage = path.join(__dirname, '..', 'public', 'index.html');
app.get('/configure', (_req, res) => res.sendFile(_onboardingPage));
app.get('/:config/configure', (_req, res) => res.sendFile(_onboardingPage));

// ── OAuth API (no CORS — same-origin from config page) ───────────────────────
app.post('/api/oauth/start', oauthLimiter, async (req, res) => {
  const { client_id, client_secret } = req.body || {};
  if (!client_id || !client_secret) return res.status(400).json({ error: 'missing fields' });
  try {
    res.json(await startDeviceCode(client_id));
  } catch (e) {
    log('error', 'oauth/start failed', { status: e.message });
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/oauth/poll', oauthLimiter, async (req, res) => {
  const { client_id, client_secret, device_code } = req.body || {};
  if (!client_id || !client_secret || !device_code) return res.status(400).json({ error: 'missing fields' });
  try {
    const result = await pollDeviceToken(client_id, client_secret, device_code);
    if (result.status === 'authorized') {
      const config_token = encryptConfig({
        v: 1, client_id, client_secret,
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        expires_at: result.expires_at,
      });
      return res.json({ status: 'authorized', config_token });
    }
    res.json({ status: result.status });
  } catch (e) {
    log('error', 'oauth/poll failed', { status: e.message });
    res.status(502).json({ error: e.message });
  }
});

// ── Config middleware ─────────────────────────────────────────────────────────
async function withConfig(req, res, next) {
  const { config } = req.params;
  if (!/^[A-Za-z0-9_-]+$/.test(config)) return res.status(400).json({ error: 'invalid config' });

  // Rate limit BEFORE decryption — keyed by raw blob hash
  const rateKey = crypto.createHash('sha256').update(config).digest('hex').slice(0, 16);
  if (!_checkRateLimit(rateKey)) {
    return res.status(429).set('Retry-After', '60').json({ error: 'rate limit exceeded' });
  }

  try {
    req.traktConfig = await resolveConfig(config);
    next();
  } catch (e) {
    if (e.code === 'TOKEN_EXPIRED') {
      req.tokenExpired = true;
      next();
    } else {
      res.status(400).json({ error: 'invalid config' });
    }
  }
}

// The addon's own public base URL, used for logo / poster / reconnect-text URLs.
// Behind Beamup's proxy (Cloudflare → Beamup → Dokku) the Host header is rewritten
// to the internal Dokku app name and no X-Forwarded-Host is sent, so the public
// domain is NOT recoverable from request headers. PUBLIC_URL makes it explicit;
// set it as an env var to the deployed origin (e.g. https://<app>.baby-beamup.club).
// Falls back to the request host for local dev / self-hosting where Host is correct.
// Stremio requires addons to be served over https, so https is assumed in fallback.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const baseUrl = (req) => PUBLIC_URL || `https://${req.get('host')}`;
const hostOf = (req) => PUBLIC_URL ? PUBLIC_URL.replace(/^https?:\/\//, '') : req.get('host');

// ── Manifest ──────────────────────────────────────────────────────────────────
const MANIFEST = {
  id: 'io.github.waypoint-stremio',
  version: VERSION,
  name: 'Waypoint',
  description: 'Resume hints and Continue Watching from Trakt. See exactly where to seek to pick up where you left off — across any Trakt-connected app.',
  // Two mixed rows: movies + shows interleaved by recency. Each row is declared
  // type 'movie' but returns metas of BOTH types (each meta carries its own `type`,
  // which is what Stremio routes clicks on). Series meta still works because the
  // meta resource keys off the `types` array below, NOT off declaring a series
  // catalog — verified in stremio-core's is_resource_supported.
  catalogs: [
    { type: 'movie', id: 'waypoint-cw',        name: 'Continue Watching · Waypoint' },
    { type: 'movie', id: 'waypoint-watchlist', name: 'Watchlist · Waypoint' },
  ],
  resources: ['catalog', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  // configurable: shows a "Configure" gear that opens <base>/<config>/configure
  // (served below). NOT configurationRequired — by the time Stremio fetches a
  // token-bearing manifest URL the addon is already configured, so it must
  // present as installable; configurationRequired:true makes Stremio refuse to
  // install and 404 on /configure instead.
  behaviorHints: { configurable: true },
};

// ── Addon routes ──────────────────────────────────────────────────────────────
app.options('/:config/*', addonCors, (_req, res) => res.sendStatus(204));

app.get('/:config/manifest.json', addonCors, withConfig, (req, res) => {
  if (req.tokenExpired) return res.status(400).json({ error: `token expired — reconnect at ${hostOf(req)}` });
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ ...MANIFEST, logo: `${baseUrl(req)}/logo.png` });
});

app.get('/:config/catalog/:type/:catalogId.json', addonCors, withConfig, async (req, res) => {
  const { type, catalogId } = req.params;
  if (!VALID_TYPES.has(type))         return res.status(400).json({ error: 'invalid type' });
  if (!VALID_CATALOGS.has(catalogId)) return res.status(400).json({ error: 'invalid catalog' });

  if (req.tokenExpired) {
    return res.json({ metas: [{
      id: 'waypoint-reconnect', type,
      name: '⚠️ Waypoint: Trakt connection expired',
      poster: `${baseUrl(req)}/logo.png`,
      description: `Visit ${hostOf(req)} to reconnect.`,
    }]});
  }

  try {
    const cfg = req.traktConfig;
    const metas = catalogId === 'waypoint-cw'
      ? await buildContinueWatchingMixed(cfg)
      : await buildWatchlistMixed(cfg);

    res.set('Cache-Control', 'public, max-age=30');
    res.json({ metas });
  } catch (e) {
    if (e.code === 'TOKEN_EXPIRED') return res.json({ metas: [{
      id: 'waypoint-reconnect', type,
      name: '⚠️ Waypoint: Trakt token revoked', poster: `${baseUrl(req)}/logo.png`,
      description: `Visit ${hostOf(req)} to reconnect.`,
    }]});
    log('error', 'catalog error', { catalogId, msg: e.message });
    res.json({ metas: [] });
  }
});

app.get('/:config/meta/:type/:id.json', addonCors, withConfig, async (req, res) => {
  const { type, id } = req.params;
  if (!VALID_TYPES.has(type)) return res.status(400).json({ error: 'invalid type' });
  if (!IMDB_RE.test(id))     return res.status(400).json({ error: 'invalid id' });
  if (req.tokenExpired)      return res.json({ meta: null });

  try {
    const meta = await buildMeta(req.traktConfig, type, id);
    // Short TTLs: resume hints change as you watch, and a "no hint" result should
    // flip to a hint quickly once a show is started — keeps stale results from
    // lingering in Stremio/Cloudflare caches.
    res.set('Cache-Control', `public, max-age=${meta ? 30 : 90}`);
    res.json({ meta: meta || null });
  } catch (e) {
    log('error', 'meta failed', { id, msg: e.message });
    res.json({ meta: null });
  }
});

// ── JSON error handler (must be registered last, 4 args) ──────────────────────
// Malformed request bodies (express.json SyntaxError) and any unhandled route
// error return consistent JSON rather than Express's default HTML page.
// NODE_ENV=production already prevents stack-trace leaks; this adds shape consistency.
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  log('error', 'unhandled error', { path: req.path, msg: err.message });
  res.status(500).json({ error: 'internal error' });
});

// ── Server start + graceful shutdown ──────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => log('info', `Waypoint v${VERSION} on :${PORT}`));
  process.on('SIGTERM', () => {
    log('info', 'SIGTERM received — shutting down');
    clearInterval(_rateCleanupInterval);
    server.close(() => { log('info', 'server closed'); process.exit(0); });
    setTimeout(() => process.exit(0), 5000);
  });
}

module.exports = app;
