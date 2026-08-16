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
 * Clean a filename for display — removes hash-like strings, long random IDs,
 * and technical suffixes that clutter the stream title.
 *
 * Examples:
 *   "ADGPM2IzbD60Hu_XUAZoxoFP..." (googleusercontent hash) → ""
 *   "Pub-35214751cbf1431ba7b6d74f519e61d2.r2.dev_..." → ""
 *   "index-s2160p-v1-a1.m3u8" → "" (technical playlist index)
 *   "Dune.Part.Two.2024.1080p.AMZN.WEB-DL.DUAL.DDP5.1.ESubs.mkv" → kept (has metadata)
 *
 * The original filename is still used for enrichMeta parsing (quality, codec, etc.)
 * — this function only cleans the display title.
 */
export function cleanFilenameForDisplay(filename) {
  if (!filename || typeof filename !== 'string') return '';
  // Remove query string if present
  const f = filename.split('?')[0].split('#')[0];

  // If it's a hash-like string (no dots, all alphanumeric, >20 chars) → empty
  // e.g. "ADGPM2IzbD60Hu_XUAZoxoFP..."
  if (/^[a-zA-Z0-9_-]{20,}$/.test(f)) return '';

  // If it starts with a hash prefix like "Pub-35214751cbf1431ba7b6d74f519e61d2"
  // → empty (Cloudflare R2 bucket ID)
  if (/^pub-[a-f0-9]{20,}/i.test(f)) return '';

  // If it's a technical playlist index like "index-s2160p-v1-a1.m3u8" → empty
  // (the quality info is already parsed by enrichMeta and shown on Line 2)
  if (/^index-s\d+p-/i.test(f)) return '';

  // If it's a "master.m3u8" or similar generic playlist name → empty
  if (/^(master|playlist|index)\.(m3u8|mp4|mkv)$/i.test(f)) return '';

  // If it's a download.aspx or api endpoint → empty
  if (/\.aspx$|\.php$/i.test(f)) return '';

  // If it's a "bulk" endpoint (dahmermovies p.111477.xyz/bulk) → empty
  if (f === 'bulk' || f.startsWith('bulk?')) return '';

  // If the base name (without extension) is a long hash-like string → empty
  // e.g. "ma9ylsUHLd1oEUKmveBRDzgXvby4MyCQsteH9ZA1O0g0XZIbx0AtmD0IuVuAbN64B7T05nUYhK2jGUqK9_4aLzGatRb1WfVZMOGqdJ9hid36lg5MVVjVMnn.m3u8"
  // → empty (VidEasy URLs from moon.ironwallnet.net have hash-based filenames)
  const baseName = f.replace(/\.(m3u8|mp4|mkv|webm|avi|mov)$/i, '');
  if (baseName.length > 30 && /^[a-zA-Z0-9_-]+$/.test(baseName)) return '';

  // If it's a very long string with mostly random characters (>50% non-readable)
  // → empty. We check if it looks like a real filename (has dots, readable words)
  // vs a hash string (long alphanumeric with no readable words)
  if (f.length > 40) {
    // Count readable segments (separated by dots, at least 2 chars, has letters)
    const segments = f.split(/[._\-]/).filter(s => s.length >= 2 && /[a-z]/i.test(s) && !/^[a-f0-9]{8,}$/i.test(s));
    if (segments.length === 0) return '';
  }

  return f;
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

    // Build a rich title for enrichMeta parsing — include raw filename which
    // often contains quality/codec/sourceType/audio info (e.g.
    // "Dune.Part.Two.2024.1080p.AMZN.WEB-DL.DUAL.DDP5.1.ESubs.mkv")
    // For DISPLAY, use the cleaned filename (without hash strings, technical
    // playlist indices, etc.) to avoid clutter in the stream title.
    const streamTitle = s.title || s.quality || '';
    const displayFilename = cleanFilenameForDisplay(filename);
    const titleParts = [title];
    if (streamTitle) titleParts.push(streamTitle);
    if (displayFilename && displayFilename !== streamTitle) titleParts.push(displayFilename);
    const richTitle = titleParts.join(' — ');

    // For metadata parsing, use the raw filename (may contain quality/codec info
    // even if it's too cluttered for display)
    const metaFilename = filename;

    const allCountryCodes = [...countryCodes, ...findCountryCodes(streamTitle + ' ' + s.name + ' ' + filename)];
    const height = parseHeight(s.quality) || parseHeight(s.title) || parseHeight(filename);
    const fileSize = parseSize(s.size);

    // Build meta with Nuvio flags for NuvioExtractor
    //
    // IMPORTANT: Some CDN hosts return 403 when a Referer header is sent.
    // pixeldrain.com is one — it's a direct-play CDN that should be accessed
    // WITHOUT a Referer. We skip nuvioReferer for these hosts so they go
    // through DirectStream instead of /proxy.
    const NO_REFERER_HOSTS = /pixeldrain\.(com|dev)|fastdlserver\.site/i;
    const skipReferer = NO_REFERER_HOSTS.test(url.hostname);

    const meta = {
      countryCodes: allCountryCodes,
      title: richTitle,
      sourceId,
      sourceLabel,
      ...(height && { height }),
      ...(fileSize && { bytes: fileSize }),
      // Nuvio-specific flags read by NuvioExtractor
      nuvioProvider: true,
      ...(referer && !skipReferer && { nuvioReferer: referer }),
      ...(userAgent && { nuvioUserAgent: userAgent }),
      // forceHls=true when URL is ambiguous (not clearly HLS, not clearly MP4)
      // and requires a Referer — the proxy will do a HEAD check to determine
      // if the response is HLS or a video file
      ...(referer && !skipReferer && !hls && !videoFile && { nuvioForceHls: true }),
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
