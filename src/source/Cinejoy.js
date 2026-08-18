// src/source/Cinejoy.js
// cinejoy — movies/series via direct Noise protocol to api.shegu.st
//
// Uses the Nuvio provider (src/nuvio/cinejoy.cjs) which implements the
// lumen-gate-v2 protocol with embedded crush.wasm. Returns HLS m3u8 and
// direct file URLs from 6 servers:
//   Lisbon (4K HDR HEVC), Solara (multi-quality direct CDN),
//   Athens/Castle (synthetic HLS), Joy, Sakura, Canaias
//
// Enriches stream titles with metadata markers (quality, sourceType, codec,
// HDR, audio) that StreamResolver.enrichMeta parses for display — same
// format as 4KHDHub.
//
// Stream URLs from:
//   - info.movieboxnoob.cc/playlist/*.m3u8 (Lisbon — HLS)
//   - lol.movieboxnoob.cc/content?v=... (Solara — direct file CDN)
//   - api.shegu.st/synthetic/*/master.m3u8 (Athens/Castle — synthetic HLS)
// No Referer needed for playback.

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'cinejoy.cjs');

// Enrich the scraper's stream titles with metadata markers that
// StreamResolver.enrichMeta() parses for display.
//
// The scraper returns titles like:
//   "The Dark Knight (2008) [Lisbon server]"
//   "The Dark Knight (2008) [Solara 1080]"
//
// We enrich them to:
//   "The Dark Knight (2008) [Lisbon server] 2160p WEB-DL HEVC HDR English"
//   "The Dark Knight (2008) [Solara server] 1080p WEB-DL English"
//
// enrichMeta then parses: quality (2160p), sourceType (WebDL), codec (HEVC),
// HDR (HDR), audio (English) — same format as 4KHDHub.
function enrichStreamTitles(streams, title) {
  if (!Array.isArray(streams)) return streams;

  return streams.map(s => {
    if (!s || !s.url) return s;

    // Parse the server name from the scraper's title: "[Lisbon server]"
    // or "[Solara 1080]" etc.
    const serverMatch = (s.title || '').match(/\[([^\]]+)\s+server/i);
    const serverName = serverMatch ? serverMatch[1].trim() : '';
    const quality = s.quality || '';

    // Build metadata markers based on server + quality
    // Lisbon = 4K HDR HEVC (UHD streaming rip)
    // Solara = multi-quality direct CDN (WebDL)
    // Athens/Castle = synthetic HLS (WebDL)
    // Others = generic WebDL
    let markers = [];

    // Quality marker (2160p, 1080p, 720p, 480p)
    if (quality) markers.push(quality);

    // Source type — all Cinejoy streams are streaming rips (WebDL)
    markers.push('WEB-DL');

    // Codec — Lisbon 4K uses HEVC, others typically H264
    if (serverName === 'Lisbon' && quality === '2160p') {
      markers.push('HEVC');
      markers.push('HDR');  // Lisbon 4K is HDR
    } else if (quality === '2160p') {
      markers.push('HEVC');
    } else {
      markers.push('x264');
    }

    // Audio — Cinejoy streams are English (multi-audio for some)
    markers.push('English');

    // Build the enriched title
    // Format: "{title} [{server} server] {quality} WEB-DL {codec} {hdr} {audio}"
    // The server tag is already in the scraper's title, so we append markers
    const baseTitle = s.title || title;
    const enrichedTitle = baseTitle + ' ' + markers.join(' ');

    return {
      ...s,
      title: enrichedTitle,
      name: s.name || 'Cinejoy',
    };
  });
}

// Filter out streams from servers that are known to be broken.
// The Solara server (lol.movieboxnoob.cc/content?v=...) returns 403
// "Invalid token" — the CDN requires session-specific tokens that expire
// quickly. Including these streams causes Stremio to try loading them,
// get 403, and appear "slow" before falling back to other servers.
// Lisbon (info.movieboxnoob.cc) and Athens/Castle (api.shegu.st/synthetic)
// are fast and reliable — those are kept.
function filterBrokenServers(streams) {
  if (!Array.isArray(streams)) return streams;

  return streams.filter(s => {
    if (!s || !s.url) return false;
    const url = s.url.toLowerCase();

    // Solara server — consistently returns 403 "Invalid token"
    // The token in the URL expires within seconds, making the stream
    // unplayable from Stremio. Filter it out to avoid slow 403 failures.
    if (url.includes('lol.movieboxnoob.cc/content')) {
      return false;
    }

    return true;
  });
}

export class Cinejoy extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinejoy';
    this.label = 'Cinejoy';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://api.shegu.st';
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
      timeoutMs: 25000,
    });

    // Filter out broken Solara streams (403 "Invalid token") before enrichment
    const filteredStreams = filterBrokenServers(streams);

    // Enrich stream titles with metadata markers before buildStreamResults
    // so StreamResolver.enrichMeta can parse sourceType/codec/HDR/audio
    const enrichedStreams = enrichStreamTitles(filteredStreams, title);

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
