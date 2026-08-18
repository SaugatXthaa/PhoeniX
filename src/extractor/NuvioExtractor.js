// src/extractor/NuvioExtractor.js
// Extractor for Nuvio provider streams (Cineby, DesiFlix, Goated, etc.)
//
// Each Nuvio source returns ORIGINAL stream URLs (not /proxy URLs) with meta
// containing:
//   - meta.sourceId       — the Nuvio source ID (cineby, desiflix, goated, etc.)
//   - meta.nuvioProvider  — true (marks this as a Nuvio stream)
//   - meta.nuvioReferer   — Referer to send (if any)
//   - meta.nuvioForceHls   — true if URL is ambiguous (use forceHls=1)
//
// This extractor matches by meta.nuvioProvider === true, and:
//   - HLS + Referer → /proxy with referer (proxy rewrites m3u8 URLs)
//   - Ambiguous URL + Referer → /proxy with forceHls=1 (proxy does HEAD check)
//   - MP4/MKV + Referer → direct URL with requestHeaders (proxyHeaders)
//   - No Referer → direct URL (DirectStream/ExternalUrl handles)
//
// This follows the same pattern as HiAnime/AnimeKai extractors which match
// by meta.sourceId and route through /proxy with the correct Referer.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

// Nuvio source IDs handled by this extractor
const NUVIO_SOURCE_IDS = new Set([
  'cineby', 'desiflix', 'hindmoviez', 'movieblast',
  'movies4u', 'playimdb',
  // Batch 2: videasy, anikototv, vixsrc2, animesalt,
  // animeworldindia, animesdigital
  'videasy', 'anikototv', 'vixsrc2',
  'animesalt', 'animeworldindia', 'animesdigital',
  // AniChan — anime sub+dub HLS via AniList ID + anichan.net API
  'anichan',
  // ZinkMovies — movies/series via gemma416okl.com API, HLS on rasta428jem.com
  'zinkmovies',
  // 1Embed — movies/TV HLS via 1embed.cc API, requires Referer: 1embed.cc
  'oneembed',
  // Re-added sources (from uploaded Nuvio scrapers):
  // zxcstream — embed URLs from player.zxcstream.xyz (route through /proxy)
  // cinejoy — HLS m3u8 from hdhub.thevolecitor.qzz.io (direct, no Referer)
  // animezey — anime HLS from workers.dev (direct)
  // uhdmovies — movies from googleusercontent (Referer: driveseed.org)
  // NOTE: hdhub4u is NOT here — its hubcdn/hubcloud URLs are handled by
  // HubExtractor/HubCloud downstream, not NuvioExtractor.
  'zxcstream', 'cinejoy', 'animezey', 'uhdmovies',
]);

// Detect if URL is clearly HLS (m3u8 file or /playlist path)
function isHlsUrl(url) {
  const p = url.pathname.toLowerCase();
  return p.endsWith('.m3u8') || p.includes('.m3u8') || p.includes('/m3u8/') || p.includes('/playlist');
}

// Detect if URL is clearly a video file (MP4/MKV)
function isVideoFileUrl(url) {
  const p = url.pathname.toLowerCase();
  return p.endsWith('.mp4') || p.endsWith('.mkv') || p.endsWith('.webm') || p.endsWith('.avi') || p.endsWith('.mov');
}

export class NuvioExtractor extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'nuvio';
    this.label = 'Nuvio';
    this.ttl = 1800000; // 30min — Nuvio stream URLs often have short-lived tokens
  }

  supports(_ctx, _url, meta) {
    // Match any Nuvio source by meta.sourceId
    return NUVIO_SOURCE_IDS.has(meta?.sourceId);
  }

  async extractInternal(ctx, url, meta) {
    const referer = meta?.nuvioReferer || '';
    const forceHls = meta?.nuvioForceHls === true;
    const userAgent = meta?.nuvioUserAgent || '';
    const hls = isHlsUrl(url);
    const videoFile = isVideoFileUrl(url);

    // Routing strategy (same as HiAnime/AnimeKai pattern):
    //   - HLS + Referer → /proxy (proxy rewrites m3u8 URLs + sends Referer)
    //   - Ambiguous URL + Referer → /proxy with forceHls=1
    //   - MP4/MKV + Referer → direct URL with requestHeaders (proxyHeaders)
    //   - forceHls (no Referer) → /proxy with forceHls=1 (AniChan: m3u8 with
    //     relative variant URLs that need rewriting, but no Referer needed)
    //   - No Referer, no forceHls → direct URL
    if (referer && hls) {
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      proxyUrl.searchParams.set('referer', referer);
      return [{
        url: proxyUrl,
        format: Format.hls,
        meta: { ...meta },
      }];
    } else if (referer && !videoFile) {
      // Ambiguous URL with Referer — use forceHls so proxy detects HLS
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      proxyUrl.searchParams.set('referer', referer);
      proxyUrl.searchParams.set('forceHls', '1');
      return [{
        url: proxyUrl,
        format: Format.hls,
        meta: { ...meta },
      }];
    } else if (forceHls) {
      // forceHls without Referer — route through /proxy with forceHls=1
      // (AniChan m3u8 has relative variant URLs that need rewriting)
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      proxyUrl.searchParams.set('forceHls', '1');
      return [{
        url: proxyUrl,
        format: Format.hls,
        meta: { ...meta },
      }];
    } else if (referer) {
      // MP4/MKV with Referer → direct URL with requestHeaders
      const requestHeaders = { Referer: referer };
      if (userAgent) requestHeaders['User-Agent'] = userAgent;
      return [{
        url,
        format: Format.mp4,
        meta: { ...meta },
        requestHeaders,
      }];
    } else {
      // No Referer → direct URL
      return [{
        url,
        format: hls ? Format.hls : Format.mp4,
        meta: { ...meta },
      }];
    }
  }
}
