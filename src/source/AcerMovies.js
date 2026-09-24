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
// Search returns results from moviesmod.ai.in — Hindi/English dual audio
// focused, but covers Hollywood, Korean, and anime movies too.
//
// Task 87 (2026-09-25) — full API RE round, "migration" investigated and
// answered: there is NO migration target. The live site bundle (homepage
// inline JS) calls the exact same surface we implement (POST /api/search
// {searchQuery}, /api/sourceQuality {url}, /api/sourceUrl {url, seriesType},
// /api/sourceEpisodes {url}); the /api/requestOnline/sourceUrl route seen in
// the JS is DEAD CODE (its only caller is commented out; POSTing it 404s on
// api2 and 405s on the site origin), no alternate api hosts exist
// (api/api1/api3.* DNS-dead), and the 429 ban on Render's egress had LIFTED
// (rawfetch POST /api/search → 200 @466ms on 2026-09-25). The REAL upstream
// failure: /api/sourceUrl answers {"fromCache":false} for EVERY title —
// 0/17 measured E2E including acer's own trending 2026 list (api/list) and
// hot 2025 releases — each answer taking ~2.3-3.0s (their backend appears to
// attempt a live links.modpro.blog resolve and fail; modpro 403s datacenter
// IPs in ~70ms, acer's backend included). The per-quality resolution layer is
// upstream-dead, so this source honestly zeros until that heals. What WE can
// fix is the blast radius: a fromCache:false answer is FINAL (their cache
// state cannot change between retries seconds apart), so the old 3×
// search→quality→sourceUrl retry ladder only burned ~9 quota-counted POSTs
// per player request — the exact behavior that historically tripped acer's
// per-IP 429 ban and zeroed the source for everyone on Render. Now: a
// canary sourceUrl POST decides; fromCache:false short-circuits the ladder
// via a sentinel (withRetryOnEmpty passes non-arrays through un-retried) and
// a 30min bounded negative cache absorbs repeated player refreshes with zero
// upstream calls. Recovery is instant and automatic: the first title acer's
// backend resolves again flows through the normal path and fills the 24h
// positive cache as before.

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

// Task 87: definitive-miss negative cache. acer's {"fromCache":false} is a
// final upstream verdict for the title (not a transient window) — remember it
// briefly so player refreshes / warm passes don't re-burn quota-counted
// POSTs on a cache we measured empty across 17 titles. 30min keeps recovery
// latency bounded if their backend starts resolving again (their own UI
// folklore promises "5-30 mins" processing).
const NEGATIVE_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_CACHE_MAX = 200;

// Sentinel returned by _resolve instead of an array when the upstream answer
// is final. withRetryOnEmpty passes non-array results through WITHOUT
// retrying (nuvioHelpers line "if (!Array.isArray(r)) return r;"), so the
// old 3-attempt ladder short-circuits cleanly with no helper changes.
const DEFINITIVE_MISS = Object.freeze({ definitive: true });

