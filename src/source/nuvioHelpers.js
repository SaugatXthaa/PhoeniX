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
  // Only match quality patterns like "1080p", "720p" — NOT bare 4-digit
  // numbers like "2008" (years) that appear in titles.
  const m = s.match(/(\d{3,4})p/);
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

// ─── Audio track metadata (API `audioTracks` field) ───
// Providers such as api.framextv.tech attach optional per-source audio
// metadata: `audioTracks` (array of language names/codes, a comma-separated
// string, an array of objects, or null) and `hasMultipleAudio` (boolean).
// These feed the language-flag system: buildStreamResults turns them into
// meta.countryCodes, and StreamResolver renders the "Audio: …" line with
// flags plus DUAL/MULTI special tags (parsed from the "Dual Audio …"
// title marker appended by the source wrappers).

// Lowercase alias → canonical display name. Canonical names intentionally
// match src/utils/language.js so findCountryCodes() maps them to codes.
const AUDIO_LANG_ALIASES = {
  english: 'English', en: 'English', eng: 'English',
  hindi: 'Hindi', hi: 'Hindi', hin: 'Hindi',
  japanese: 'Japanese', ja: 'Japanese', jpn: 'Japanese', jp: 'Japanese',
  korean: 'Korean', ko: 'Korean', kor: 'Korean',
  tamil: 'Tamil', ta: 'Tamil', tam: 'Tamil',
  telugu: 'Telugu', te: 'Telugu', tel: 'Telugu',
  malayalam: 'Malayalam', ml: 'Malayalam', mal: 'Malayalam',
  punjabi: 'Punjabi', pa: 'Punjabi', pan: 'Punjabi',
  bengali: 'Bengali', bn: 'Bengali', ben: 'Bengali',
  marathi: 'Marathi', mr: 'Marathi', mar: 'Marathi',
  gujarati: 'Gujarati', gu: 'Gujarati', guj: 'Gujarati',
  kannada: 'Kannada', kn: 'Kannada', kan: 'Kannada',
  spanish: 'Spanish', es: 'Spanish', spa: 'Spanish',
  french: 'French', fr: 'French', fra: 'French',
  german: 'German', de: 'German', ger: 'German',
  italian: 'Italian', it: 'Italian', ita: 'Italian',
  portuguese: 'Portuguese', pt: 'Portuguese', por: 'Portuguese',
  russian: 'Russian', ru: 'Russian', rus: 'Russian',
  arabic: 'Arabic', ar: 'Arabic', ara: 'Arabic',
  chinese: 'Chinese', mandarin: 'Chinese', zh: 'Chinese', chi: 'Chinese', zho: 'Chinese',
  cantonese: 'Cantonese', yue: 'Cantonese',
  turkish: 'Turkish', tr: 'Turkish', tur: 'Turkish',
  indonesian: 'Indonesian', id: 'Indonesian', ind: 'Indonesian',
  thai: 'Thai', th: 'Thai', tha: 'Thai',
  vietnamese: 'Vietnamese', vi: 'Vietnamese', vie: 'Vietnamese',
  filipino: 'Filipino', tagalog: 'Filipino', fil: 'Filipino', tl: 'Filipino',
  persian: 'Persian', farsi: 'Persian', fa: 'Persian', fas: 'Persian',
  hebrew: 'Hebrew', he: 'Hebrew', heb: 'Hebrew',
  polish: 'Polish', pl: 'Polish', pol: 'Polish',
  dutch: 'Dutch', nl: 'Dutch', nld: 'Dutch',
  ukrainian: 'Ukrainian', uk: 'Ukrainian', ukr: 'Ukrainian',
  urdu: 'Urdu', ur: 'Urdu',
  nepali: 'Nepali', ne: 'Nepali',
};

/**
 * Normalize a provider's raw `audioTracks` value into an array of canonical
 * language display names (deduped, capped at 6).
 *
 * Accepted shapes (defensive — the field is sparsely populated and its exact
 * shape varies by provider backend):
 *   null / undefined / ''          → []
 *   "Hindi,English"                → ['Hindi', 'English']
 *   ["Hindi", "en"]                → ['Hindi', 'English']
 *   [{ language: "Hindi" }, …]     → ['Hindi', …]
 *   '["Hindi","English"]' (JSON)   → ['Hindi', 'English']
 * Unknown language names are Title-Cased and passed through so the display
 * label still shows something sensible.
 */
