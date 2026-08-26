// src/source/NuvioSource.js
// Adapter for Nuvio provider .cjs modules (from All-in-One-Nuvio).
//
// Each Nuvio provider exports: `module.exports = { getStreams }`
// where `getStreams(tmdbId, mediaType, season, episode)` returns an array of:
//   { url, quality, title, name, size, headers: {Referer, User-Agent}, subtitles }
//
// We:
//   1. Resolve TMDB ID + name/year (same as every other source)
//   2. Call the provider's getStreams()
//   3. Return ORIGINAL stream URLs with meta flags (nuvioProvider, referer,
//      userAgent, forceHls) — the NuvioExtractor reads these flags and
//      decides whether to route through /proxy (for HLS with Referer) or
//      return direct with requestHeaders (for MP4 with Referer).
//
// This adapter is purely additive — it does not touch any other source or extractor.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId, findCountryCodes } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const NUOVIO_DIR = path.join(__dirname, '..', 'nuvio');

// Parse a quality string like "1080p", "2160p", "4K", "720P" into a height integer
function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : undefined;
}

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

// Parse file size from "size" field — Nuvio providers return strings like "1.5GB" or "Unknown"
function parseSize(size) {
  if (!size || typeof size !== 'string') return undefined;
  const m = size.match(/([\d.]+)\s*(GB|MB|TB)/i);
  if (!m) return undefined;
  const num = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'GB') return Math.round(num * 1024 * 1024 * 1024);
  if (unit === 'MB') return Math.round(num * 1024 * 1024);
  if (unit === 'TB') return Math.round(num * 1024 * 1024 * 1024 * 1024);
  return undefined;
}

// Extract a meaningful filename from the URL path for metadata parsing.
// e.g. https://pub-xxx.r2.dev/Movies4u.Vip.Dune.Part.Two.2024.1080p.WEB-DL.mkv
//   → "Movies4u.Vip.Dune.Part.Two.2024.1080p.WEB-DL.mkv"
// e.g. https://moon.ironwallnet.net/vd/{hash}/index-s2160p-v1-a1.m3u8
//   → "index-s2160p-v1-a1.m3u8"
function extractFilename(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  const last = parts[parts.length - 1];
  // If the last segment has no extension and looks like a hash, skip it
  // and try the previous segment
  if (!last.includes('.') && /^[a-zA-Z0-9_-]{20,}$/.test(last) && parts.length > 1) {
    return parts[parts.length - 2] || '';
  }
  return last;
}

// Extract a sub-source name from the URL hostname.
// e.g. pub-130aa59d981442e4aecf63fe61e4079e.r2.dev → "Movies4u" (from filename prefix)
// We prefer the filename prefix over the hostname for better identification.
function extractSubSource(url, streamTitle) {
  // Try to get provider name from the stream title (e.g. "Movies4u.Vip.Dune...")
  if (streamTitle) {
    const m = streamTitle.match(/^([A-Za-z0-9]+)\./);
    if (m && m[1].length > 2 && m[1].length <= 20) {
      const name = m[1];
      // Skip if it looks like a hash or generic word
      const isHash = /^[a-f0-9]{12,}$/i.test(name);
      const isGeneric = ['cdn', 'api', 'www', 'static', 'media', 'video', 'stream', 'proxy', 'index', 'master'].includes(name.toLowerCase());
      if (!isHash && !isGeneric) {
        return name.charAt(0).toUpperCase() + name.slice(1);
      }
    }
  }
  // Fall back to hostname
  const hostname = url.hostname.replace(/^www\./, '').split('.')[0];
  const isHash = /^[a-f0-9]{12,}$/i.test(hostname);
  const isGeneric = ['cdn', 'api', 'www', 'static', 'media', 'video', 'stream', 'proxy', 'pub'].includes(hostname.toLowerCase());
  if (hostname && hostname.length > 2 && !isHash && !isGeneric) {
    return hostname.charAt(0).toUpperCase() + hostname.slice(1);
  }
  return '';
}

