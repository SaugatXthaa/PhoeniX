// src/extractor/VidKing.js
// Vidking.net embed URL → direct video URLs via api.speedracelight.com
//
// The vidking.net embed page (https://www.vidking.net/embed/movie/{tmdbId}) is a
// React SPA that fetches its streams from a backend API at api.speedracelight.com.
// That API encrypts its responses with a per-media seed + XOR keystream.
//
// We replicate the flow here:
//   1. Determine the TMDB ID (and season/episode for TV) — from meta.vidking
//      (preferred, passed by the source) or by parsing the vidking.net embed URL
//   2. Look up title/year/imdb_id via our TMDB utility (or use preloaded values)
//   3. Fetch the seed from /seed?mediaId={tmdbId}
//   4. Hit each provider endpoint (/cdn/sources-with-title, /vsrc/sources-with-title, ...)
//   5. Decrypt each response and parse out { sources: [{ url, quality }] }
//   6. Return each playable URL as a separate stream result
//
// IMPORTANT: This extractor also serves as a FALLBACK for sources whose embed
// URLs have no dedicated extractor. When `meta.vidking` is present (with at
// least `tmdbId`), the ExtractorRegistry routes the URL here regardless of the
// URL's host. This lets sources like CineWave, PrimeShows, Kokoshka, etc.
// produce playable streams from speedracelight's API even though their own
// embed URLs can't be parsed server-side.

