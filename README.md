# PhoeniX v3.0.0 — Nuvio / Stremio Streaming Addon

**Faithful port of sootio-stremio-addon's HTTPS sources.** Every provider, every utility, every extractor is ported directly from the sootio codebase — no rewriting, no guessing. The 11 working HTTP streaming providers from sootio are running here unchanged.

## What was ported (from sootio-stremio-addon)

### HTTP stream providers (11 sources, one file each — exactly like sootio)

| Provider | File | Description |
|---|---|---|
| **111477** | `lib/http-streams/providers/111477/{streams,search}.js` | Direct CDN via `p.111477.xyz/bulk?u=` trick — primary source, returns ~15 streams per popular movie |
| **4KHDHub** | `lib/http-streams/providers/4khdhub/{streams,search,extraction}.js` | DDL blog → HubCloud extraction (FSL, FSLv2, PixelServer, workers.dev, pixeldrain) |
| **HDHub4u** | `lib/http-streams/providers/hdhub4u/{streams,search,extraction}.js` | DDL blog → sitemap-based search → HubCloud extraction |
| **MKVCinemas** | `lib/http-streams/providers/mkvcinemas/{streams,search}.js` | DDL → modpro.blog archive links |
| **MalluMv** | `lib/http-streams/providers/mallumv/streams.js` | Malayalam DDL → HubCloud extraction |
| **CineDoze** | `lib/http-streams/providers/cinedoze/streams.js` | Hindi DDL → savelinks → HubCloud extraction |
| **MoviesMod** | `lib/http-streams/providers/moviesmod/streams.js` | DDL → modpro.blog → driveseed/hubcloud |
| **MoviesLeech** | `lib/http-streams/providers/moviesleech/streams.js` | DDL → leechpro.blog → driveseed/hubcloud |
| **AnimeFlix** | `lib/http-streams/providers/animeflix/streams.js` | Anime DDL → direct download entries |
| **VixSrc** | `lib/http-streams/providers/vixsrc/streams.js` | HLS playlists via TMDB ID |
| **XDMovies** | `lib/http-streams/providers/xdmovies/{streams,search}.js` | API worker-based search |

### Utilities (faithful ports)

| Module | Source | Purpose |
|---|---|---|
| `lib/util/cinemeta.js` | sootio's cinemeta.js | Metadata lookup: Cinemeta → TMDB → IMDB scrape fallback chain |
| `lib/util/flaresolverr-manager.js` | sootio's flaresolverr-manager.js | Rate limiting, circuit breaker, cookie cache, per-IP limits |
| `lib/util/language-mapping.js` | sootio's language-mapping.js | 50+ language flag emojis + title-based language detection |
| `lib/util/parse-torrent-title.js` | sootio's parse-torrent-title.js | PTT wrapper for parsing S01E01, quality, codec from filenames |
| `lib/util/cache-store.js` | (simplified) | In-memory cache (sootio uses SQLite/Postgres — we use Map for simplicity) |
| `lib/common/torrent-utils.js` | sootio's torrent-utils.js | `extractFileName`, `isValidVideo`, `getResolutionFromName`, `formatSize` |

### HTTP stream infrastructure (faithful ports)

| Module | Source | Purpose |
|---|---|---|
| `lib/http-streams/utils/http.js` | sootio's http.js | `makeRequest` — Node native http/https with retry, max body size, proxy |
| `lib/http-streams/utils/encoding.js` | sootio's encoding.js | `base64Decode`, `rot13`, `encodeUrlForStreaming` |
| `lib/http-streams/utils/parsing.js` | sootio's parsing.js | `getResolutionFromName`, `getSortedMatches`, `containsWords`, `generateAlternativeQueries` |
| `lib/http-streams/utils/preview-mode.js` | sootio's preview-mode.js | `createPreviewStream`, `formatPreviewStreams` — lazy-load mode |
| `lib/http-streams/utils/validation.js` | sootio's validation.js | `validateSeekableUrl` — checks 206 Partial Content support |
| `lib/http-streams/resolvers/http-resolver.js` | (stub) | Lazy URL resolution — real work done by `/resolve/httpstreaming` endpoint |

