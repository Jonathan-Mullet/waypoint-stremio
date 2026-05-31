# Waypoint

Trakt resume hints and Continue Watching for Stremio.

See exactly where to seek when picking up where you left off — across any Trakt-connected app (Plex, Kodi, Infuse, the official Trakt app).

## Features

- **Continue Watching rows** — movies and series in progress appear in Stremio
- **Resume hints** — detail pages show "▶ Trakt: S2E4 at 47% — Resume ~22m"; in-progress episode is marked in the episode list
- **Watchlist rows** — your Trakt watchlist in Stremio

## Install (hosted)

1. Visit **https://41cf857f6e87-waypoint.baby-beamup.club**
2. [Create a free Trakt API app](https://trakt.tv/oauth/applications/new) — redirect URI: `urn:ietf:wg:oauth:2.0:oob`
3. Paste your Client ID and Secret → authorize → click "Install in Stremio"

**Save your install link.** It is valid for 90 days. Waypoint does not store credentials server-side.

## Architecture

No database. Each user's Trakt tokens are AES-256-GCM encrypted into the manifest URL itself. All caches are ephemeral and in-memory. Token lifetime: 90 days from initial auth; re-auth via the config page when expired.

## Self-host

```bash
git clone https://github.com/Jonathan-Mullet/waypoint-stremio
cd waypoint-stremio
export CIPHER_KEY=$(openssl rand -hex 32)            # 64 hex chars; store securely
export PORT=3000
export PUBLIC_URL=https://your-addon.example.com    # the addon's public origin
npm install --omit=dev
npm start
```

`CIPHER_KEY` must never change — rotating it invalidates all existing manifest URLs. Changing it is equivalent to logging out every user.

`PUBLIC_URL` is the addon's public origin, used for the logo/poster/reconnect URLs. Set it whenever the app runs behind a reverse proxy that rewrites the `Host` header (e.g. Beamup). If unset, the addon falls back to the request `Host` header (fine for direct local access).

## Development

```bash
npm test    # node:test unit + integration tests
npm start   # dev server (requires CIPHER_KEY env var)
```

## Adding a provider (e.g., Simkl)

1. Create `src/providers/simkl.js` implementing the same `getPlayback(tokens, opts)` / `getWatchlist(tokens, kind, opts)` interface as `src/providers/trakt.js`
2. Update `src/config.js` to support `v: 2` config blobs with a `simkl_token` field
3. Update `src/catalog.js` and `src/meta.js` to call both providers and merge results

## License

MIT