export class NuvioSource extends Source {
  constructor(fetcher, opts) {
    super();
    this.id = opts.id;
    this.label = opts.label;
    this.contentTypes = opts.contentTypes || ['movie', 'series'];
    this.countryCodes = opts.countryCodes || [CountryCode.multi];
    this.fetcher = fetcher;
    this.moduleName = opts.module;
    this.providerPath = path.join(NUOVIO_DIR, `${opts.module}.cjs`);
    this.provider = null;
    this.domainKey = `nuvio_${opts.id}`;
  }

  loadProvider() {
    if (!this.provider) {
      try { delete require_.cache[require_.resolve(this.providerPath)]; } catch {}
      this.provider = require_(this.providerPath);
    }
    return this.provider;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const provider = this.loadProvider();
    if (!provider || typeof provider.getStreams !== 'function') {
      console.error(`[nuvio:${this.id}] provider module has no getStreams export`);
      return [];
    }

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await Promise.race([
        provider.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null),
        new Promise(r => setTimeout(() => r(null), 20000)),
      ]);
    } catch (e) {
      console.error(`[nuvio:${this.id}] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    const results = [];
    for (const s of streams) {
      if (!s || !s.url || typeof s.url !== 'string') continue;
      if (!s.url.startsWith('http')) continue;

      let url;
      try { url = new URL(s.url); } catch { continue; }

      const referer = s.headers?.Referer || s.headers?.referer || '';
      const userAgent = s.headers?.['User-Agent'] || s.headers?.['user-agent'] || '';
      const hls = isHlsUrl(url);
      const videoFile = isVideoFileUrl(url);

      // Extract filename and subSource from the original URL for metadata enrichment
      const filename = extractFilename(url);
      const streamTitleRaw = s.title || s.quality || '';
      const subSource = extractSubSource(url, streamTitleRaw || filename);

      // Build a rich title for enrichMeta parsing — include filename which
      // often contains quality/codec/sourceType/audio info (e.g.
      // "Dune.Part.Two.2024.1080p.AMZN.WEB-DL.DUAL.DDP5.1.ESubs.mkv")
      const qualityStr = s.quality || '';
      const titleParts = [title];
      if (streamTitleRaw) titleParts.push(streamTitleRaw);
      if (filename && filename !== streamTitleRaw) titleParts.push(filename);
      const richTitle = titleParts.join(' — ');

      const countryCodes = [...this.countryCodes, ...findCountryCodes(streamTitleRaw + ' ' + s.name + ' ' + filename)];
      const height = parseHeight(s.quality) || parseHeight(s.title) || parseHeight(filename);
      const fileSize = parseSize(s.size);

      // Determine routing strategy:
      //   - HLS with Referer → /proxy (proxy rewrites m3u8 URLs + sends Referer)
      //   - Ambiguous URL with Referer (not clearly HLS, not clearly MP4) →
      //     /proxy with forceHls=1 (proxy does HEAD check, then buffer or stream)
      //   - MP4/MKV with Referer → direct URL with requestHeaders (proxyHeaders)
      //   - No Referer → direct URL (DirectStream/ExternalUrl handles)
      const needsProxy = !!referer && (hls || !videoFile);
      const useRequestHeaders = !!referer && videoFile && !hls;

      const meta = {
        countryCodes,
        title: richTitle,
        sourceId: this.id,
        sourceLabel: this.label,
        ...(height && { height }),
        ...(fileSize && { bytes: fileSize }),
        ...(subSource && { subSource }),
        // Pass the original stream URL so enrichMeta can parse metadata from it
        // (the display URL is a /proxy URL which is useless for parsing)
        streamUrl: url.href,
        // Nuvio-specific flags read by NuvioExtractor
        nuvioProvider: true,
        ...(needsProxy && { nuvioProxy: true, nuvioReferer: referer, ...(hls ? { nuvioForceHls: false } : { nuvioForceHls: true }) }),
      };

      if (useRequestHeaders) {
        const requestHeaders = { Referer: referer };
        if (userAgent) requestHeaders['User-Agent'] = userAgent;
        results.push({ url, meta, requestHeaders });
      } else {
        results.push({ url, meta });
      }
    }

    return results;
  }
}