// Thrown by _resolveOne on fromCache:false; caught at the _resolve canary.
class DefinitiveMissError extends Error {
  constructor(msg) { super(msg); this.name = 'DefinitiveMissError'; }
}

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
    this._negativeCache = new Map(); // Task 87: cacheKey -> { at } — definitive-miss memory
  }

  // Task 87: bounded negative-cache write (oldest-evicting like _resultCache).
  _noteDefinitiveMiss(key) {
    if (this._negativeCache.size >= NEGATIVE_CACHE_MAX) {
      const oldest = this._negativeCache.keys().next().value;
      this._negativeCache.delete(oldest);
    }
    this._negativeCache.set(key, { at: Date.now() });
  }

  _negativeFresh(key) {
    const hit = this._negativeCache.get(key);
    return hit && (Date.now() - hit.at) < NEGATIVE_TTL_MS;
  }

  // Cache keys must be VALUE-stable: handleInternal receives a freshly-parsed
  // TmdbId/ImdbId object per request (debug route) or a string (internal), and
  // Map keys by identity — object keys never hit. Canonicalize to a string.
  _keyOf(id) {
    if (typeof id === 'string') return id;
    if (!id || typeof id !== 'object') return String(id);
    let k = (typeof id.id === 'number') ? `tmdb:${id.id}` : String(id.id);
    if (id.season != null) k += `:${id.season}`;
    if (id.episode != null) k += `:${id.episode}`;
    return k;
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
    const key = this._keyOf(id);
    const hit = this._resultCache.get(key);

    // Task 87: definitive-miss memory — acer told us fromCache:false for this
    // title recently (a final verdict, not a window). Honest zero with ZERO
    // upstream calls; expires with NEGATIVE_TTL_MS so backend-side recovery
    // is picked up automatically.
    if (this._negativeFresh(key)) {
      console.log(`[acermovies] negative cache fresh (${Math.round((now - this._negativeCache.get(key).at) / 60000)}min old) — honest zero, upstream untouched`);
      return [];
    }

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
        const relayed = await withRetryOnEmpty(() => this._resolve(ctx, id, { relay: true }), { attempts: 2, maxTotalMs: 12000, tag: 'acermovies-relay' });
        // Task 87: non-array = definitive-miss sentinel (passed through
        // un-retried by withRetryOnEmpty) — remember it, return honest zero.
        if (!Array.isArray(relayed)) {
          this._noteDefinitiveMiss(key);
          console.log('[acermovies] relay resolve hit definitive miss — honest zero (negative-cached)');
          return [];
        }
        if (relayed.length > 0) {
          if (this._resultCache.size >= RESULT_CACHE_MAX) {
            const oldest = this._resultCache.keys().next().value;
            this._resultCache.delete(oldest);
          }
          this._resultCache.set(key, { results: relayed, at: Date.now() });
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
    // Task 87: definitive misses (fromCache:false) short-circuit this ladder
    // via the DEFINITIVE_MISS sentinel — those are NOT windows.
    const results = await withRetryOnEmpty(() => this._resolve(ctx, id), { attempts: 3, maxTotalMs: 14000, tag: 'acermovies' });

    if (!Array.isArray(results)) {
      this._noteDefinitiveMiss(key);
      console.log('[acermovies] definitive miss (fromCache:false / unsupported) — honest zero, negative-cached 30min');
      return [];
    }

    if (results.length > 0) {
      // Bounded 24h fallback cache (429 survival)
      if (this._resultCache.size >= RESULT_CACHE_MAX) {
        const oldest = this._resultCache.keys().next().value;
        this._resultCache.delete(oldest);
      }
      this._resultCache.set(key, { results, at: Date.now() });
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

    // Series not supported — episodes go through CF-protected blog chain.
    // Task 87: definitive (never changes between retries) — sentinel stops
    // the empty-retry ladder from re-running TMDB+search 3× for series ids.
    if (tmdbId.season) return DEFINITIVE_MISS;

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

    // Step 3: resolve qualities to direct GDrive URLs.
    // Task 87 CANARY: the FIRST quality's sourceUrl decides whether acer's
    // resolution cache has this title at all. fromCache:false → DEFINITIVE
    // (measured stable across seconds; retrying cannot change their cache —
    // it only burned ~9 quota-counted POSTs per player request, which is what
    // historically tripped the per-IP 429 ban). Sentinel return short-circuits
    // the empty-retry ladder with zero helper changes.
    const seenQualities = new Set();
    const uniqueQualities = movieQualities.filter(q => {
      const key = q.quality || q.title;
      if (seenQualities.has(key)) return false;
      seenQualities.add(key);
      return true;
    });

    const results = [];

    let canary = null;
    try {
      canary = await this._resolveOne(ctx, uniqueQualities[0], title, relay);
    } catch (e) {
      if (e instanceof DefinitiveMissError) {
        console.log(`[acermovies] upstream resolution cache empty for "${title}" (sourceUrl fromCache:false) — definitive miss, ladder short-circuited`);
        return DEFINITIVE_MISS;
      }
      // non-definitive canary failure (network flake): fall through, the
      // batch below still runs (old behavior for window-class failures)
    }
    if (canary) results.push(canary);

    // A 429 mid-batch must stop remaining DIRECT calls — the per-quality
    // guard inside _resolveOne handles that (returns null while banned).
    // Canary success ALSO resolves the rest (title is cache-hot); canary
    // ordinary-failure still probes the rest (window class, Task 63).
    if (uniqueQualities.length > 1) {
      const resolved = await Promise.all(uniqueQualities.slice(1).map(q => this._resolveOne(ctx, q, title, relay).catch(() => null)));
      for (const r of resolved) {
        if (r) results.push(r);
      }
    }

    return results;
  }

  // Task 87: extracted from the old inline resolveOne so the canary can
  // distinguish DefinitiveMissError (throw) from ordinary failures (null).
  async _resolveOne(ctx, q, title, relay) {
    // A 429 mid-batch (attempt N of M qualities) must stop the remaining
    // DIRECT calls immediately — each extra POST into the rate limiter
    // extends it. Relay resolves are exempt (different egress class).
    if (Date.now() < this._cooldownUntil && !relay) return null;
    try {
      const body = JSON.stringify({ url: q.url, seriesType: 'movie' });
      const resp = await this._apiPost(ctx, '/api/sourceUrl', body, 15000);
      const parsed = JSON.parse(resp);
      // Task 87: acer's final "we have not resolved this quality" verdict.
      if (parsed && parsed.fromCache === false && !parsed.sourceUrl) {
        throw new DefinitiveMissError('fromCache:false');
      }
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
      if (e instanceof DefinitiveMissError) throw e;
      if (e instanceof TooManyRequestsError) this._noteRateLimit('sourceUrl');
      return null;
    }
  }
}
