// src/extractor/DirectStream.js
// Passthrough extractor for direct playable CDN URLs.
//
// Some sources (CineWave's HdHub API, Fmovies) return direct playable URLs
// from CDN hosts that no other extractor claims. Without this extractor,
// those URLs are silently dropped by ExtractorRegistry (returns [] when
// no extractor matches and no meta.vidking is present).
//
// Hosts handled:
//   - streamx.me           (Fmovies direct MP4)
//   - thefmovies.sbs       (Fmovies direct video URLs)
//   - pixeldrain.dev       (CineWave HdHub — Pixeldrain CDN)
//   - *.r2.dev             (CineWave HdHub — Cloudflare R2)
//   - *.r2.cloudflarestorage.com (CineWave HdHub — Cloudflare R2)
//   - cdn.fsl-buckets.work (CineWave HdHub — FSL CDN)
//   - cdn.fukggl.buzz      (CineWave HdHub — CDN)
//
// All URLs are passed through as-is — no fetch needed, they play directly.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

// Hosts that serve direct playable video files
const DIRECT_CDN_HOSTS = [
  'streamx.me',
  'thefmovies.sbs',
  'pixeldrain.dev',
  'pixeldrain.com',
  'cdn.fsl-buckets.work',
  'cdn.fukggl.buzz',
  // MovieBox — direct MP4 on hakunaymatata.com CDN (but often rate-limited
  // with 429 — needsProxy in StreamResolver routes these through /proxy)
  'bcdnxw2.hakunaymatata.com',
  'bcdnxw.hakunaymatata.com',
  // VidLink — direct MP4 on bcdn.hakunaymatata.com (plays without Referer)
  'bcdn.hakunaymatata.com',
  'hbcdn.hakunaymatata.com',
  // FilmeOnlineHD — file hosts from linksdrive
  'fastdl.zip',
  'vcloud.zip',
  'filebee.xyz',
  'vikingfile.com',
  // VegaCatering — file hosts from nexdrive
  'vcloud.fit',
  'new26.gdtot.dad',
  'gdtot.dad',
  // AniVault — AnimeHeaven direct MP4 (but returns Connection reset by peer
  // when Stremio's player accesses directly — needsProxy in StreamResolver
  // routes these through /proxy)
  'rt.animeheaven.me',
  'co.animeheaven.me',  // AniVault API returns co.animeheaven.me for some sources
  // Cinejoy — direct HLS from info.movieboxnoob.cc (no Referer needed)
  'info.movieboxnoob.cc',
  // Stellar.rip — direct HLS from proxy2.heistotron.uk (needs browser UA via proxyHeaders)
  'proxy2.heistotron.uk',
  // NowHDTime — direct HLS API (nhdapi.com/api/hls?t=...)
  'nhdapi.com',
  // AnimeSuge/NikaStream — direct HLS from cdn.kryntal.top (needs Referer via proxyHeaders)
  'cdn.kryntal.top',
  // GDrive — direct MKV/MP4 from lh3.googleusercontent.com and video-downloads.googleusercontent.com
  'lh3.googleusercontent.com',
  'video-downloads.googleusercontent.com',
  // AniPriv8 — handled by dedicated AniPriv8 extractor (needs proxy for m3u8 rewriting)
];

// Host suffixes (for wildcard matching like *.r2.dev)
const DIRECT_CDN_SUFFIXES = [
  '.r2.dev',
  '.r2.cloudflarestorage.com',
  '.hakunaymatata.com',
];

function isDirectCdnHost(hostname) {
  // Exact match
  if (DIRECT_CDN_HOSTS.includes(hostname)) return true;
  // Suffix match (for wildcard subdomains)
  for (const suffix of DIRECT_CDN_SUFFIXES) {
    if (hostname.endsWith(suffix)) return true;
  }
  return false;
}

function inferFormat(url) {
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.m3u8') || path.includes('.m3u8')) return Format.hls;
  if (path.endsWith('.mp4') || path.endsWith('.mkv') || path.endsWith('.webm')) return Format.mp4;
  // Default: most direct CDN URLs are MP4/MKV
  return Format.mp4;
}

export class DirectStream extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'directstream';
    this.label = 'Direct';
    this.ttl = 3600000; // 1h
  }

  supports(_ctx, url) {
    return isDirectCdnHost(url.hostname);
  }

  async extractInternal(_ctx, url, meta) {
    // Return direct URL — these CDNs support direct access with Range headers.
    // Proxying causes "network connection was lost" on large file downloads
    // because Render kills long-running proxy connections.
    return [{
      url,
      format: inferFormat(url),
      label: this.label,
      meta: { ...meta },
      // Pass through requestHeaders from source → StreamResolver sets proxyHeaders
      ...(meta?.requestHeaders && { requestHeaders: meta.requestHeaders }),
    }];
  }
}
