// src/source/Source.js

import { CountryCode } from '../types.js';
import { NotFoundError } from '../error/index.js';

const DOMAINS_JSON_URL = 'https://raw.githubusercontent.com/Anshu78780/json/main/providers.json';
const DOMAINS_JSON_TTL = 4 * 60 * 60 * 1000;
const BASE_URL_CACHE_TTL = 4 * 60 * 60 * 1000;
const DEAD_DOMAIN_TTL = 24 * 60 * 60 * 1000;

const sourceResultCache = new Map();
// In-flight dedupe (Task 43): while the client-budget partial response keeps
// sources resolving in the BACKGROUND, a new request for the same title must
// NOT start a second identical scrape — on Render's 0.1 CPU the duplicate
// halves the throughput of BOTH and delays the cache warm-up. Concurrent
// callers share one promise; it is removed on completion so the 15s empty /
// 5min filled result-cache rules still apply on the next request.
const inflightHandles = new Map();
const baseUrlCache = new Map();
const deadDomains = new Map();
let domainsJsonCache = null;
let domainsJsonTs = 0;

const firstFailureAt = new Map();
const FAILURE_EVICTION_WINDOW = 5 * 60 * 1000;
const evictionCallbacks = new Map();

// Task 69: adaptive empty-result TTL. The fixed 15s empty TTL meant every
// source that honestly has nothing for a title (dead upstreams, wrong-content
// sources, NotFoundErrors) re-scraped on EVERY refresh — production-measured
// ~30 zero-yield sources × 10-35s of slot time per round, holding every
// response at the 40s budget and starving the sources that DO deliver.
// Ladder per (source,title) consecutive-empty streak: 15s (transient blip —
// retry fast once) → 60s (likely persistent) → 5min (honest zero; the source
// will not suddenly grow the title). Any non-empty result resets the streak,
// so recovery is immediate the moment a source starts delivering again.
const emptyStreaks = new Map();
const EMPTY_TTL_LADDER_MS = [15_000, 60_000, 300_000];

export class Source {
  constructor() {
    this.ttl = 43200000; // 12h
    this.priority = 0;
    this.useOnlyWithMaxUrlsFound = undefined;
    this.domainKey = '';
  }

  // Static accessors for shared state used by ported sources
  static get deadDomains() { return deadDomains; }
  static get DEAD_DOMAIN_TTL() { return DEAD_DOMAIN_TTL; }
  static get evictionCallbacks() { return evictionCallbacks; }

  static recordFailure(domainKey) {
    if (!domainKey) return;
    const now = Date.now();
    const first = firstFailureAt.get(domainKey);
    if (!first) {
      firstFailureAt.set(domainKey, now);
      return;
    }
    if (now - first >= FAILURE_EVICTION_WINDOW) {
      baseUrlCache.delete(domainKey);
      firstFailureAt.delete(domainKey);
      const evictedHost = evictionCallbacks.get(domainKey)?.();
      if (evictedHost) deadDomains.set(evictedHost, Date.now());
    }
  }

  static isFailing(domainKey) {
    return firstFailureAt.has(domainKey);
  }

  static recordSuccess(domainKey) {
    if (!domainKey) return;
    firstFailureAt.delete(domainKey);
  }

  async handle(ctx, type, id) {
    // Cache key must include season + episode so S1E1 and S2E1 don't collide
    const cacheKey = `${this.id}_${id.id || id}${id.season ? `_S${id.season}_E${id.episode || 1}` : ''}`;
    const cached = sourceResultCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < cached.ttl) {
      return cached.data;
    }

    // In-flight dedupe: share the running scrape instead of double-fetching
    const running = inflightHandles.get(cacheKey);
    if (running) return running;

