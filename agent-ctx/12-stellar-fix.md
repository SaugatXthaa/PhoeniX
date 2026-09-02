# Task 12 — Stellar source fix

## Symptom
`Stellar` source returned 0 streams. Test showed:
```
[Stellar] Resolve failed: Resolve HTTP 400: {"error":"Invalid or expired encryption"}
```

## Root cause
The hardcoded `AES_KEY_SECRET` in `src/nuvio/stellar.cjs` had expired. Stellar.gdn rotates this key periodically. The previous key was:
```
+Llfj2dFC+cgFDwWSo4Yyd6ZtZmgXC7nIjaNUupYq4PCVQelINhtKiohtmm0dYUI:
```

## Fix applied
1. Pulled the new AES key from stellar.gdn's JS bundle by:
   - Fetching the homepage at `https://stellar.gdn/watch/movie/27205` (watch pages load the player chunk)
   - Iterating all `/_next/static/chunks/*.js` scripts
   - Searching for `crypto.subtle.digest("SHA-256"` which is the key derivation call
   - The string literal immediately preceding `:"+t` is the key secret

   New key:
   ```
   KT1b67W1DU2ebpGxQkMiFVyz1iaP/PeMgv/xJQDdDoU=:
   ```

2. Replaced all native `fetch()` calls with `got-scraping` for Cloudflare bypass on:
   - `getChallenge()` → folded into `gotGetJson()` helper
   - `resolveStreamUrl()` POST → `gotPostJson()` helper
   - `fetchDownloadFiles()` POST → `gotPostJson()` helper
   - `quickCheckUrl()` GET
   - `probeMasterPlaylist()` GET
   - `getTMDBInfo()` GET

3. Removed the now-unused standalone `getChallenge()` function (its logic is inlined into `resolveStreamUrl` and `fetchDownloadFiles` via the shared `gotGetJson` helper).

4. Added a helper layer (`getGotScraping`, `gotGetJson`, `gotPostJson`) that uses got-scraping with Chrome TLS fingerprint + browser-like headers (Origin, Referer, sec-fetch-*), with native fetch fallback.

## Verification
```
node -e "const s = require('./src/nuvio/stellar.cjs'); s.getStreams('27205', 'movie').then(streams => console.log(streams.length, 'streams'));"
```
Result: **8 streams** (1× 4K HLS Orbit, 1× 1080p HLS Nova, 5× BluRay REMUX downloads, 1× iframe fallback). The iframe is filtered by `Stellar.js` so the user sees 7 playable streams.

## Files modified
- `src/nuvio/stellar.cjs` — updated AES key + replaced native fetch with got-scraping
