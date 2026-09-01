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
    // Find ALL matching extractors (not just the first one) — if the first
    // extractor returns 0 results, we fall through to the next one.
    // This lets the EmbedResolver (generic fallback) handle URLs that
    // dedicated extractors (Voe, Mixdrop, VidSrc) fail to resolve.
    const matchingExtractors = this.extractors.filter(e => e.supports(ctx, url, meta));
    let extractor = matchingExtractors[0];

    // Fallback: if no URL-matched extractor but meta.vidking is present
    // (with a TMDB ID), route to the VidKing extractor.
    if (!extractor && meta?.vidking?.tmdbId) {
      extractor = this.extractors.find(e => e.id === 'vidking');
      matchingExtractors.push(extractor);
    }

    // Also add VidKing as a fallback when meta.vidking IS present and
    // the matching extractors don't include it. This handles cases where
    // EmbedResolver matches but returns 0 (JS-rendered pages) — VidKing
    // uses the speedracelight API (TMDB-based) which doesn't need JS.
    if (meta?.vidking?.tmdbId && !matchingExtractors.some(e => e.id === 'vidking')) {
      const vidkingExt = this.extractors.find(e => e.id === 'vidking');
      if (vidkingExt) matchingExtractors.push(vidkingExt);
    }

    if (!extractor) return [];

    const normalizedUrl = extractor.normalize(url);
    const canonicalUrl = await extractor.normalizeAsync(ctx, normalizedUrl);
    const cacheKey = `${extractor.id}_${canonicalUrl.href}${extractor.cacheVersion ? `_${extractor.cacheVersion}` : ''}${meta?.sourceId ? `__${meta.sourceId}` : ''}`;

    // Check cache
    const cached = this.urlResultCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < cached.ttl) {
      return cached.results;
    }

    // Aggressive eviction to prevent OOM on Render's 512MB free tier.
    // Each cached extraction result holds URL objects + metadata — 200
    // entries can use 30+MB. Evict at 80 entries (was 200).
    if (this.urlResultCache.size > 80) {
      const now = Date.now();
      for (const [key, val] of this.urlResultCache) {
        if (now - val.ts > (val.ttl || 300000)) this.urlResultCache.delete(key);
      }
      this.lazyUrlResultCache.clear(); // Clear lazy cache too
    }

    // Check in-flight
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const extractionPromise = (async () => {
      // Try the first matching extractor
      this.logger.info(`Extract ${url.href} using ${extractor.id}`);
      let results = await extractor.extract(ctx, normalizedUrl, { extractorId: extractor.id, ...meta });
      let successResults = results.filter(r => !r.error);

      // If the first extractor returned 0 results, try the next matching
      // extractors (EmbedResolver fallback). This handles cases where the
      // dedicated extractor (Voe, Mixdrop, VidSrc) can't resolve the URL
      // because the page structure has changed.
      if (successResults.length === 0 && matchingExtractors.length > 1) {
        for (let i = 1; i < matchingExtractors.length; i++) {
          const nextExt = matchingExtractors[i];
          this.logger.info(`Fallback: trying ${nextExt.id} for ${url.href}`);
          try {
            const nextResults = await nextExt.extract(ctx, normalizedUrl, { extractorId: nextExt.id, ...meta });
            const nextSuccess = nextResults.filter(r => !r.error);
            if (nextSuccess.length > 0) {
              results = nextResults;
              successResults = nextSuccess;
              break;
            }
          } catch (e) {
            // Continue to next extractor
          }
        }
      }

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
