// src/source/Source.js

import { CountryCode } from '../types.js';
import { NotFoundError } from '../error/index.js';

const DOMAINS_JSON_URL = 'https://raw.githubusercontent.com/Anshu78780/json/main/providers.json';
const DOMAINS_JSON_TTL = 4 * 60 * 60 * 1000;
const BASE_URL_CACHE_TTL = 4 * 60 * 60 * 1000;
const DEAD_DOMAIN_TTL = 24 * 60 * 60 * 1000;

const sourceResultCache = new Map();
const baseUrlCache = new Map();
const deadDomains = new Map();
let domainsJsonCache = null;
let domainsJsonTs = 0;

const firstFailureAt = new Map();
const FAILURE_EVICTION_WINDOW = 5 * 60 * 1000;
const evictionCallbacks = new Map();

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
    const cacheKey = `${this.id}_${id.id || id}`;
    const cached = sourceResultCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.ttl) {
      return cached.data;
    }

    let results;
    try {
      results = await this.handleInternal(ctx, type, id);
      Source.recordSuccess(this.domainKey);
    } catch (error) {
      if (error instanceof NotFoundError) {
        results = [];
      } else {
        Source.recordFailure(this.domainKey);
        throw error;
      }
    }

    sourceResultCache.set(cacheKey, { data: results, ts: Date.now() });
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