import { CountryCode, Format } from '../types.js';
import { NotFoundError } from '../error/index.js';
import { getImdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { fetchAllProviders, PROVIDERS } from '../utils/speedracelight.js';
import { Extractor } from './Extractor.js';

const VIDKING_HOST_PATTERN = /vidking\.net$/;

// Quality label → height (e.g. "1080p" → 1080, "2160p" → 2160)
function parseHeight(quality) {
  if (!quality) return undefined;
  const m = String(quality).match(/(\d{3,4})p?/i);
  return m ? parseInt(m[1]) : undefined;
}

// Quality label → countryCodes (e.g. "Hindi" → ['hi'], "English" → ['en'], "German" → ['de'])
function countryCodesFromQuality(quality) {
  if (!quality) return [];
  const q = String(quality).toLowerCase();
  const codes = [];
  if (q.includes('hindi') || q.includes('hin')) codes.push(CountryCode.hi);
  if (q.includes('english') || q.includes('eng')) codes.push(CountryCode.en);
  if (q.includes('german') || q.includes('deu') || q.includes('deutsch')) codes.push(CountryCode.de);
  if (q.includes('tamil') || q.includes('tam')) codes.push(CountryCode.ta);
  if (q.includes('telugu') || q.includes('tel')) codes.push(CountryCode.te);
  return codes;
}

// Infer stream format from URL
function formatFromUrl(url) {
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.mp4') || path.endsWith('.mkv')) return Format.mp4;
  if (path.endsWith('.m3u8') || path.includes('.m3u8')) return Format.hls;
  if (path.endsWith('.mpd') || path.includes('.mpd')) return Format.hls; // DASH — Stremio can handle via m3u8-style
  return Format.unknown;
}

// Parse vidking.net embed URL → { type, tmdbId, season, episode }
//   /embed/movie/{tmdbId}
//   /embed/tv/{tmdbId}/{season}/{episode}
function parseEmbedUrl(url) {
  const m = url.pathname.match(/^\/embed\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?/);
  if (!m) return null;
  return {
    type: m[1] === 'tv' ? 'tv' : 'movie',
    tmdbId: parseInt(m[2]),
    season: m[3] ? parseInt(m[3]) : undefined,
    episode: m[4] ? parseInt(m[4]) : undefined,
  };
}

export class VidKing extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'vidking';
    this.label = 'VidKing';
    this.ttl = 900_000; // 15min — streams are short-lived (seed TTL ~30s, but Stremio caches the resolved URL)
    this.cacheVersion = 1;
    // Per-tmdbId result cache + in-flight dedup. When CineWave returns 16 embed
    // URLs for the same tmdbId, only the first call hits the speedracelight API;
    // the other 15 return cached results. Without this, 16 parallel calls × 9
    // providers = 144 API hits → rate-limited → all fail.
    this.tmdbCache = new Map();      // key: `${tmdbId}_${season}_${episode}` → { streams, ts }
    this.tmdbInFlight = new Map();   // key → Promise
    this.TMDB_CACHE_TTL = 8 * 60 * 1000; // 8 min (speedracelight seed TTL is ~30s, but resolved stream URLs live longer)
  }

  // Only matches vidking.net embed URLs directly. For other URLs, the
  // ExtractorRegistry routes here via the meta.vidking fallback.
  supports(_ctx, url) {
    return VIDKING_HOST_PATTERN.test(url.hostname) && /\/embed\/(movie|tv)\//.test(url.pathname);
  }

  normalize(url) {
    // Strip query params — embed URL is canonical without them
    const canonical = new URL(url);
    canonical.search = '';
    return canonical;
  }

  async extractInternal(ctx, url, meta) {
    // Determine TMDB ID / type / season / episode.
    // Priority: meta.vidking (passed by source) > parseEmbedUrl (vidking.net URL)
    const preloaded = meta?.vidking;
    let type, tmdbId, season, episode;

    if (preloaded?.tmdbId) {
      type = preloaded.season ? 'tv' : 'movie';
      tmdbId = preloaded.tmdbId;
      season = preloaded.season;
      episode = preloaded.episode;
    } else {
      const parsed = parseEmbedUrl(url);
      if (!parsed) return [];
      type = parsed.type;
      tmdbId = parsed.tmdbId;
      season = parsed.season;
      episode = parsed.episode;
    }

    // Cache key by tmdbId + season + episode — NOT by URL.
    // Multiple embed URLs for the same tmdbId (CineWave's 16 sources, PrimeShows' 6 servers)
    // all resolve to the same speedracelight API call, so we dedupe here.
    const cacheKey = `${tmdbId}_${season ?? 0}_${episode ?? 0}`;

    // Return cached result if fresh
    const cached = this.tmdbCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.TMDB_CACHE_TTL) {
      this.logger?.info?.(`VidKing: cache hit for tmdb=${tmdbId} (${cached.streams.length} streams)`);
      return cached.streams;
    }

    // Dedupe in-flight calls — if another call for the same tmdbId is already
    // running, wait for it instead of firing a duplicate API request.
    const existing = this.tmdbInFlight.get(cacheKey);
    if (existing) {
      this.logger?.info?.(`VidKing: deduping in-flight call for tmdb=${tmdbId}`);
      return existing;
    }

    const promise = this._extractUncached(ctx, url, meta, preloaded, type, tmdbId, season, episode);
    this.tmdbInFlight.set(cacheKey, promise);

    try {
      const streams = await promise;
      // Only cache NON-EMPTY results. Empty results (429, timeout, no sources)
      // must NOT be cached — otherwise the first failure blocks all 16 CineWave
      // embed URLs from retrying for 8 minutes. A short retry cooldown (10s)
      // prevents hammering the API when it's down.
      if (streams.length > 0) {
        this.tmdbCache.set(cacheKey, { streams, ts: Date.now() });
      } else {
        // Short negative cache — prevents 16 simultaneous calls from all
        // hitting the API, but allows the next user request to retry.
        this.tmdbCache.set(cacheKey, { streams, ts: Date.now() - this.TMDB_CACHE_TTL + 10_000 });
      }
      return streams;
    } finally {
      this.tmdbInFlight.delete(cacheKey);
    }
  }

  async _extractUncached(ctx, url, meta, preloaded, type, tmdbId, season, episode) {
    // Build a TmdbId object for our utility functions
    const tmdbIdObj = {
      id: tmdbId,
      ...(season && { season, episode }),
    };

    // Resolve title/year/imdb_id (needed by the speedracelight API).
    // Prefer preloaded values from the source to avoid a duplicate TMDB call.
    // Use preloaded.name whenever available — year may be missing for some
    // anime/TV titles, but the name is what matters for display + API matching.
    let meta2;
    if (preloaded?.name) {
      meta2 = {
        title: preloaded.name,
        ...(preloaded.year && { year: preloaded.year }),
        ...(preloaded.imdbId && { imdbId: preloaded.imdbId }),
      };
    } else {
      try {
        const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbIdObj);
        let imdbId;
        try {
          const imdb = await getImdbId(this.fetcher, ctx, tmdbIdObj);
          imdbId = imdb.id;
        } catch { /* imdb lookup is best-effort */ }
        meta2 = { title: name, ...(year && { year }), imdbId };
      } catch (e) {
        this.logger?.warn?.(`VidKing: failed to look up TMDB metadata for ${tmdbId}: ${e.message}`);
        return [];
      }
    }

    // Fetch all providers in parallel
    const results = await fetchAllProviders(this.fetcher, ctx, {
      meta: meta2,
      type,
      tmdbId,
      seasonId: season,
      episodeId: episode,
    });

    // Build stream results — one per (provider, source)
    const streams = [];
    const seenUrls = new Set();

    for (const { provider, json } of results) {
      if (!json || !Array.isArray(json.sources)) continue;

      // Some providers (Vyse, Fade) carry a qualityFilter — keep only matching sources
      const filtered = provider.qualityFilter
        ? json.sources.filter(s => String(s.quality).toLowerCase().includes(provider.qualityFilter.toLowerCase()))
        : json.sources;

      for (const source of filtered) {
        if (!source?.url) continue;
        let streamUrl;
        try {
          streamUrl = new URL(source.url);
        } catch { continue; }
        if (seenUrls.has(streamUrl.href)) continue;
        seenUrls.add(streamUrl.href);

        const height = parseHeight(source.quality) ?? meta.height;
        const providerCountries = provider.countryCodes || ['multi'];
        const qualityCountries = countryCodesFromQuality(source.quality);
        const metaCountries = meta.countryCodes || [];
        const countryCodes = [...new Set([...providerCountries, ...qualityCountries, ...metaCountries])];

        const format = formatFromUrl(streamUrl);

        // Some speedracelight CDNs (ironwallnet.net, vimeos.net, etc.) return
        // 403 without a Referer. Add the vidking.net Referer so Stremio's proxy
        // injects it. Hosts like rivermagnet.site work without Referer, but
        // adding it doesn't break them — so we add it for all streams.
        const requestHeaders = { Referer: 'https://www.vidking.net/' };

        const titleBits = [];
        if (meta2.title) titleBits.push(meta2.title);
        if (season) titleBits.push(TmdbId.formatSeasonAndEpisode(tmdbIdObj));
        if (source.quality) titleBits.push(source.quality);
        const streamTitle = titleBits.join(' — ');

        streams.push({
          url: streamUrl,
          format,
          label: `${provider.name}`,
          requestHeaders,
          meta: {
            ...meta,
            ...meta2,
            countryCodes,
            ...(height && { height }),
            title: streamTitle,
            extractorId: `vidking_${provider.name.toLowerCase()}`,
            sourceId: meta.sourceId || 'vidking',
            sourceLabel: meta.sourceLabel || 'VidKing',
          },
          ...(source.type === 'dash' && { notWebReady: true }),
        });
      }
    }

    if (streams.length === 0) {
      this.logger?.info?.(`VidKing: no playable sources from any provider for tmdb=${tmdbId}`);
    } else {
      this.logger?.info?.(`VidKing: ${streams.length} streams for tmdb=${tmdbId}`);
    }
    return streams;
  }
}
