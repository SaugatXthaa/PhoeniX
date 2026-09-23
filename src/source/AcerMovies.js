// src/source/AcerMovies.js
// acermovies.fun — movies (direct GDrive CDN URLs)
//
// Flow:
//   1. POST https://api2.acermovies.fun/api/search  { searchQuery: title }
//      → { searchResult: [{ title, url, image }] }
//   2. POST https://api2.acermovies.fun/api/sourceQuality  { url }
//      → { sourceQualityList: [{ title, url, quality, episodesUrl, batchUrl }], meta }
//   3. For movie (url is non-empty): POST https://api2.acermovies.fun/api/sourceUrl  { url, seriesType: "movie" }
//      → { sourceUrl: "https://video-downloads.googleusercontent.com/..." }
//
// The final sourceUrl is a direct GDrive CDN MP4/MKV — same pattern as
// HubCloud's HubCDN streams. No extractor needed; the URL plays directly.
//
// Movies only. Series return episodesUrl which leads to a multi-stage
// redirect chain through cloud.unblockedgames.world (CF-protected blog
// with JS auto-submit) — not resolvable server-side without a browser.
//
// Search returns results from moviesmod.zone — Hindi/English dual audio
// focused, but covers Hollywood, Korean, and anime movies too.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { withRetryOnEmpty } from './nuvioHelpers.js';
import { TooManyRequestsError } from '../error/index.js';

const API_BASE = 'https://api2.acermovies.fun';
const ORIGIN = 'https://acermovies.fun';

// Task 81: api2 rate-limits by IP with a LONG window (the site's own UI says
// "rate limited ... up to 24 hours"). Render's shared egress IP trips it
// regularly (Task 71 delivered, Task 78 429/conn-fail, Task 81 measured live:
// POST /api/search → 429 {"message":"Too many requests..."} from prod egress
// while the same POST from a residential IP 200s in 1.7s — API + protocol
// UNCHANGED, the site's bundle still calls the same /api/search,
// /api/sourceQuality, /api/sourceUrl on api2).
// Strategy: never fight the ban.
//   - 429 → 10min cooldown circuit: ZERO upstream calls during it (retrying
//     into a 429 extends bans and wastes the client budget).
//   - 24h in-memory fallback cache of the last good results per title —
//     during cooldowns we serve those instead of an honest zero (the final
//     googleusercontent URLs are signed CDN links; dead ones fail fast at
//     play time via the Task 75 proxies, player moves to the next card).
//   - normal path unchanged: fresh resolve, 3-attempt empty-retry.
const RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;
const RESULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RESULT_CACHE_MAX = 200;

// Task 84: egress-relay fallback. The ban is on RENDER'S IP, not on acer's
// API — the identical POST relayed through the public Cloudflare Worker
// mirror (test.cors.workers.dev) answers 200 @0.5s with real search results
// while direct POSTs 429 (Task 84 live A/B). The relay's egress is CF's
// range, which is outside acer's per-IP window. This turns the 10min
// cooldown from "serve cache or zero" into "serve cache, else resolve
// through the relay" — the source keeps working during bans.
// Relay failures are treated as ordinary empties (honest zero), never
// retried into; ACER_RELAY_BASE env override exists for rotation.
const RELAY_BASE = process.env.ACER_RELAY_BASE || 'https://test.cors.workers.dev/?';
const RELAY_TIMEOUT_MS = 12000;
// Task 84b: the public relay is itself rate-limited at the CF edge (measured:
// 429 HTML block page after a burst of relayed calls, from ANY client IP).
// After a relay 429, pause relay attempts for 90s — the cooldown resolve
// path already retries on empty and would otherwise hammer the relay.
const RELAY_COOLDOWN_MS = 90 * 1000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Origin': ORIGIN,
  'Referer': `${ORIGIN}/`,
  // Task 79: the hls.lol family lesson — header-based WAFs soft-block requests
  // lacking the browser's own fetch headers (429/empty instead of a hard 403).
  // api2 rate-limits Render egress intermittently (Task 71 delivered 3@2.1s,
  // Task 78 all-zero with 429/conn-fail signatures); these are what a real
  // browser POST from the site sends. Harmless if the gate is purely IP-based.
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

// Parse quality string ("480p", "720p", "1080p", "1080p 10Bit HEVC") → height
function parseHeight(quality) {
  if (!quality) return undefined;
  const m = String(quality).match(/(\d{3,4})p?/i);
  return m ? parseInt(m[1], 10) : undefined;
}

