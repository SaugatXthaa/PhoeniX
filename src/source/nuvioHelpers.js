// src/source/nuvioHelpers.js
// Shared helpers for Nuvio provider source adapters.
//
// Each Nuvio source (Cineby, DesiFlix, Goated, etc.) calls a CommonJS provider
// module that returns stream objects of the form:
//   { url, quality, title, name, size, headers: {Referer, User-Agent}, subtitles }
//
// This module provides:
//   - parseHeight(q)       — "1080p"/"4K"/"2160p" → 1080/2160
//   - isHlsUrl(url)        — true if URL is clearly HLS (.m3u8 or /playlist)
//   - isVideoFileUrl(url)  — true if URL is clearly MP4/MKV
//   - parseSize(size)      — "1.5GB" → bytes
//   - extractFilename(url) — last path segment (for metadata parsing)
//   - buildStreamResults(params) — converts provider streams to Source result format
//   - callNuvioProvider(path, params) — loads + calls provider with timeout
//
// buildStreamResults returns ORIGINAL stream URLs (not /proxy URLs) with meta
// flags (nuvioProvider, nuvioReferer, nuvioForceHls) that the NuvioExtractor
// reads to decide routing (/proxy vs direct vs requestHeaders).
// This follows the same pattern as HiAnime/AnimeKai sources.

import { createRequire } from 'module';
import { Format } from '../types.js';
import { findCountryCodes } from '../utils/index.js';

export function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : undefined;
}

export function isHlsUrl(url) {
  const p = url.pathname.toLowerCase();
  return p.endsWith('.m3u8') || p.includes('.m3u8') || p.includes('/m3u8/') || p.includes('/playlist');
}

export function isVideoFileUrl(url) {
  const p = url.pathname.toLowerCase();
  return p.endsWith('.mp4') || p.endsWith('.mkv') || p.endsWith('.webm') || p.endsWith('.avi') || p.endsWith('.mov');
}

export function parseSize(size) {
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

export function extractFilename(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  const last = parts[parts.length - 1];
  // If the last segment has no extension and looks like a hash, try previous segment
  if (!last.includes('.') && /^[a-zA-Z0-9_-]{20,}$/.test(last) && parts.length > 1) {
    return parts[parts.length - 2] || '';
  }
  return last;
}

/**
 * Convert Nuvio provider streams to PhoeniX Source result format.
 *
 * Returns ORIGINAL stream URLs (not /proxy URLs) with meta flags that the
 * NuvioExtractor reads to decide routing:
 *   - meta.nuvioProvider  — true (marks this as a Nuvio stream)
 *   - meta.nuvioReferer   — Referer to send (if any)
 *   - meta.nuvioForceHls   — true if URL is ambiguous (use forceHls=1)
 *   - meta.nuvioUserAgent — User-Agent to send (if any)
 *
 * The NuvioExtractor handles the actual /proxy routing, following the same
 * pattern as HiAnime/AnimeKai extractors.
 *
 * @param {Object} params
 * @param {Array}  params.streams      — Raw provider stream objects
 * @param {string} params.title        — Base title (movie name + year/season-ep)
 * @param {string} params.sourceId     — Source ID (e.g. 'cineby')
 * @param {string} params.sourceLabel  — Source label (e.g. 'Cineby')
 * @param {Array}  params.countryCodes — Default country codes for the source
 * @param {Object} params.ctx          — Request context (unused but kept for consistency)
 * @returns {Array} — Source result objects { url, format, meta }
 */
export function buildStreamResults({ streams, title, sourceId, sourceLabel, countryCodes, ctx: _ctx }) {
  const results = [];

  for (const s of (streams || [])) {
    if (!s || !s.url || typeof s.url !== 'string') continue;
    if (!s.url.startsWith('http')) continue;

    let url;
    try { url = new URL(s.url); } catch { continue; }

    const referer = s.headers?.Referer || s.headers?.referer || '';
    const userAgent = s.headers?.['User-Agent'] || s.headers?.['user-agent'] || '';
    const hls = isHlsUrl(url);
    const videoFile = isVideoFileUrl(url);
    const filename = extractFilename(url);

    // Build a rich title for enrichMeta parsing — include filename which
    // often contains quality/codec/sourceType/audio info
    const streamTitle = s.title || s.quality || '';
    const titleParts = [title];
    if (streamTitle) titleParts.push(streamTitle);
    if (filename && filename !== streamTitle) titleParts.push(filename);
    const richTitle = titleParts.join(' — ');

    const allCountryCodes = [...countryCodes, ...findCountryCodes(streamTitle + ' ' + s.name + ' ' + filename)];
    const height = parseHeight(s.quality) || parseHeight(s.title) || parseHeight(filename);
    const fileSize = parseSize(s.size);

    // Build meta with Nuvio flags for NuvioExtractor
    const meta = {
      countryCodes: allCountryCodes,
      title: richTitle,
      sourceId,
      sourceLabel,
      ...(height && { height }),
      ...(fileSize && { bytes: fileSize }),
      // Nuvio-specific flags read by NuvioExtractor
      nuvioProvider: true,
      ...(referer && { nuvioReferer: referer }),
      ...(userAgent && { nuvioUserAgent: userAgent }),
      // forceHls=true when URL is ambiguous (not clearly HLS, not clearly MP4)
      // and requires a Referer — the proxy will do a HEAD check to determine
      // if the response is HLS or a video file
      ...(referer && !hls && !videoFile && { nuvioForceHls: true }),
    };

    // Return original URL with format hint — NuvioExtractor handles routing
    results.push({
      url,
      format: hls ? Format.hls : (videoFile ? Format.mp4 : Format.unknown),
      meta,
    });
  }

  return results;
}

/**
 * Load a Nuvio CommonJS provider module and call getStreams with a timeout.
 *
 * @param {string} providerPath — Absolute path to the .cjs file
 * @param {Object} params        — { tmdbId, mediaType, season, episode, timeoutMs }
 * @returns {Promise<Array>}    — Array of stream objects, or [] on failure
 */
export async function callNuvioProvider(providerPath, { tmdbId, mediaType, season, episode, timeoutMs = 25000 }) {
  const require_ = createRequire(providerPath);
  try {
    delete require_.cache[require_.resolve(providerPath)];
  } catch {}

  let provider;
  try {
    provider = require_(providerPath);
  } catch (e) {
    console.error(`[nuvio] failed to load provider ${providerPath}: ${e?.message || e}`);
    return [];
  }
  if (!provider || typeof provider.getStreams !== 'function') return [];

  try {
    const streams = await Promise.race([
      provider.getStreams(tmdbId, mediaType, season, episode),
      new Promise(r => setTimeout(() => r(null), timeoutMs)),
    ]);
    return Array.isArray(streams) ? streams : [];
  } catch (e) {
    console.error(`[nuvio] getStreams error: ${e?.message || e}`);
    return [];
  }
}