### Stream orchestration

| Module | Source | Purpose |
|---|---|---|
| `lib/stream-provider/alternative-services/http-streams.js` | sootio's http-streams.js | Runs all 11 providers in parallel with per-source timeouts |
| `lib/stream-provider/utils/url-validation.js` | sootio's url-validation.js | `wrapHttpStreamsWithResolver` — wraps preview streams with `/resolve/httpstreaming/` URL |

## How it works in Nuvio (not browser)

The Nuvio/Stremio player is NOT a browser. It:
- Does NOT enforce CORS
- Does NOT enforce mixed-content
- Honors `behaviorHints.notWebReady: true` to skip web preflight
- Honors `behaviorHints.proxyHeaders.request` to send Referer/User-Agent
- Supports HTTP Range for seeking (206 Partial Content)

### The 111477 trick

`a.111477.xyz` is the directory listing host (CF-protected, for scraping only).
`p.111477.xyz/bulk?u=<encoded-url>` is the streaming CDN endpoint.

When Nuvio's player fetches `p.111477.xyz/bulk?u=...` from the user's residential IP, Cloudflare sees a typical residential request and serves the video bytes.

### Lazy-load preview streams

Each provider returns "preview streams" — stream objects with `needsResolution: true` and the URL being a redirector (gadgetsweb.xyz, hubcloud.in, modpro.blog, etc.). The orchestrator wraps these with `/resolve/httpstreaming/<encoded-url>`. When the user clicks play, Nuvio hits `/resolve/httpstreaming/<url>` which follows redirects and 302-redirects to the actual video URL.

## Test results

| Test | Streams | Time | Sources |
|---|---|---|---|
| Inception (tt1375666) movie | **29 streams** | 12s | 111477:20, 4KHDHub:7, HDHub4u:2 |
| Breaking Bad S1E1 (tt0903747:1:1) | **13 streams** | 12s | 111477:5, 4KHDHub:6, AnimeFlix:2 |

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /` | Landing page |
| `GET /manifest.json` | Stremio manifest |
| `GET /:apiKey?/manifest.json` | Manifest (API key prefix ignored) |
| `GET /stream/:type/:id.json` | Stream handler |
| `GET /:apiKey/stream/:type/:id.json` | Stream handler (with API key) |
| `GET /resolve/httpstreaming/:url(*)` | Lazy URL resolver → 302 redirect |
| `GET /health` | Health check with source list |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | HTTP host |
| `ADDON_NAME` | `PhoeniX` | Display name |
| `HTTP_STREAMING_TIMEOUT_MS` | `12000` | Default per-source timeout |
| `HTTP_111477_TIMEOUT` | `10000` | 111477 timeout override |
| `HTTP_4KHDHUB_TIMEOUT` | `15000` | 4KHDHub timeout override |
| `HTTP_HDHUB4U_TIMEOUT` | `15000` | HDHub4u timeout override |
| `HTTP_111477_BASE_URL` | `https://a.111477.xyz` | 111477 directory host |
| `HTTP_111477_BULK_BASE_URL` | `https://p.111477.xyz/bulk` | 111477 streaming CDN host |
| `TMDB_API_KEY` | (none) | TMDB API key (optional — Cinemeta works without auth) |
| `FLARESOLVERR_URL` | (none) | FlareSolverr base URL (e.g. `https://your-flare.onrender.com`) |
| `ALL_PROXY` | (none) | SOCKS5/HTTPS proxy URL |
| `ENABLE_HTTP_STREAM_LAZY_LOAD` | `true` | Return preview streams without validation |
| `CINEMETA_CACHE_TTL_MS` | `3600000` | Cinemeta cache TTL (1 hour) |
| `RESOLVE_CACHE_TTL_MS` | `900000` | Resolve cache TTL (15 min) |