// Detect language flags from title (e.g. "Dual Audio (Hindi-English)" → hi, en)
function countryCodesFromTitle(title) {
  if (!title) return [CountryCode.multi];
  const t = String(title).toLowerCase();
  const codes = new Set();
  if (t.includes('hindi') || t.includes('hin')) codes.add(CountryCode.hi);
  if (t.includes('english') || t.includes('eng')) codes.add(CountryCode.en);
  if (t.includes('tamil') || t.includes('tam')) codes.add(CountryCode.ta);
  if (t.includes('telugu') || t.includes('tel')) codes.add(CountryCode.te);
  if (t.includes('korean') || t.includes('kor')) codes.add(CountryCode.ko);
  if (t.includes('japanese') || t.includes('jpn') || t.includes('anime')) codes.add(CountryCode.ja);
  if (t.includes('chinese') || t.includes('chi')) codes.add(CountryCode.zh);
  if (codes.size === 0) codes.add(CountryCode.multi);
  return [...codes];
}

export class AcerMovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'acermovies';
    this.label = 'AcerMovies';
    this.contentTypes = ['movie'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = ORIGIN;
    this.fetcher = fetcher;
    this.ttl = 3600000; // 1h — sourceUrl is short-lived but Stremio caches the resolved URL
    this._cooldownUntil = 0;   // rate-limit circuit: no upstream calls before this ts
    this._resultCache = new Map(); // cacheKey -> { results, at } — 429 fallback
    this._relayCooldownUntil = 0; // Task 84b: relay's own CF-edge rate limit
  }

  // Task 81: the Fetcher throws TooManyRequestsError on 429; the previous
  // catch-all swallowed it, so rate-limits looked like ordinary empty
  // resolves and withRetryOnEmpty hammered the API 3× per request.
  _noteRateLimit(where) {
    this._cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    console.log(`[acermovies] 429 rate-limited at ${where} — cooldown ${RATE_LIMIT_COOLDOWN_MS / 60000}min (direct calls stop; relay resolves continue)`);
  }

  // Task 84: unified API POST with egress-relay fallback.
  //   - cooldown ACTIVE → relay only (direct calls would extend the ban; the
  //     relay egress is a different IP class and is not banned).
  //   - cooldown INACTIVE → direct first; a 429 flips to the relay in the same
  //     request (and engages the cooldown for future direct calls).
  // The relay returns the upstream body verbatim (verified: identical
  // searchResult JSON, only ~1 byte diff from chunked framing).
  async _apiPost(ctx, path, body, timeoutMs = 15000) {
    const directUrl = new URL(path, API_BASE);
    const relayMode = Date.now() < this._cooldownUntil;
    if (!relayMode) {
      try {
        return await this.fetcher.textPost(ctx, directUrl, body, { headers: HEADERS, timeout: timeoutMs });
      } catch (e) {
        if (e instanceof TooManyRequestsError) {
          this._noteRateLimit(path);
          // fall through to relay
        } else {
          throw e;
        }
      }
    }
    // Relay path (cooldown active, or direct just 429'd) — paced: after a
    // relay 429 we back off 90s instead of hammering the shared demo worker.
    if (Date.now() < this._relayCooldownUntil) {
      throw new Error('relay in cooldown (own rate limit)');
    }
    const relayUrl = RELAY_BASE + directUrl.toString();
    try {
      const resp = await fetch(relayUrl, {
        method: 'POST',
        headers: HEADERS,
        body,
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      if (!resp.ok) {
        if (resp.status === 429) {
          this._relayCooldownUntil = Date.now() + RELAY_COOLDOWN_MS;
          throw new Error(`relay rate-limited (pausing ${RELAY_COOLDOWN_MS / 1000}s)`);
        }
        throw new Error(`relay HTTP ${resp.status}`);
      }
      return await resp.text();
    } catch (e) {
      console.log(`[acermovies] relay ${path} failed: ${e?.message || e}`);
      throw e;
    }
  }

  async handleInternal(ctx, _type, id) {
    const now = Date.now();
    const hit = this._resultCache.get(id);

    // Cooldown circuit — direct calls stop. Serve cached results first;
    // without a cache, resolve through the relay (Task 84) instead of an
    // honest zero. Relay traffic does not touch acer from OUR IP, so it
    // cannot extend the ban.
    if (now < this._cooldownUntil) {
      if (hit && now - hit.at < RESULT_CACHE_TTL_MS) {
        console.log(`[acermovies] rate-limit cooldown — serving ${hit.results.length} cached cards (age ${Math.round((now - hit.at) / 60000)}min)`);
        return hit.results;
      }
      try {
        const relayed = await withRetryOnEmpty(() => this._resolve(ctx, id), { attempts: 2, maxTotalMs: 12000, tag: 'acermovies-relay' });
        if (relayed.length > 0) {
          if (this._resultCache.size >= RESULT_CACHE_MAX) {
            const oldest = this._resultCache.keys().next().value;
            this._resultCache.delete(oldest);
          }
          this._resultCache.set(id, { results: relayed, at: Date.now() });
          console.log(`[acermovies] cooldown relay resolve delivered ${relayed.length} cards`);
        }
        return relayed;
      } catch (e) {
        console.log(`[acermovies] cooldown relay resolve failed: ${e?.message || e} — honest zero`);
        return [];
      }
    }

    // Task 63: the modpro.blog upstream rate-limits intermittently (production
    // evidence: 1-of-3 probes delivered, failures @~700ms → silent [] and the
    // 60s negative cache then hid the recovery). Bounded empty-retry rides out
    // the bad windows like the stellarrip/uhdmovies wrappers.
    const results = await withRetryOnEmpty(() => this._resolve(ctx, id), { attempts: 3, maxTotalMs: 14000, tag: 'acermovies' });

    if (results.length > 0) {
      // Bounded 24h fallback cache (429 survival)
      if (this._resultCache.size >= RESULT_CACHE_MAX) {
        const oldest = this._resultCache.keys().next().value;
        this._resultCache.delete(oldest);
      }
      this._resultCache.set(id, { results, at: Date.now() });
    }
    return results;
  }

  async _resolve(ctx, id, opts = {}) {
    const relay = opts.relay === true;
    // 429 landed mid-retry (attempt N of the empty-retry ladder): bail instead
    // of POSTing again DIRECTLY — each extra direct call into the rate limiter
    // extends the ban. Relay resolves are exempt (different egress).
    if (Date.now() < this._cooldownUntil && !relay) return [];
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Series not supported — episodes go through CF-protected blog chain
    if (tmdbId.season) return [];

    // Step 1: search by name (+ year for disambiguation)
    const searchQuery = year ? `${name} ${year}` : name;
    let searchJson;
    try {
      searchJson = await this._apiPost(ctx, '/api/search', JSON.stringify({ searchQuery }));
    } catch (e) {
      if (e instanceof TooManyRequestsError) { this._noteRateLimit('search'); return []; }
      return [];
    }

    let searchResult;
    try { searchResult = JSON.parse(searchJson); } catch { return []; }
    const searchResults = Array.isArray(searchResult?.searchResult) ? searchResult.searchResult : [];
    if (searchResults.length === 0 || Date.now() < this._cooldownUntil) return [];

    // Find best match — prefer one whose title contains the name (case-insensitive)
    const nameLower = name.toLowerCase();
    let bestMatch = searchResults.find(r => r.title?.toLowerCase().includes(nameLower));
    if (!bestMatch) bestMatch = searchResults[0];
    if (!bestMatch?.url) return [];

    // Step 2: get quality options for the matched movie
    let qualityJson;
    try {
      qualityJson = await this._apiPost(ctx, '/api/sourceQuality', JSON.stringify({ url: bestMatch.url }));
    } catch (e) {
      if (e instanceof TooManyRequestsError) { this._noteRateLimit('sourceQuality'); return []; }
      return [];
    }

    let qualityResult;
    try { qualityResult = JSON.parse(qualityJson); } catch { return []; }
    const qualityList = Array.isArray(qualityResult?.sourceQualityList) ? qualityResult.sourceQualityList : [];

    // Filter to movie entries (url is non-empty; series entries only have episodesUrl)
    const movieQualities = qualityList.filter(q => q?.url && !q.episodesUrl);
    if (movieQualities.length === 0 || Date.now() < this._cooldownUntil) return [];

    // Step 3: resolve each quality to a direct GDrive URL (in parallel, bounded)
    // Deduplicate by quality string to avoid redundant calls
    const seenQualities = new Set();
    const uniqueQualities = movieQualities.filter(q => {
      const key = q.quality || q.title;
      if (seenQualities.has(key)) return false;
      seenQualities.add(key);
      return true;
    });

    const results = [];
    const resolveOne = async (q) => {
      // A 429 mid-batch (attempt N of M qualities) must stop the remaining
      // DIRECT calls immediately — each extra POST into the rate limiter
      // extends it. Relay resolves are exempt (different egress class).
      if (Date.now() < this._cooldownUntil && !relay) return null;
      try {
        const body = JSON.stringify({ url: q.url, seriesType: 'movie' });
        const resp = await this._apiPost(ctx, '/api/sourceUrl', body, 15000);
        const parsed = JSON.parse(resp);
        const directUrl = parsed?.sourceUrl;
        if (!directUrl) return null;
        let parsedUrl;
        try { parsedUrl = new URL(directUrl); } catch { return null; }
        if (!parsedUrl) return null;

        const height = parseHeight(q.quality);
        const countryCodes = countryCodesFromTitle(q.title);

        return {
          url: parsedUrl,
          format: Format.mp4, // GDrive CDN serves MP4/MKV directly — Stremio plays both as mp4
          meta: {
            countryCodes,
            ...(height && { height }),
            title: `${title} (${q.quality || 'MP4'})`,
            sourceId: this.id,
            sourceLabel: this.label,
          },
        };
      } catch (e) {
        if (e instanceof TooManyRequestsError) this._noteRateLimit('sourceUrl');
        return null;
      }
    };

    // Resolve in parallel — Promise.all with bounded concurrency
    const resolved = await Promise.all(uniqueQualities.map(resolveOne));
    for (const r of resolved) {
      if (r) results.push(r);
    }

    return results;
  }
}
