// src/extractor/ExtractorRegistry.js

import { Format } from '../types.js';

export class ExtractorRegistry {
  constructor(logger, extractors) {
    this.logger = logger;
    this.extractors = extractors;
    this.urlResultCache = new Map();
    this.lazyUrlResultCache = new Map();
    this.inFlight = new Map();
  }

  async handle(ctx, url, meta = {}, allowLazy = false) {
    let extractor = this.extractors.find(e => e.supports(ctx, url));

    // Fallback: if no URL-matched extractor but meta.vidking is present
    // (with a TMDB ID), route to the VidKing extractor. This lets sources
    // whose embed URLs have no dedicated extractor still produce playable
    // streams via speedracelight's TMDB-based API.
    if (!extractor && meta?.vidking?.tmdbId) {
      extractor = this.extractors.find(e => e.id === 'vidking');
    }

    if (!extractor) return [];

    const normalizedUrl = extractor.normalize(url);
    const canonicalUrl = await extractor.normalizeAsync(ctx, normalizedUrl);
    const cacheKey = `${extractor.id}_${canonicalUrl.href}${extractor.cacheVersion ? `_${extractor.cacheVersion}` : ''}`;

    // Check cache
    const cached = this.urlResultCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < cached.ttl) {
      return cached.results;
    }

    // Check in-flight
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const extractionPromise = (async () => {
      this.logger.info(`Extract ${url.href} using ${extractor.id}`);
      const results = await extractor.extract(ctx, normalizedUrl, { extractorId: extractor.id, ...meta });

      const successResults = results.filter(r => !r.error);
      if (successResults.length > 0) {
        const minTtl = Math.min(...successResults.map(r => r.ttl));
        this.urlResultCache.set(cacheKey, { results: successResults, ts: Date.now(), ttl: minTtl });
        // Lazy cache for 24h
        this.lazyUrlResultCache.set(canonicalUrl.href, { results: successResults, ts: Date.now() });
      }

      return results;
    })();

    this.inFlight.set(cacheKey, extractionPromise);
    try {
      return await extractionPromise;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  buildExtractUrls(ctx, urlResults, canonicalUrl) {
    return urlResults.map((urlResult, index) => {
      const extractUrl = new URL(`/extract/`, ctx.hostUrl);
      extractUrl.searchParams.set('index', `${index}`);
      extractUrl.searchParams.set('url', canonicalUrl.href);
      return { ...urlResult, url: extractUrl };
    });
  }
}