## FlareSolverr — what value to set

**3 options** (full details below):

1. **Don't set it** (recommended for first deploy) — addon still works for non-CF sources (111477 alone returns 15+ streams per popular movie).

2. **Self-host FlareSolverr** on Render (free tier):
   - Deploy `ghcr.io/flaresolverr/flaresolverr:latest` as a separate Render Web Service
   - Set `FLARESOLVERR_URL=https://your-flaresolverr.onrender.com` (NO trailing slash, NO `/v1`)

3. Use a public instance (unreliable).

## Deployment

### Local development

```bash
cd phoenix-addon
npm install
npm start
# Addon available at http://localhost:3000/manifest.json
```

### Render.com

1. Push this directory to a GitHub repo
2. Create a new Web Service on Render, select the repo
3. Render auto-detects `render.yaml`
4. Set optional env vars (TMDB_API_KEY, FLARESOLVERR_URL)
5. Deploy

### Docker

```bash
docker build -t phoenix-addon .
docker run -p 3000:3000 phoenix-addon
```

## Install in Nuvio

1. Deploy the addon (e.g. `https://phoenix-addon.onrender.com`)
2. Open Nuvio app → Addons → Add Addon
3. Paste: `https://phoenix-addon.onrender.com/manifest.json`
4. Play any movie/series — PhoeniX streams will appear

## Architecture

```
phoenix-addon/
├── server.js                                       # Express + Stremio SDK + /resolve endpoint + landing page
├── addon.js                                        # Stremio addonBuilder + stream handler
├── package.json
├── Dockerfile
├── render.yaml
└── lib/
    ├── config.js                                   # Centralized env vars
    ├── common/
    │   └── torrent-utils.js                        # Filename extraction, video validation
    ├── util/
    │   ├── cinemeta.js                             # Cinemeta → TMDB → IMDB fallback chain
    │   ├── flaresolverr-manager.js                 # Rate limiting + circuit breaker + cookie cache
    │   ├── language-mapping.js                     # 50+ language flag emojis + detection
    │   ├── parse-torrent-title.js                  # PTT wrapper
    │   └── cache-store.js                          # In-memory cache
    ├── http-streams/
    │   ├── index.js                                # Central export point
    │   ├── utils/
    │   │   ├── http.js                             # makeRequest — Node native HTTP
    │   │   ├── encoding.js                         # base64, rot13, URL encoding
    │   │   ├── parsing.js                          # Resolution, similarity, query generation
    │   │   ├── preview-mode.js                     # Lazy-load preview streams
    │   │   └── validation.js                       # URL + seekability validation
    │   ├── resolvers/
    │   │   └── http-resolver.js                    # Stub (real work in server.js)
    │   └── providers/                              # One folder per source — EXACT sootio structure
    │       ├── 111477/{streams,search}.js
    │       ├── 4khdhub/{streams,search,extraction}.js
    │       ├── hdhub4u/{streams,search,extraction}.js
    │       ├── mkvcinemas/{streams,search}.js
    │       ├── mallumv/streams.js
    │       ├── cinedoze/streams.js
    │       ├── moviesmod/streams.js
    │       ├── moviesleech/streams.js
    │       ├── animeflix/streams.js
    │       ├── vixsrc/streams.js
    │       └── xdmovies/{streams,search}.js
    └── stream-provider/
        ├── alternative-services/
        │   └── http-streams.js                     # Orchestrates all 11 providers in parallel
        └── utils/
            └── url-validation.js                   # wrapHttpStreamsWithResolver
```

## Credits

- **sootio-stremio-addon** — 100% of the source code is ported from this repo. All credit to the original author `Sooti` (forked from `MrMonkey42/stremio-addon-debrid-search`).

## License

MIT