export function normalizeAudioTracks(raw) {
  if (!raw) return [];
  let list = raw;
  if (typeof list === 'string') {
    const s = list.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try { list = JSON.parse(s); } catch { list = [s]; }
    } else {
      list = s.split(/\s*[,+/&;|]\s*|\s+and\s+/i);
    }
  }
  if (!Array.isArray(list)) return [];

  const out = [];
  const seen = new Set();
  for (const item of list) {
    let name = '';
    if (typeof item === 'string') name = item;
    else if (item && typeof item === 'object') {
      name = item.language || item.lang || item.name || item.label || item.title
        || item.code || item.iso639_1 || item.iso639 || '';
    } else {
      continue;
    }
    name = String(name).trim().toLowerCase().replace(/[\[\]"]/g, '');
    if (!name || ['null', 'undefined', 'unknown', 'original', 'none', 'default'].includes(name)) continue;
    const canonical = AUDIO_LANG_ALIASES[name] || name.replace(/\b\w/g, (c) => c.toUpperCase());
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
    if (out.length >= 6) break; // sanity cap
  }
  return out;
}

/**
 * Build the dual-audio display label from normalized audio tracks.
 *   2 tracks                  → "Dual Audio (Hindi + English)"  (parses to DUAL tag)
 *   3+ tracks                 → "Multi Audio (Hindi + English + Tamil)" (parses to MULTI)
 *   1 track                   → "Hindi"
 *   0 tracks + hasMultipleAudio → "Dual Audio" (flag without a track list)
 *   nothing                   → null (caller falls back to its default marker)
 */
export function buildAudioLabel(tracks, hasMultipleAudio) {
  const list = Array.isArray(tracks) ? tracks : normalizeAudioTracks(tracks);
  if (list.length >= 2) {
    const kind = list.length === 2 ? 'Dual' : 'Multi';
    return `${kind} Audio (${list.slice(0, 4).join(' + ')})`;
  }
  if (list.length === 1) return list[0];
  if (hasMultipleAudio === true) return 'Dual Audio';
  return null;
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

  // If it's too short to be a real filename (< 3 chars) → empty
  // This filters out URL path segments like "p" (from /playlist/p/),
  // "v" (from /v/), "e" (from /e/), etc.
  if (f.length < 3) return '';

  // If it's a hash-like string (no dots, all alphanumeric, >20 chars) → empty
  // e.g. "ADGPM2IzbD60Hu_XUAZoxoFP..."
  if (/^[a-zA-Z0-9_-]{20,}$/.test(f)) return '';

  // If it starts with a hash prefix like "Pub-35214751cbf1431ba7b6d74f519e61d2"
  // → empty (Cloudflare R2 bucket ID)
  if (/^pub-[a-f0-9]{20,}/i.test(f)) return '';

  // If it's a technical playlist index like "index-s2160p-v1-a1.m3u8" → empty
  // (the quality info is already parsed by enrichMeta and shown on Line 2)
  if (/^index-s\d+p-/i.test(f)) return '';

  // If it's a "master.m3u8" or similar generic playlist/stream name → empty
  if (/^(master|playlist|index|hls|stream|video|play|watch|embed|api|proxy|content|uc|file|download)\.(m3u8|mp4|mkv|ts)$/i.test(f)) return '';

  // If it's a bare path segment like "hls", "playlist", "stream" without extension
  // → empty (these are URL path segments, not filenames)
  if (/^(hls|playlist|stream|video|play|watch|embed|api|proxy|content|uc|file|download|p|v|e)$/i.test(f)) return '';

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
    // Origin header (e.g. Stellar: workers CDNs reject requests without
    // Origin: https://stellar.gdn). NuvioExtractor turns this into an
    // origin= param on /proxy URLs; src/index.js /proxy sends it upstream
    // and propagates it onto every rewritten m3u8 URL.
    const origin = s.headers?.Origin || s.headers?.origin || '';
    const hls = isHlsUrl(url);
    const videoFile = isVideoFileUrl(url);
    const filename = extractFilename(url);
    // Task 48: atlantic's CDN endpoints (/m3u8-proxy, /cdn-m3u8) are technical
    // proxy-route names, not filenames — they would surface as display clutter
    // ("— m3u8-proxy") in the card title. Treat them as empty.
    const displayFilename = /^(m3u8-proxy|cdn-m3u8)$/i.test(filename) ? '' : cleanFilenameForDisplay(filename);

    // Build a rich title for enrichMeta parsing — include raw filename which
    // often contains quality/codec/sourceType/audio info (e.g.
    // "Dune.Part.Two.2024.1080p.AMZN.WEB-DL.DUAL.DDP5.1.ESubs.mkv")
    // For DISPLAY, use the cleaned filename (without hash strings, technical
    // playlist indices, etc.) to avoid clutter in the stream title.
    const streamTitle = s.title || s.quality || '';
    const titleParts = [title];
    if (streamTitle) titleParts.push(streamTitle);
    if (displayFilename && displayFilename !== streamTitle) titleParts.push(displayFilename);
    const richTitle = titleParts.join(' — ');

    // For metadata parsing, use the raw filename (may contain quality/codec info
    // even if it's too cluttered for display)
    const metaFilename = filename;

    // Language flags — meta.countryCodes feed StreamResolver's "Audio:" line
    // and flag rendering. When the API reports explicit audio tracks for this
    // stream, they are the authoritative audio and OVERRIDE the source-level
    // defaults (which are just 'multi' + language guesses for the whole
    // source). Otherwise fall back to the previous behavior: source defaults
    // + languages found by name in the stream title/filename.
    const audioTracks = normalizeAudioTracks(s.audioTracks);
    const allCountryCodes = audioTracks.length > 0
      ? [...new Set(['multi', ...findCountryCodes(audioTracks.join(' '))])]
      : [...new Set([...(countryCodes || []), ...findCountryCodes(streamTitle + ' ' + s.name + ' ' + filename)])];
    const height = parseHeight(s.quality) || parseHeight(s.title) || parseHeight(filename);
    const fileSize = parseSize(s.size);

    // Build meta with Nuvio flags for NuvioExtractor
    //
    // IMPORTANT: Some CDN hosts return 403 when a Referer header is sent.
    // pixeldrain.com is one — it's a direct-play CDN that should be accessed
    // WITHOUT a Referer. We skip nuvioReferer for these hosts so they go
    // through DirectStream instead of /proxy.
    // googleusercontent.com is also direct-play (GDrive CDN) — it doesn't
    // need a Referer and the NuvioExtractor routes it through /range-proxy
    // (which doesn't send Referer anyway).
    // *.vimeos.zip AND *.vimeos.net (vidsrc-family CDN, backs speedracelight
    // "m4uhd"/"lamovie" server streams — cineby Task 40 verified vimeos.net:
    // live 403 on ANY request carrying Referer: vidking.net, 200 #EXTM3U with
    // no Referer — same inverted gate as vimeos.zip) has an INVERTED hotlink
    // gate: skipping Referer routes it as direct HLS — plays clean.
    // fetch.nexabloom.top / *.vyrnex.top (megaplay.buzz anime CDN since the
    // 2026-09 encrypted-sources change) hard-403 ALL DATACENTER IPs —
    // /proxy would fetch from THIS server and always 403. Skipping Referer
    // routes them as direct HLS so the PLAYER's residential IP fetches them.
    const NO_REFERER_HOSTS = /pixeldrain\.(com|dev)|fastdlserver\.site|googleusercontent\.com|vimeos\.(zip|net)|nexabloom\.top|vyrnex\.top/i;
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
      ...(origin && { nuvioOrigin: origin }),
      // forceHls=true when URL is ambiguous (not clearly HLS, not clearly MP4)
      // and requires a Referer — the proxy will do a HEAD check to determine
      // if the response is HLS or a video file
      ...(referer && !skipReferer && !hls && !videoFile && { nuvioForceHls: true }),
      // Pass through subtitles from raw stream objects. Many nuvio scrapers
      // (cineby, castle, 1embed, anikototv, animesalt, animesuge, animeworld,
      // anineko, etc.) return subtitle URLs in their stream objects but this
      // was previously dropped. StreamResolver reads meta.subtitles and
      // attaches them to the final Stremio stream output.
      // Format: [{ id, url, lang }] — Stremio standard.
      ...((Array.isArray(s.subtitles) && s.subtitles.length > 0) && {
        subtitles: s.subtitles
          .map(sub => {
            if (!sub || !sub.url) return null;
            const subId = sub.id || sub.srclang || sub.language || sub.lang || 'en';
            const subLang = sub.lang || sub.language || sub.srclang || sub.label || 'en';
            return {
              id: typeof subId === 'string' ? subId.slice(0, 8) : String(subId).slice(0, 8),
              url: sub.url,
              lang: typeof subLang === 'string' ? subLang : String(subLang),
            };
          })
          .filter(Boolean),
      }),
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
 * Retry-on-empty wrapper for flaky scrapers (Task 38).
 *
 * Production evidence: uhdmovies/bollyflix/stellar/stellarrip resolve fine in
 * isolation MOST of the time, but transient upstream windows (gateway flakes,
 * PoW/availability flickers) produce empty results that then poison the
 * per-source 60s negative cache — the user sees nothing for a minute.
 * A single bounded retry inside the wrapper absorbs those windows.
 *
 * A non-array result (race-cap timeout sentinel `null`) is propagated
 * immediately — the caller's timeout already fired, retrying is pointless.
 * The retry only happens while elapsed < maxTotalMs/2 so attempt 2 always has
 * at least half the budget; the caller's outer race still bounds the worst case.
 */
export async function withRetryOnEmpty(fn, { attempts = 2, maxTotalMs = 12000, backoffMs = 400, tag = 'nuvio' } = {}) {
  const t0 = Date.now();
  let last = [];
  for (let i = 0; i < attempts; i++) {
    if (i > 0 && Date.now() - t0 >= maxTotalMs) break;
    // Task 49: network-level THROWS ("fetch failed", DNS/socket hiccups — the
    // Render 0.1-CPU storm class documented in Task 48 fix2) used to escape
    // this helper uncaught, zeroing the whole run with NO retry. Production
    // evidence: [4khdhub] getStreams error: fetch failed → 0 streams until the
    // user refreshed 4-5 times. A throw now behaves exactly like an empty
    // result so the existing retry/backoff logic applies.
    let r;
    let threw = false;
    try {
      r = await fn();
    } catch (e) {
      threw = true;
      console.log(`[${tag}] attempt ${i + 1}/${attempts} threw: ${e?.message || e}`);
    }
    if (!threw) {
      if (!Array.isArray(r)) return r; // timeout sentinel or unexpected shape
      if (r.length > 0) return r;
      last = r;
    }
    if (i < attempts - 1 && Date.now() - t0 < maxTotalMs / 2) {
      console.log(`[${tag}] empty resolve (attempt ${i + 1}/${attempts}), retrying`);
      await new Promise(rr => setTimeout(rr, backoffMs));
    } else break;
  }
  return last;
}

export async function callNuvioProvider(providerPath, { tmdbId, mediaType, season, episode, timeoutMs = 25000 }) {
  const require_ = createRequire(providerPath);

  // NOTE: Do NOT delete require_.cache here. Clearing the cache forces a
  // module reload on every call, which breaks obfuscated scrapers (videasy,
  // animezey, etc.) that have initialization side effects or dynamic imports
  // that don't complete properly on reload. The module code doesn't change
  // between requests, so caching is safe and improves performance.

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

/**
 * Liveness gate for streams whose playback is server-proxied (/proxy).
 * Probes each raw upstream URL with the stream's own headers and drops
 * streams that would guaranteed-error at play:
 *   - HTTP 4xx/5xx (403 hotlink gates, 401 JS-cookie challenges, 404 dead)
 *   - 200 + text/html (Cloudflare "Just a moment" pages, download pages)
 * Server-side probing is ACCURATE for proxied streams because the /proxy
 * fetches the upstream from this same server at play time.
 * Only apply to proxied sources — direct-URL streams play from the PLAYER's
 * IP, where a server-side verdict would be wrong.
 *
 * @param {Array}  streams — raw provider stream objects ({url, headers, ...})
 * @param {Object} opts    — { timeoutMs = 8000 }
 * @returns {Promise<Array>} — the subset of streams that answered with real content
 */
export async function filterDeadStreams(streams, { timeoutMs = 8000, dropOnNetworkError = true, ipClassStatuses = [] } = {}) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const checked = await Promise.all((streams || []).map(async (s) => {
    if (!s?.url || typeof s.url !== 'string' || !s.url.startsWith('http')) return null;
    let host = '(bad-url)';
    try { host = new URL(s.url).hostname; } catch { return null; }
    try {
      const res = await fetch(s.url, {
        headers: { 'User-Agent': UA, Range: 'bytes=0-1023', ...(s.headers || {}) },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok) {
        // ipClassStatuses (Task 71): caller-declared "this upstream gates
        // datacenter probes with these statuses but serves device IPs" —
        // same doctrine as the Task 65 tarpit exemption (dropOnNetworkError
        // false) and the gate's lh3/nexabloom 'unknown' verdicts. A 401/403
        // from an IP-class CDN is NOT proof the player cannot play it.
        if (ipClassStatuses.includes(res.status)) {
          console.log(`[liveness] keep ${res.status} (ip-class) ${host}${new URL(s.url).pathname.slice(0, 30)}`);
          return s;
        }
        console.log(`[liveness] drop ${res.status} ${host}${new URL(s.url).pathname.slice(0, 30)}`);
        return null;
      }
      if (/text\/html/i.test(ct)) {
        console.log(`[liveness] drop HTML gate ${host}${new URL(s.url).pathname.slice(0, 30)}`);
        return null;
      }
      return s;
    } catch (e) {
      // Task 38: under resolver concurrency (Render 0.1-CPU) these probes can
      // time out for streams that play fine from the player's own connection —
      // an abort/timeout is NOT proof of death. Callers that opt out keep the
      // stream on network errors; only definitive 4xx/5xx/HTML responses drop.
      // Default unchanged (true) for existing consumers (dahmermovies×2,
      // hindmoviez — do-not-touch byte-parity).
      console.log(`[liveness] drop (${(e?.message || e).slice?.(0, 40) || 'error'}) ${host}`);
      return dropOnNetworkError ? null : s;
    }
  }));
  const kept = checked.filter(Boolean);
  const dropped = (streams || []).length - kept.length;
  if (dropped > 0) console.log(`[liveness] ${dropped} dead stream(s) dropped, ${kept.length} kept`);
  return kept;
}
