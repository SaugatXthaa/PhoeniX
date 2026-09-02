# Task 10 — NikaStream source fix

## Symptom
`NikaStream` returned ERR (timeout) — the 40s source timeout was too tight given the multi-stage flow (TMDB → AniList → 11 providers × episode fetch → /watch query → CDN validation).

## Root cause
1. **Native fetch throughout** (`fetchProviderEpisodes`, `fetchWatch`, `validateStreamUrl`, `findAniListId`, `getTMDBInfo`) — Cloudflare-protected CDNs (kryntal.top, animeapps.top, megaplay.buzz) intermittently 403/timeout native fetch.
2. **Sequential stream validation** — the `convertStream()` loop ran sequentially. Each validation has a 8-10s timeout, and NikaStream returns 10+ streams → total 60-100s+, blowing past the 40s source timeout.
3. **40s source timeout** was too tight for the full chain.

## Fix applied
**`src/nuvio/nikastream.cjs`**:
1. Added `getGotScraping()` cached loader.
2. Added `gotGet()` and `gotPostJson()` wrappers — use got-scraping with Chrome TLS fingerprint + browser-like headers (Origin, Referer, sec-fetch-* via `headerGeneratorOptions`). Native fetch kept as fallback only.
3. Replaced all native `fetch()` calls:
   - `getTMDBInfo` → `gotGet`
   - `findAniListId` → `gotPostJson` (kept 429 retry-on-backoff logic)
   - `fetchProviderEpisodes` → `gotGet` (with Origin: nikastream.blog header)
   - `fetchWatch` → `gotGet` (with Origin header)
   - `validateStreamUrl` → `gotGet` (CDN validation now uses Chrome TLS)
4. **Parallelized stream conversion** — replaced the sequential `for...of await convertStream()` loop with a bounded `mapPool(tasks, 8, worker)` that converts + validates 8 streams in parallel. This cut total time from 62s → 31s for 11 streams.

**`src/source/NikaStream.js`**:
5. Increased `Promise.race` timeout from 40s → 70s to give the (now parallel) validation step room to complete even when several CDNs hang.

## Verification
```
node -e "const s = require('./src/nuvio/nikastream.cjs'); s.getStreams('31910', 'tv', 1, 1).then(streams => console.log(streams.length, 'streams'));"
```
Result: **11 streams in 31.1s** (was 5 streams in 62.4s). Stream types include:
- anikoto SUB/DUB HLS (kryntal.top, akirax.buzz)
- anibd SUB HLS (animeapps.top)
- animegg SUB/DUB MP4 (animegg.org)
- reanime SUB/DUB iframe (flixcloud.cc — gets filtered by source, but reported)
- 2dhive SUB/DUB HLS (megaplay.buzz)

All 11 streams are now returned well within the new 70s source timeout.

## Files modified
- `src/nuvio/nikastream.cjs` — got-scraping + parallel conversion
- `src/source/NikaStream.js` — timeout 40s → 70s
