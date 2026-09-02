# Task 9 — AnimeWorld IN source fix

## Symptom
`AnimeWorld IN` (anime-only, Indian-audio anime) returned 0 streams.

## Root cause
Three issues stacked:

1. **Site moved**: `watchanimeworld.top` was no longer serving anime cards directly — its search results now redirect to `watchanimeworld.one`. The scraper's BASE URL was still `.top`.

2. **Player iframe domain changed**: the iframe src on episode pages used to be `play.zephyrix.top/video/{hash}`. It's now `play.zephyrix.org/video/{hash}`. The scraper's regex matched only the `.top` TLD.

3. **Native fetch**: the scraper used Node's native `fetch()` everywhere (TMDB, site search, episode AJAX, FirePlayer POST). Cloudflare returns 522 to non-browser TLS on this site.

4. **Wrong field picked**: the FirePlayer API returns both `videoSource` (a `master.txt` endpoint that returns "security error") and `securedLink` (a `master.m3u8?md5=...&expires=...` signed URL that actually plays). The scraper preferred `videoSource` first.

## Fix applied
**`src/nuvio/animeworld.cjs`**:
1. Updated `BASE` from `https://watchanimeworld.top` → `https://watchanimeworld.one`.
2. Updated `PLAYER` from `https://play.zephyrix.top` → `https://play.zephyrix.org`.
3. Updated link regexes to match BOTH TLDs (`watchanimeworld\.(?:top|one)`, `play\.zephyrix\.(?:top|org)`) so the fix is forward-compatible if they switch back.
4. Added a `getGotScraping()` loader (cached dynamic import).
5. Replaced `httpGet`/`httpPost` with got-scraping versions (Chrome TLS fingerprint + browser-like headers + 35s timeout). Native fetch kept as fallback only.
6. Switched the TMDB fetch in `getStreams()` to use the new `httpGet` helper.
7. Reordered the FirePlayer response: now uses `data.securedLink || data.videoSource` instead of `data.videoSource || data.securedLink`.

## Verification
```
node -e "const s = require('./src/nuvio/animeworld.cjs'); s.getStreams('31910', 'tv', 1, 1).then(streams => console.log(streams.length, 'streams'));"
```
Result: **1 stream** — Naruto Shippūden S1E1 multi-audio HLS at `https://play.zephyrix.org/cdn/hls/{hash}/master.m3u8?md5=...&expires=...`. The signed URL plays successfully (verified the master.m3u8 body returns `#EXTM3U` with multi-audio tracks).

## Files modified
- `src/nuvio/animeworld.cjs` — domain update + got-scraping + securedLink priority
