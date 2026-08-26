// src/source/Movy.js
// movy.bz / vidy.st — movies/series/anime via 12 city servers
//
// Uses the Nuvio provider (src/nuvio/movy.cjs) which implements the
// "streamcrypto" protocol from vidy.st's JS bundle (module 1549).
// The scraper:
//   - Fetches from 12 city servers (Miami, Boston, Seattle, Denver, Austin,
//     Chicago, Dallas, Munich, Berlin, Paris, Delhi, Cancun)
//   - Uses got-scraping for CF TLS fingerprint bypass + curl fallback
//   - Decrypts encrypted responses using the original bundle's decrypt module
//   - Returns HLS playlists + direct file URLs from moon.peakstorm.top CDN
//
// Not all 12 servers work — some return 401 (expired auth) or 500 (server
// error). The 3-4 working servers (miami, delhi, cancun) return real playable
// streams with 1080p/720p/480p quality.
//
// Stream URLs:
//   - moon.peakstorm.top/vd/.../index-sNNNNp-vN.m3u8 (HLS — multi-quality)
//   - Direct file URLs (MP4/MKV)
// No Referer needed for playback.

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'movy.cjs');

// Enrich stream titles with metadata markers that StreamResolver.enrichMeta
// parses for display — same format as 4KHDHub and Cinejoy.
//
// The scraper returns titles like: "The Dark Knight (2008) [miami]"
// We enrich them to: "The Dark Knight (2008) [miami] 1080p WEB-DL x264 English"
// so enrichMeta can parse: quality, sourceType, codec, audio.
function enrichStreamTitles(streams, title) {
  if (!Array.isArray(streams)) return streams;

  return streams.map(s => {
    if (!s || !s.url) return s;

    const quality = s.quality || '';
    const markers = [];

    // Quality marker (2160p, 1080p, 720p, 480p)
    if (quality) markers.push(quality);

    // Source type — all Movy streams are streaming rips (WebDL)
    // moon.peakstorm.top is a streaming CDN (same as Cineby/Videasy)
    markers.push('WEB-DL');

    // Codec — 4K uses HEVC, others typically x264
    if (quality === '2160p' || quality === '4K') {
      markers.push('HEVC');
    } else {
      markers.push('x264');
    }

    // Audio — Movy streams are English
    markers.push('English');

    // Build the enriched title
    const baseTitle = s.title || title;
    const enrichedTitle = baseTitle + ' ' + markers.join(' ');

    return {
      ...s,
      title: enrichedTitle,
      name: s.name || 'Movy',
    };
  });
}

export class Movy extends Source {
  constructor(fetcher) {
    super();
    this.id = 'movy';
    this.label = 'Movy';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://www.movy.bz';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType,
      season: tmdbId.season || null,
      episode: tmdbId.episode || null,
      timeoutMs: 28000, // 28s — scraper queries 12 servers sequentially with 500ms delay
    });

    // Enrich stream titles with metadata markers before buildStreamResults
    const enrichedStreams = enrichStreamTitles(streams, title);

    return buildStreamResults({
      streams: enrichedStreams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });
  }
}