    const promise = this._handleUncached(ctx, type, id, cacheKey).finally(() => {
      inflightHandles.delete(cacheKey);
    });
    inflightHandles.set(cacheKey, promise);
    return promise;
  }

  async _handleUncached(ctx, type, id, cacheKey) {
    // Aggressive eviction to prevent OOM on Render's 512MB free tier.
    // Each cached source result can hold 10+ stream objects with URLs,
    // metadata, and titles — 100 entries can use 50+MB.
    // Evict at 40 entries (was 100) and use shorter TTLs.
    if (sourceResultCache.size > 40) {
      const now = Date.now();
      for (const [key, val] of sourceResultCache) {
        if (now - val.ts > (val.ttl || 300000)) sourceResultCache.delete(key);
      }
    }

    let results;
    let failed = false;
    try {
      results = await this.handleInternal(ctx, type, id);
      Source.recordSuccess(this.domainKey);
    } catch (error) {
      if (error instanceof NotFoundError) {
        results = [];
      } else {
        Source.recordFailure(this.domainKey);
        // Task 69: failures now cache as an EMPTY result (flat 60s retry —
        // see the caching block below) instead of being rethrown uncached.
        // Previously a source that errored mid-chain under contention
        // (cinewave/uhdmovies class, production-measured re-scraping fresh
        // every round) re-ran on EVERY refresh, held a concurrency slot for
        // its full runtime, and kept rounds at the early-ship floor (~20s)
        // instead of settling into the fast all-cached path. A flat 60s —
        // deliberately SHORTER than the honest-zero ladder's 5min rung —
        // keeps flaky-but-valuable sources retrying once a minute while
        // still eliminating the per-refresh re-scrape storm. /debug/source
        // is unaffected (calls handleInternal directly, so real errors
        // still surface there).
        results = [];
        failed = true;
      }
    }

    // Cache empty results with a VERY short TTL (15s).
    // This prevents "cache poisoning" when a source transiently fails (e.g.
    // network blip, upstream timeout, rate-limit, CPU starvation under load).
    //
    // The previous 60s TTL was too long for Cinejoy — when the first request
    // after a cold start timed out (25s due to bundle parsing + handshake),
    // the empty result was cached for 60s, blocking all retries for a full
    // minute even though the scraper was now warm and could return streams
    // in 1-2s. With 15s, the user only needs to wait 15s for a retry.
    //
    // Non-empty results: 15min (Task 45, was 5min). Production evidence: the
    // user-visible "sources" window was limited to re-opens landing within
    // 5min of the first view — beyond that the per-source caches had expired
    // and the re-open went full-cold again (9-10 sources on Render 0.1 CPU),
    // even though stream definitions are stable far longer (direct file URLs,
    // ≥1h-signed tokens; tokened embeds re-resolve fresh per request anyway).
    // 15min triples the warm re-open window at ~negligible memory cost
    // (stream definitions are KB-scale; the >40-entry sweep still bounds the
    // map, and prewarm-relevant titles stay valid between 10min rotations).
    const isEmpty = !Array.isArray(results) || results.length === 0;
    // Task 69: adaptive empty TTL ladder (15s → 60s → 5min on consecutive
    // empty results for the same source+title; non-empty resets the streak).
    // Non-empty results: 15min cap — BUT a source may declare a SHORTER this.ttl
    // when its stream URLs die faster (AniKage 3min, the 5min token families,
    // MovieLinkBD ~5min CDN token rotation — Task 58). The hardcoded 15min
    // previously IGNORED this.ttl, so those sources served dead tokens from
    // cache for up to 15min (measured live: movielinkbd "FILE DELETED" 403s on
    // cards older than the rotation window). Math.min keeps every source with
    // ttl >= 15min exactly as before.
    let effectiveTtl;
    if (!isEmpty) {
      emptyStreaks.delete(cacheKey);
      effectiveTtl = Math.min(this.ttl || 15 * 60 * 1000, 15 * 60 * 1000);
    } else if (failed) {
      // Flat 60s error retry (see the catch block above) — no ladder climb,
      // no streak mutation, so the honest-zero ladder state is preserved
      // independently of transient failures.
      effectiveTtl = 60_000;
    } else {
      const streak = (emptyStreaks.get(cacheKey) || 0) + 1;
      emptyStreaks.set(cacheKey, streak);
      effectiveTtl = EMPTY_TTL_LADDER_MS[Math.min(streak - 1, EMPTY_TTL_LADDER_MS.length - 1)];
      // Bound the streak map (keys track sourceResultCache keys) — a full
      // reset just restarts the ladder at 15s, which is always safe.
      if (emptyStreaks.size > 2000) emptyStreaks.clear();
    }
    sourceResultCache.set(cacheKey, { data: results, ts: Date.now(), ttl: effectiveTtl });
    return results;
  }

  async probeBaseUrl(ctx, fetcher, domainKey, fallbackCandidates) {
    const envOverride = process.env[`${domainKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BASE_URL`];
    if (envOverride) return new URL(envOverride);

    const cached = baseUrlCache.get(domainKey);
    if (cached && Date.now() - cached.ts < BASE_URL_CACHE_TTL) return new URL(cached.url);

    // Try domains.json
    if (!domainsJsonCache || Date.now() - domainsJsonTs > DOMAINS_JSON_TTL) {
      try {
        domainsJsonCache = await fetcher.json(ctx, new URL(DOMAINS_JSON_URL));
        domainsJsonTs = Date.now();
      } catch { /* use cache or fallback */ }
    }

    if (domainsJsonCache) {
      const entry = domainsJsonCache[domainKey];
      const domainUrl = typeof entry === 'string' ? entry : entry?.url;
      if (domainUrl) {
        try {
          const hostname = new URL(domainUrl).hostname;
          const diedAt = deadDomains.get(hostname);
          const isDead = diedAt && Date.now() - diedAt < DEAD_DOMAIN_TTL;
          if (!isDead && await this.isDomainAlive(ctx, fetcher, domainUrl)) {
            baseUrlCache.set(domainKey, { url: domainUrl, ts: Date.now() });
            return new URL(domainUrl);
          }
        } catch { /* invalid URL */ }
      }
    }

    // Race fallback candidates
    try {
      const alive = fallbackCandidates.filter(c => {
        try {
          const hostname = new URL(c).hostname;
          const diedAt = deadDomains.get(hostname);
          if (diedAt && Date.now() - diedAt < DEAD_DOMAIN_TTL) return false;
          return true;
        } catch { return false; }
      });

      const candidates = alive.length > 0 ? alive : fallbackCandidates;
      const winner = await Promise.any(
        candidates.map(async (c) => {
          if (await this.isDomainAlive(ctx, fetcher, c)) return c;
          throw new Error('unreachable');
        })
      );

      const url = new URL(winner);
      baseUrlCache.set(domainKey, { url: url.href, ts: Date.now() });
      return url;
    } catch {
      for (const c of fallbackCandidates) {
        try { deadDomains.set(new URL(c).hostname, Date.now()); } catch {}
      }
      throw new NotFoundError();
    }
  }

  async isDomainAlive(ctx, fetcher, candidate) {
    try {
      await fetcher.head(ctx, new URL(candidate), { timeout: 4000 });
      return true;
    } catch (error) {
      if (error instanceof BlockedError) return true;
      if (error instanceof NotFoundError) return true;
      if (error instanceof HttpError) return true;
      if (error instanceof TooManyRequestsError) return true;
      if (error instanceof TooManyTimeoutsError) return true;
      return false;
    }
  }
}

// Import here to avoid circular deps
import { BlockedError, HttpError, TooManyRequestsError, TooManyTimeoutsError } from '../error/index.js';
