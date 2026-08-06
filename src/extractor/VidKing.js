// src/extractor/VidKing.js
// Vidking.net embed URL → direct video URLs via api.speedracelight.com
//
// The vidking.net embed page (https://www.vidking.net/embed/movie/{tmdbId}) is a
// React SPA that fetches its streams from a backend API at api.speedracelight.com.
// That API encrypts its responses with a per-media seed + XOR keystream.
// We replicate the flow here:
//   1. Parse the embed URL to get tmdbId (and season/episode for TV)
//   2. Look up title/year/imdb_id via our TMDB utility
//   3. Fetch the seed from /seed?mediaId={tmdbId}
//   4. Hit each provider endpoint (/cdn/sources-with-title, /vsrc/sources-with-title, ...)
//   5. Decrypt each response and parse out { sources: [{ url, quality }] }
//   6. Return each playable URL as a separate stream result

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

// Parse embed URL → { type, tmdbId, season, episode }
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
  }

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
    const parsed = parseEmbedUrl(url);
    if (!parsed) return [];

    // Build a TmdbId for our utility functions
    const tmdbIdObj = {
      id: parsed.tmdbId,
      ...(parsed.season && { season: parsed.season, episode: parsed.episode }),
    };

    // Prefer metadata pre-resolved by the VidKing source (saves a duplicate
    // TMDB round-trip). Fall back to our own lookup if missing.
    const preloaded = meta?.vidking;
    let meta2;
    if (preloaded?.name && preloaded?.year) {
      meta2 = { title: preloaded.name, year: preloaded.year, imdbId: preloaded.imdbId };
    } else {
      try {
        const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbIdObj);
        let imdbId;
        try {
          const imdb = await getImdbId(this.fetcher, ctx, tmdbIdObj);
          imdbId = imdb.id;
        } catch { /* imdb lookup is best-effort */ }
        meta2 = { title: name, year, imdbId };
      } catch (e) {
        this.logger?.warn?.(`VidKing: failed to look up TMDB metadata for ${parsed.tmdbId}: ${e.message}`);
        return [];
      }
    }

    // Fetch all providers in parallel
    const results = await fetchAllProviders(this.fetcher, ctx, {
      meta: meta2,
      type: parsed.type,
      tmdbId: parsed.tmdbId,
      seasonId: parsed.season,
      episodeId: parsed.episode,
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

        const titleBits = [];
        if (meta2.title) titleBits.push(meta2.title);
        if (parsed.season) titleBits.push(TmdbId.formatSeasonAndEpisode(tmdbIdObj));
        if (source.quality) titleBits.push(source.quality);
        const streamTitle = titleBits.join(' — ');

        streams.push({
          url: streamUrl,
          format,
          label: `${provider.name}`,
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
      this.logger?.info?.(`VidKing: no playable sources from any provider for tmdb=${parsed.tmdbId}`);
    } else {
      this.logger?.info?.(`VidKing: ${streams.length} streams for tmdb=${parsed.tmdbId}`);
    }
    return streams;
  }
}
