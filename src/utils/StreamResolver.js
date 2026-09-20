// src/utils/StreamResolver.js

import bytes from 'bytes';
import { Format } from '../types.js';
import { getClosestResolution } from './resolution.js';
import { flagFromCountryCode, languageFromCountryCode } from './language.js';
import { SubtitleFetcher } from './SubtitleFetcher.js';
import streamGate from './streamGate.cjs';
// Task 54: playback-priority — background (post-budget) source starts yield
// to /proxy + /range-proxy traffic so players never queue behind scraping.
import playbackGate from './playbackGate.cjs';
import { createRequire } from 'module';

// Task 49: unified subtitle providers — the atlantic.st site stack (granite
// VTT + natsuki SRT), shared across ALL sources so movies, series, kdramas
// and animes carry the same subtitle set on every card (user requirement).
const require_ = createRequire(import.meta.url);
const { fetchUnifiedSubs, mergeSubtitleTracks } = require_('./siteSubtitles.cjs');

// Extract a release name from a stream's meta + URL for OpenSubtitles
// release-name matching. Returns "" if no recognizable release name found.
//
// Checks (in order of reliability):
//   1. meta.filename (set by 4KHDHub, MoviesDrive, HubCloud sources)
//   2. URL pathname last segment (if it looks like a real filename)
//   3. meta.title (sometimes contains release info)
//
// Delegates the actual validation/sanitization to SubtitleFetcher's
// sanitizeReleaseName logic via a simple regex check here — the full
// validation happens in SubtitleFetcher.fetchByTmdbId().
function extractReleaseNameFromStream(urlResult) {
  if (!urlResult || !urlResult.url) return '';
  const meta = urlResult.meta || {};

  // 1. Try meta.filename first (most reliable — set by download sources)
  if (meta.filename && typeof meta.filename === 'string') {
    const cleaned = meta.filename.split('?')[0].split('#')[0].split('/').pop() || meta.filename;
    // Quick sanity check — must contain year or quality marker
    if (/(19|20)\d{2}|\b(1080|720|480|2160|4k)p?\b|S\d{1,2}E\d{1,2}/i.test(cleaned)) {
      return cleaned;
    }
  }

  // 2. Try URL pathname
  const url = urlResult.url;
  const pathSegments = url.pathname.split('/').filter(Boolean);
  if (pathSegments.length > 0) {
    const lastSegment = pathSegments[pathSegments.length - 1];
    // Check if it looks like a release name (has dots/spaces + year/quality)
    if (/(19|20)\d{2}|\b(1080|720|480|2160|4k)p?\b|S\d{1,2}E\d{1,2}/i.test(lastSegment)) {
      // Don't return .m3u8 segment files — they're playlist indices, not releases
      if (!/^index-|^master\.|^playlist\./i.test(lastSegment)) {
        return lastSegment;
      }
    }
    // Try second-to-last segment too (some CDNs put the filename there)
    if (pathSegments.length > 1) {
      const secondLast = pathSegments[pathSegments.length - 2];
      if (/(19|20)\d{2}|\b(1080|720|480|2160|4k)p?\b|S\d{1,2}E\d{1,2}/i.test(secondLast)) {
        if (!/^index-|^master\.|^playlist\./i.test(secondLast)) {
          return secondLast;
        }
      }
    }
  }

  // 3. Try meta.title — some sources embed release info in the title
  if (meta.title && typeof meta.title === 'string') {
    // Look for a pattern like "Movie.Title.2024.1080p.WEB-DL" in the title
    const titleMatch = meta.title.match(/([A-Za-z0-9][A-Za-z0-9._\-\s]+?\b(?:19|20)\d{2}\b[A-Za-z0-9._\-\s]*\b(?:1080|720|480|2160|4k)p?\b[A-Za-z0-9._\-\s]*)/i);
    if (titleMatch && titleMatch[1].length > 10 && titleMatch[1].length < 200) {
      return titleMatch[1].trim();
    }
  }

  return '';
}

// Parse metadata from stream title and URL when the source doesn't provide it.
// This enriches the display without modifying any source files or stream URLs.
// Only fills in MISSING fields — never overwrites existing meta values.
//
// Parsed fields (from the user's metadata spec):
//   - Quality: 2160p, 1080p, 720p, 480p
//   - Source Type: BluRay Remux, BluRay, WebDL, WebRip, HDRip
//   - Video Codecs: HEVC, x264, AVC, AV1
//   - Audio Codecs: TrueHD, Atmos, DD+, DD, DTS, AAC, AC3
//   - HDR: Dolby Vision, HDR10+, HDR
//   - Bit Depth: 10-bit, 8-bit
//   - Audio Language: hindi-english, english, hindi, etc.
//   - Size: 64.04GB, 17.5GB, etc.
//   - Release Group: FraMeSToR, ROEN-Ionicboy (after ~ or -)
// Exported for tests (test_audio_wiring.mjs) — additive, no behavior change.
export function enrichMeta(urlResult) {
  const meta = { ...urlResult.meta };
  const title = meta.title || '';
  const url = urlResult.url?.href || '';
  const titleLower = title.toLowerCase();
  const urlLower = url.toLowerCase();

  // 1. Parse height (Quality) from title if not in meta
  if (!meta.height) {
    if (/4k|2160p|uhd/i.test(title)) meta.height = 2160;
    else if (/1080p/i.test(title)) meta.height = 1080;
    else if (/720p/i.test(title)) meta.height = 720;
    else if (/480p/i.test(title)) meta.height = 480;
    else if (/360p/i.test(title)) meta.height = 360;
    else {
      const m = title.match(/(\d{3,4})p/i);
      if (m) meta.height = parseInt(m[1]);
    }
  }

  // 1b. If still no height, try parsing from URL path
  // Common patterns: /1080/, /720/, /480/, /hls3/01/0720, /quality=1080
  if (!meta.height) {
    const urlHeightMatch = urlLower.match(/\/(1080|720|480|360|2160)\b/);
    if (urlHeightMatch) meta.height = parseInt(urlHeightMatch[1]);
  }

  // 1c. If still no height and it's a video stream (HLS/MP4), default to 1080p
  // Most anime/movie HLS streams are 1080p — this ensures all sources show
  // a quality label in the enriched metadata.
  if (!meta.height && (urlResult.format === Format.hls || urlResult.format === Format.mp4 ||
      urlLower.includes('.m3u8') || urlLower.includes('/hls') || urlLower.includes('.mp4') || urlLower.includes('.mkv'))) {
    meta.height = 1080;
  }

  // 2. Parse video codec from title if not in meta
  if (!meta.codec && !meta.codecs) {
    if (/\bhevc\b|\bx265\b|\bh\.?265\b/i.test(title)) meta.codec = 'HEVC';
    else if (/\bx264\b|\bh264\b|\bavc\b/i.test(title)) meta.codec = 'AVC';
    else if (/\bav1\b/i.test(title)) meta.codec = 'AV1';
  }

  // 3. Parse source type from title (BluRay Remux, WebDL, etc.)
  if (!meta.sourceType) {
    if (/bluRay\s*remux|remux/i.test(title)) meta.sourceType = 'BluRay Remux';
    else if (/bluRay|bluray|bdrip/i.test(title)) meta.sourceType = 'BluRay';
    else if (/web\s*dl|web-dl|webdl/i.test(title)) meta.sourceType = 'WebDL';
    else if (/web\s*rip|webrip/i.test(title)) meta.sourceType = 'WebRip';
    else if (/hd\s*rip|hdrip/i.test(title)) meta.sourceType = 'HDRip';
    else if (/dvdrip/i.test(title)) meta.sourceType = 'DVDRip';
    else if (/cam|ts\s*rip|tsrip/i.test(title)) meta.sourceType = 'CAM';
    // Also catch "WEB" as a standalone word (e.g., "WEB h265", "NF WEB")
    // and "NF" (Netflix), "AMZN" (Amazon), "ATVP" (Apple TV+)
    else if (/\bWEB\b/i.test(title)) meta.sourceType = 'WebDL';
    else if (/\bNF\b/i.test(title)) meta.sourceType = 'WebDL';
    else if (/\bAMZN\b/i.test(title)) meta.sourceType = 'WebDL';
    else if (/\bATVP\b/i.test(title)) meta.sourceType = 'WebDL';
    else if (/\biTunes\b/i.test(title)) meta.sourceType = 'WebDL';
    // Provider indicators — when the stream comes from a known streaming
    // provider, the source type is WebDL (streaming-rip)
    else if (/Provider:\s*CDN|Provider:\s*m4uhd|Provider:\s*lamovie|Provider:\s*1movies|Provider:\s*superflix|Provider:\s*mb-flix/i.test(title)) meta.sourceType = 'WebDL';
    // HLS streams from speedracelight/VidEasy/VidKing — these are streaming rips
    else if (urlLower.includes('speedracelight') || urlLower.includes('ironwallnet') || urlLower.includes('vimeos')) meta.sourceType = 'WebDL';
    // Direct Google Drive / googleusercontent — typically WebDL rips
    else if (urlLower.includes('googleusercontent.com') || urlLower.includes('driveseed.org')) meta.sourceType = 'WebDL';
    // Cloudflare R2 / pub-*.r2.dev — typically WebDL rips (CineFreak, Movies4u)
    else if (urlLower.includes('.r2.dev') || urlLower.includes('.r2.cloudflarestorage.com')) meta.sourceType = 'WebDL';
    // streamraiwind.stream — HLS streaming rips (HDGharTV)
    else if (urlLower.includes('streamraiwind')) meta.sourceType = 'WebDL';
    // Workers.dev proxy URLs — streaming rips (ZXCStream, Pantyflix)
    // Also catch proxy URLs that wrap workers.dev URLs
    else if ((urlLower.includes('.workers.dev') || urlLower.includes('devcorp.me')) && !urlLower.includes('/proxy?')) meta.sourceType = 'WebDL';
    else if (urlLower.includes('workers.dev') && urlLower.includes('/proxy?')) meta.sourceType = 'WebDL';
    // HLS/MP4 from known streaming CDNs — these are streaming rips
    else if (urlLower.includes('mycdn-mb.xyz') || urlLower.includes('scalableimpactgroup') || urlLower.includes('strategicgrowthpartners') || urlLower.includes('fsharetv') || urlLower.includes('komiknostalgia') || urlLower.includes('dropcdn') || urlLower.includes('serversicuro') || urlLower.includes('gxplayer')) meta.sourceType = 'WebDL';
    // HubCloud CDN (4KHDHub pixel.hubcloud.cx) — typically WebDL
    else if (urlLower.includes('hubcloud.cx')) meta.sourceType = 'WebDL';
  }

  // 4. Parse audio codec from title
  if (!meta.audioCodec) {
    if (/truehd/i.test(title)) meta.audioCodec = 'TrueHD';
    else if (/atmos/i.test(title)) meta.audioCodec = 'Atmos';
    else if (/dd\+|ddp|eac3/i.test(title)) meta.audioCodec = 'DD+';
    else if (/\bdd\b|\bac3\b|dolby\s*digital\b/i.test(title)) meta.audioCodec = 'DD';
    else if (/\bdts\b/i.test(title)) meta.audioCodec = 'DTS';
    else if (/\baac\b/i.test(title)) meta.audioCodec = 'AAC';
  }

  // 5. Parse HDR info from title
  if (!meta.hdr) {
    if (/dolby\s*vision|\bdv\b/i.test(title)) meta.hdr = 'Dolby Vision';
    else if (/hdr10\+/i.test(title)) meta.hdr = 'HDR10+';
    else if (/\bhdr\b/i.test(title)) meta.hdr = 'HDR';
  }

  // 6. Parse bit depth from title
  if (!meta.bitDepth) {
    if (/10\s*bit|10bit|10-bit/i.test(title)) meta.bitDepth = '10-bit';
    else if (/8\s*bit|8bit|8-bit/i.test(title)) meta.bitDepth = '8-bit';
  }

  // 7. Parse file size from title if not in meta
  if (!meta.bytes) {
    // Match patterns like "6.7 GB", "900 MB", "1.2GB", "[410 MB]", "31.4GB"
    const sizeMatch = title.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
    if (sizeMatch) {
      const val = parseFloat(sizeMatch[1]);
      meta.bytes = sizeMatch[2].toUpperCase() === 'GB'
        ? val * 1024 * 1024 * 1024
        : val * 1024 * 1024;
    }
  }

  // 8. Parse release group from title (after ~ or at end in parentheses)
  if (!meta.releaseGroup) {
    // Pattern: "Title ~GroupName" or "Title (GroupName)" or "Title - GroupName"
    const tildeMatch = title.match(/~\s*([A-Za-z0-9._-]+)/);
    if (tildeMatch) {
      meta.releaseGroup = tildeMatch[1];
    } else {
      // Try parentheses at end: "Title (FraMeSToR-LUMiX)"
      const parenMatch = title.match(/\(([A-Za-z0-9._-]+)\)\s*\.?\s*$/);
      if (parenMatch) meta.releaseGroup = parenMatch[1];
    }
  }

  // 8a. Parse audio channels (5.1, 7.1, 2.0, etc.)
  if (!meta.audioChannels) {
    const chMatch = title.match(/\b(\d(?:\.\d)?)\s*(?:ch|channels?)\b/i)
      || title.match(/\b(\d(?:\.\d)?)\b(?=\s*(?:ddp|dd|truehd|dts|atmos|eac3|ac3))/i)
      || title.match(/(?:ddp|dd|truehd|dts|atmos|eac3|ac3)\s*(\d(?:\.\d)?)/i);
    if (chMatch) meta.audioChannels = chMatch[1];
  }

  // 8b. Parse streaming platform (NF, AMZN, ATVP, Hulu, Disney+, etc.)
  if (!meta.streamingPlatform) {
    if (/\bNF\b|\bNetflix\b/i.test(title)) meta.streamingPlatform = 'Netflix';
    else if (/\bAMZN\b|\bAmazon\b/i.test(title)) meta.streamingPlatform = 'Amazon';
    else if (/\bATVP\b|\bApple\s*TV/i.test(title)) meta.streamingPlatform = 'Apple TV+';
    else if (/\bHulu\b/i.test(title)) meta.streamingPlatform = 'Hulu';
    else if (/\bDisney/i.test(title)) meta.streamingPlatform = 'Disney+';
    else if (/\bHMAX\b|\bHBO\b/i.test(title)) meta.streamingPlatform = 'HBO Max';
    else if (/\bPCOK\b|\bPeacock\b/i.test(title)) meta.streamingPlatform = 'Peacock';
    else if (/\bSTAN\b/i.test(title)) meta.streamingPlatform = 'Stan';
    else if (/\bBCORE\b/i.test(title)) meta.streamingPlatform = 'BlueMAX';
    else if (/\bSHO\b/i.test(title)) meta.streamingPlatform = 'Showtime';
    else if (/\bSTARZ\b/i.test(title)) meta.streamingPlatform = 'Starz';
    else if (/\bMZKT\b|\bMax\b/i.test(title)) meta.streamingPlatform = 'Max';
  }

  // 8c. Parse special tags (PROPER, REPACK, UNCUT, UNCENSORED, REMASTERED, etc.)
  if (!meta.specialTags) {
    const tags = [];
    if (/\bPROPER\b/i.test(title)) tags.push('PROPER');
    if (/\bREPACK\b/i.test(title)) tags.push('REPACK');
    if (/\bUNCUT\b/i.test(title)) tags.push('UNCUT');
    if (/\bUNCENSORED\b/i.test(title)) tags.push('UNCENSORED');
    if (/\bREMASTERED\b/i.test(title)) tags.push('REMASTERED');
    if (/\bHYBRID\b/i.test(title)) tags.push('HYBRID');
    if (/\bDC\b|\bDIRECTOR.?S?\s*CUT\b/i.test(title)) tags.push('DC');
    if (/\bSE\b|\bSPECIAL\s*EDITION\b/i.test(title)) tags.push('SE');
    if (/\bEXTENDED\b/i.test(title)) tags.push('EXTENDED');
    if (/\bTHEATRICAL\b/i.test(title)) tags.push('THEATRICAL');
    if (/\bIMAX\b/i.test(title)) tags.push('IMAX');
    if (/\bCAM\b/i.test(title) && !/\bcam\s*rip/i.test(title)) tags.push('CAM');
    if (/\bSUBBED\b/i.test(title)) tags.push('SUBBED');
    if (/\bDUAL\b/i.test(title)) tags.push('DUAL');
    if (/\bMULTI\b/i.test(title)) tags.push('MULTI');
    if (tags.length > 0) meta.specialTags = tags.join(', ');
  }

  // 8d. Parse resolution label (UHD, HD, FHD, etc.)
  if (!meta.resolutionLabel) {
    if (/\bUHD\b/i.test(title)) meta.resolutionLabel = 'UHD';
    else if (/\bFHD\b/i.test(title)) meta.resolutionLabel = 'FHD';
    else if (/\bHD\b/i.test(title) && !/\bHDR\b/i.test(title)) meta.resolutionLabel = 'HD';
  }

  // 9. Infer format from URL if not set
  if (!urlResult.format || urlResult.format === Format.unknown) {
    if (urlLower.includes('.m3u8') || urlLower.includes('/m3u8/') ||
        urlLower.includes('/hls/') || urlLower.includes('/playlist/')) {
      urlResult.format = Format.hls;
    } else if (urlLower.includes('.mp4') || urlLower.includes('.mkv')) {
      urlResult.format = Format.mp4;
    }
  }

  // 10. Parse audio languages from title if countryCodes is minimal
  // Use word-boundary matching to avoid false positives (e.g., "rus" in "Icarus")
  if (!meta.countryCodes || meta.countryCodes.length <= 1) {
    const codes = new Set(meta.countryCodes || []);
    if (/\bhindi\b|\bhin\b/i.test(titleLower)) codes.add('hi');
    if (/\benglish\b|\beng\b/i.test(titleLower)) codes.add('en');
    if (/\bjapanese\b|\bjpn\b/i.test(titleLower)) codes.add('ja');
    if (/\bkorean\b|\bkor\b/i.test(titleLower)) codes.add('ko');
    if (/\bspanish\b|\besp\b/i.test(titleLower)) codes.add('es');
    if (/\bfrench\b|\bfra\b/i.test(titleLower)) codes.add('fr');
    if (/\btamil\b|\btam\b/i.test(titleLower)) codes.add('ta');
    if (/\btelugu\b|\btel\b/i.test(titleLower)) codes.add('te');
    if (/\bchinese\b|\bmandarin\b|\bchi\b/i.test(titleLower)) codes.add('zh');
    if (/\brussian\b|\brus\b/i.test(titleLower)) codes.add('ru');
    if (/\bgerman\b|\bger\b/i.test(titleLower)) codes.add('de');
    if (codes.size > 0) meta.countryCodes = [...codes];
  }

  // 11. Parse sub-source name from URL hostname
  // Skip if URL is a proxy URL (localhost or addon's own host)
  // Skip hash-like hostnames (e.g., da194e3e41011e58ea95b0914c6212d3.example.com)
  // Skip generic CDN prefixes (e.g., cdn, www, api)
  // Skip Cloudflare R2 bucket IDs (pub-XXXX.r2.dev)
  // Skip googleusercontent download hashes
  if (!meta.serverName && !meta.subSource) {
    try {
      const hostname = new URL(url).hostname;
      // Skip localhost/proxy URLs — they don't indicate the actual provider
      if (hostname !== 'localhost' && !hostname.includes('127.0.0.1') &&
          !urlLower.includes('/proxy?')) {
        const shortName = hostname.replace(/^www\./, '').split('.')[0];
        // Only use shortName if it's a meaningful provider name:
        // - Not a hash (hex strings longer than 12 chars)
        // - Not a Cloudflare R2 bucket ID (pub-XXXX)
        // - Not a googleusercontent download hash (ADGPM2...)
        // - Not a generic CDN/api prefix
        // - Not too short (<= 2 chars)
        // - Not the same as the source label
        const isHash = /^[a-f0-9]{12,}$/i.test(shortName);
        const isR2Bucket = /^pub-[a-f0-9]{8,}/i.test(shortName);
        const isGoogleHash = /^adgpm2/i.test(shortName);
        const isGeneric = ['cdn', 'api', 'www', 'static', 'media', 'video', 'stream', 'proxy'].includes(shortName.toLowerCase());
        const hasCdnInName = /cdn/i.test(shortName);
        // Skip random 3-letter worker subdomains (e.g., abc., ger., cvb. from
        // hindmoviez workers.dev URLs) — these are random and not meaningful
        const isRandomWorker = /^[a-z]{3}$/i.test(shortName) && hostname.endsWith('.workers.dev');
        if (shortName && shortName.length > 2 && !isHash && !isR2Bucket && !isGoogleHash && !isGeneric && !hasCdnInName && !isRandomWorker &&
            shortName.toLowerCase() !== meta.sourceLabel?.toLowerCase()) {
          meta.subSource = shortName.charAt(0).toUpperCase() + shortName.slice(1);
        }
      }
    } catch { /* not a valid URL */ }
  }

  urlResult.meta = meta;
  return urlResult;
}

export class StreamResolver {
  constructor(logger, extractorRegistry, fetcher) {
    this.logger = logger;
    this.extractorRegistry = extractorRegistry;
    this.fetcher = fetcher; // used by SubtitleFetcher for TMDB → IMDB lookup
    // Dedupe concurrent stream requests — Stremio sends 2-3 duplicate
    // requests for the same content in parallel. Without dedup, each
    // request runs all 85 sources simultaneously (3×85=255 concurrent
    // fetches), overwhelming Render's single CPU and causing sources to
    // timeout/error. With dedup, the 2nd/3rd request waits for the 1st
    // to complete and reuses its result.
    this.inFlight = new Map();
  }

  async resolve(ctx, sources, type, id) {
    if (sources.length === 0) {
      return { streams: [{ name: 'PhoeniX', title: '⚠️ No sources found', externalUrl: ctx.hostUrl.href }] };
    }

    // Dedup key: type + id + season + episode (so S1E1 and S2E1 don't collide)
    const dedupKey = `${type}:${id.id || id}${id.season ? `:S${id.season}:E${id.episode || 1}` : ''}`;
    const existing = this.inFlight.get(dedupKey);
    if (existing) {
      this.logger.info(`StreamResolver: dedup hit for ${dedupKey}, reusing in-flight request`);
      return existing;
    }

    const promise = this._resolveInternal(ctx, sources, type, id);
    this.inFlight.set(dedupKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(dedupKey);
    }
  }

  async _resolveInternal(ctx, sources, type, id) {
    const resolveT0 = Date.now();

    // Task 49: fire the unified subtitle fetch (granite + natsuki) IN PARALLEL
    // with the source resolves — zero added latency. By the time sources
    // settle (or the budget expires) the set is usually already resolved and
    // cached (6h in-module cache), so EVERY response path — full, partial,
    // cold, warm — attaches the same subtitle providers to every card.
    // Task 62: granite+natsuki are TMDB-NUMERIC keyed. The raw Stremio id is
    // IMDb ("tt...") and granite answers tt-strings with an empty set
    // (verified live: /v1/tv/tt0903747/1/1 → 200 [], /v1/tv/1396/1/1 → 48
    // tracks) — every Stremio-requested title silently lost its universal
    // subs once natsuki's series path degraded. Convert the IMDb id to the
    // numeric TMDB id once here (module-level cache shared with the source
    // resolves) and pass BOTH ids: numeric for granite, imdb for the natsuki
    // wrong-content guard.
    let subsTmdbId = typeof id === 'object' ? id.id : id;
    const subsImdbId = (typeof id === 'object' && /^tt\d+$/i.test(String(id.id || ''))) ? id.id : null;
    if (subsImdbId) {
      try {
        const { getTmdbIdFromImdbId } = await import('./tmdb.js');
        const converted = await getTmdbIdFromImdbId(this.fetcher, ctx, { id: subsImdbId, season: id.season, episode: id.episode });
        if (converted && converted.id) subsTmdbId = converted.id;
      } catch { /* no TMDB mapping — granite returns [] then; natsuki still queried with the imdb id */ }
    }
    const subsState = { settled: false, value: [] };
    const unifiedSubsP = fetchUnifiedSubs({
      tmdbId: subsTmdbId,
      imdbId: subsImdbId,
      type,
      season: typeof id === 'object' ? id.season : undefined,
      episode: typeof id === 'object' ? id.episode : undefined,
      hostUrl: ctx.hostUrl,
      // Task 49 production finding: route upstream calls through the addon's
      // Fetcher (family:4, node-level timeout) — bare undici fetch hangs on
      // Render storm windows past AbortSignal deadlines (DNS lookup class).
      fetcher: this.fetcher,
      ctx,
    });
    unifiedSubsP
      .then(v => { subsState.settled = true; subsState.value = Array.isArray(v) ? v : []; })
      .catch(() => { subsState.settled = true; subsState.value = []; });

    const streams = [];
    const urlResults = [];
    let sourceErrorCount = 0;

    // Per-source timing data — exposed via /debug/stream for diagnostics.
    // Helps identify which sources are slow or failing under load.
    const sourceTimings = [];

    const SOURCE_TIMEOUT_MS = 35_000;
    // Task 56: EXACT timeout parity with the true original repo —
    // github.com/SaugatXthaa/PhoeniX (user-confirmed). The original is flat:
    // every source races the same SOURCE_TIMEOUT_MS (35s), movies and series
    // alike, with NO per-provider table and NO per-source extensions. Our
    // earlier Task 53b "little more timeout" 45s extras are REMOVED — under
    // the restored 40s global cutoff (see CLIENT_BUDGET_MS below) any cap
    // above 40s could never land in the first response anyway, and the user
    // has explicitly re-demanded EXACT original values. Env overrides are
    // kept (opt-in only, no behavior change while unset):
    //   HTTP_STREAMING_TIMEOUT_MS_<SOURCE_ID>  (per source, wins)
    //   HTTP_STREAMING_TIMEOUT_MS              (global)
    const parseTimeoutOverride = (v) => {
      if (v == null || v === '') return null;
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const sourceTimeoutMs = (sourceId) => {
      const envKey = 'HTTP_STREAMING_TIMEOUT_MS_' + String(sourceId).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toUpperCase();
      return parseTimeoutOverride(process.env[envKey])
          ?? parseTimeoutOverride(process.env.HTTP_STREAMING_TIMEOUT_MS)
          ?? SOURCE_TIMEOUT_MS;
    };
    // Limit concurrency to prevent CPU starvation on Render's free tier.
    // Without this, all 85+ sources fire simultaneously, causing CPU-intensive
    // sources (Cinejoy's lumen-gate-v1 crypto, ZinkMovies, etc.) to take 30s+
    // and hit the SOURCE_TIMEOUT.
    //
    // IMPORTANT: queue time counts against the source timeout. If a source waits
    // 15s in the queue, it only has 15s left to run before timing out. With a
    // limit of 15 (down from 20), sources wait less time in the queue, giving
    // them more actual execution time. Cinejoy needs ~6s of actual execution,
    // so a 15s limit gives it ~15s of slack for queue + execution.
    // Task 56: restored to 15 — the EXACT original value. The Task 37
    // reduction to 10 was tuned FOR the old 13s client budget (concentrate
    // CPU so more sources land in-window). With the original's 40s global
    // cutoff restored, throughput-per-window matters more than per-source
    // latency: 15 slots let all 70+ sources actually run INSIDE the request
    // instead of draining into a background tail that multi-instance Render
    // free-tier deployments never see again (memory caches are per-instance,
    // so background-cached results were frequently lost on the next refresh —
    // the real root cause of "source shows nothing until refresh 4-5").
    const MAX_CONCURRENT_SOURCES = 15;

    // ─── THREE-WAVE SCHEDULING (Task 43 — data-driven, production-measured)
    //
    // Symptom (user report): "only 7-8 sources show streams, others show
    // none". Root cause measured on production (isolated /debug/source runs,
    // Sep 2026): the old single PRIORITY set held 23 sources — many of them
    // slow or zero-yield (stellarrip content drought 22s/0, cinejoyaio
    // crypto 0, anineko DB outage, nikastream 20-30s) — while genuinely fast
    // productive sources (raflix 7@2.1s, cinewave 46@1.5s, hdhub4uv2 6@4.1s,
    // movieshuntv2 5@10.1s) queued BEHIND all of them and never started
    // within the 15s client budget. Cold request settled only ~11 sources,
    // half of them 0-yield.
    //
    // Fix: three waves, ordered by MEASURED cold productivity:
    //   wave 0 (race-critical): fast (<8s) + productive — occupy the 10 slots
    //     first, settle 3-12s, land in the cold response.
    //   wave 1 (medium): 8-16s sources — start as wave-0 slots free; some
    //     land cold, the rest complete in background and cache (5min TTL).
    //   wave 2 (background-only): slow (>budget), Playwright, PoW-heavy, or
    //     known-dead upstreams — they never landed cold anyway; starting them
    //     last frees race slots. Results still cache for warm requests.
    // Anime-only sources are type-aware: wave 1 for series (primary anime
    // deliverers), wave 2 for movies (anime movies are covered by the
    // general wave-0/1 sources — 4khdhub/cineby/streamxtv/hdhub4u verified).
    //
    // NOTE: final card order is independent of this sort (urlResults are
    // re-sorted by height/bytes/priority before the build loop).
    // ORDER WITHIN WAVE 0 MATTERS: only 10 slots exist; light sources (1-3s)
    // must start first so slots churn and the next sources start early.
    // Task 66 A/B vs the original repo DISPROVED the "heavy aggregator holds
    // a slot 12s+" label: cinewave measured cold 46 cards @1.5s isolated (its
    // pixeldrain finals are instant HEADs). cinewave/watchseries/necro now sit
    // at the FRONT (positions 7-9) — see the Task 66 comment at 'cinewave'.
    // This is an ORDERED array — the resolver starts these sources in exactly
    // this sequence (index becomes the sort rank; wave 1 = 100, wave 2 = 200).
    const WAVE1_SOURCE_ORDER = [
      // light embed/API sources — measured 1-3s fresh, free slots fast
      'moviebox',      // 1 @2.7s local fresh
      'vidlink2',      // 3 @3.1s local fresh
      'vidfast',       // 4 @~2s
      'vidking',       // 4 @~2s
      'vidsrcsbs',     // 3 @~2s
      'vegamovies',    // 4 @~2s
      // Task 66: cinewave/watchseries/necro moved UP from the wave-0 tail.
      // The "heavy aggregator" label was wrong for cinewave — measured cold
      // 46 cards @1.5s isolated (its pixeldrain finals are instant HEADs; the
      // 12s+ slot-hold claim came from warm-cache A/B noise). Production
      // proof (Render 0.1-CPU cold boot, Dune tt1160419): wave-0-last start
      // queued it behind 25 sources and it MISSED the 40s budget (10-card r1)
      // while the original repo — which starts it 3rd in registry order —
      // lands it on one refresh. r2 it delivered 28@17.8s. Fast-productive
      // sources belong at the FRONT of the wave on a starved CPU.
      'cinewave',      // 28-46 @1.5-17.8s — orig starts it ~3rd
      'watchseries',   // 11 @3.1s production-measured
      'necro',         // 5
      // Task 59: bollyflix promoted (index 16 → 7). Measured fast + 4K-
      // capable (5 cards @3.6-7.5s isolated incl 2160p), but its gdflix
      // mfile chain runs 26-32s under merged contention — starting it
      // behind 15 earlier wave-0 entries queued it 6.9s and pushed the
      // chain past the 35s per-source cap on true-cold r1 (zero cards).
      // Early start = full 35s headroom, and satisfies the up-to-4K
      // start-priority requirement.
      'bollyflix',     // 5-6 @3.6-7.5s fresh, chain 26-32s under load
      // Task 53: user-reported missing sources — promoted from wave-2 to the
      // FRONT of the medium group (right after the 0-3s embed/API sources so
      // their slots free immediately). Isolated fresh: moviesdrivev2 4 @6.5s,
      // uhdmovies 1 @6.7s, movieshuntv2 5 @10.1s — starting at ~2-4s lands
      // them ~9-14s, INSIDE the 15s budget, for movies AND series (series
      // slots are held 9-15s by slow chains, so late positions never started).
      'moviesdrivev2', // 4 @6.5s fresh (8-hop chain) — original MoviesDrive 25s
      'uhdmovies',     // 6.7s+ multi-hop — original UHDMOVIES 12s
      'movieshuntv2',  // 5 @10.1s (abhilinks→hubcloud/gdflix chains)
      // proven cold landers in production 15s races (must not regress)
      '4khdhub',       // 6 @3.1s local fresh
      'fourkhdhubone', // 6
      'playimdb',      // 3 @1.6s local fresh
      'cineby',        // 11 @7.2s local fresh
      'hdhub4uv2',     // 6 @4.1s production isolated (user-reported source)
      'acermovies',    // 3 @2.1s local fresh
      'hindmovie',     // 1 @4.4s
      // Task 46: 4K-capable cold landers (both ship 2160p; movies + series)
      // get wave-0 start priority per user requirement "prioritize up-to-4K
      // sources" — cinefreak measured fresh 6 @3.3-4.6s (2160p after the
      // 4K-first resolve fix); bollyflix MOVED UP to index 7 (Task 59).
      'cinefreak',     // 6 @3.3-4.6s cold incl 2160p
      // Task 47: cinejoyaio FIXED (api.shegu.st→api.wing.st + rotated-wasm
      // refresh + payload contract) — now ~2s cold with Lisbon 2160p (4K) on
      // movies AND series ( Breaking Bad S1E1 verified), 3/3 cards probe
      // alive. 4K-capable + fast → wave-0 per the up-to-4K priority.
      'cinejoyaio',    // 3 @2.0s cold incl 2160p (Lisbon)
      // Task 48: atlantic.st — Aphrodite (signed 4K) + Artemis (Orbit 2160p
      // multi-audio / Nova muxed) + granite/natsuki subs, cards live-validated.
      // Measured 2.5-3.2s cold (Inception/Dune2 2160p, Frieren S1E1 1080p).
      // 4K-capable + fast → wave-0 4K group.
      'atlantic',      // 1-4 @2.5-3.2s cold incl 2160p (Orbit/Aphrodite)
      'primeshows',    // 6 @4.0s
      'meinecloud',    // 4 @3.8s
      'raflix',        // 7 @2.1s production isolated
      'videasy',       // 6 (proven cold lander, slower fresh)
      // Task 66: cinewave/watchseries/necro PROMOTED to the wave-0 front
      // (see comment at vegamovies) — the tail slot starved them on cold
      // 0.1-CPU resolves. Entries kept here as documentation anchors only.
    ];
    const WAVE2_SOURCE_IDS = new Set([
      // measured 8-16s solo — partial cold landing, rest cached in background
      // (Task 53: movieshuntv2/moviesdrivev2/uhdmovies PROMOTED to wave-0 —
      // user-reported missing; see WAVE1_SOURCE_ORDER)
      'streamxtv',     // 4-5
      'stellar', 'vegamovies2',   // uhdmovies: promoted (6.7s+ multi-hop, 4K group)
      // Task 59: desiflix promoted BACKGROUND_ONLY → wave 2 (medium). Its
      // manifest.desitvhub aggregation chain measures 23-32s — the restored
      // 40s client budget (Task 56) means it now lands IN-request on cold
      // resolves instead of only via the background tail (whose per-instance
      // cache a multi-instance Render deployment often never sees again).
      'desiflix',
      'hindmoviez', 'cinebyrocks', 'nowhdtime', 'zxcstream',
      'imdbplay', 'framextv',
      'vixsrc', 'kmmovies', 'vidzee', 'pantyflix', 'peckle',
      'netlio', 'rivestream', 'cinehdplus',
      // Task 61: persianstremio promoted BACKGROUND_ONLY → wave 2 — same
      // class and same evidence standard as desiflix above. Isolated fresh
      // measurement: 21 cards @11.3s for Inception (persianstremio.vercel.app
      // aggregation chain) — comfortably inside the 40s client budget, but as
      // a background-only source it ran AFTER the budget expired, so on the
      // multi-instance Render deployment its background cache was routinely
      // invisible to the next request → registered yet never visible. Wave-2
      // start (~13s queue) + 11.3s chain lands it IN-request.
      'persianstremio',
    ]);
    const BACKGROUND_ONLY_SOURCE_IDS = new Set([
      // never land within the 15s budget (measured) or known-dead upstreams;
      // run last so their slots don't starve the race — results still cache
      'stellarrip',     // PoW 22.8s + upstream content drought
      // cinejoyaio REMOVED Task 47: fixed upstream migration (api.wing.st),
      // measured ~2s cold with 2160p — promoted to wave-0 (WAVE1_SOURCE_ORDER)
      // desiflix REMOVED Task 59: promoted to wave-2 (measured 23-32s, lands
      // in-request under the 40s client budget)
      // persianstremio REMOVED Task 61: promoted to wave-2 (measured 21 cards
      // @11.3s isolated — inside the 40s budget, was invisible as background-only)
      'videasyto',      // Playwright headless 30-60s
      'verhdlink', 'movix',
    ]);
    const ANIME_ONLY_SOURCE_IDS = new Set([
      'animeflix', 'anineko', 'anikoto', 'anikage', 'anibd', '2dhive',
      'anidoor', 'animegg', 'hianime', 'animekai', 'animesdigital',
      'itachi', 'anikototv', 'animezey', 'animotvslash',
      'allwish', 'animesuge', 'reanime', 'nikastream', 'anichan',
      // animeworldindia REMOVED Task 68: source now serves movies too
      // (anime movies on watchanimeworld.one) and resolves in ~5-8s measured
      // — unclassified placement (wave 100) lands both types in-request.
    ]);
    // Task 69: anime-only sources are episode-scrapers — on MOVIE requests
    // they are guaranteed zero-yield (production-measured: all 21 returned 0
    // on every probed movie while queuing 26-39s behind the real sources).
    // Each useless scrape burns a concurrency slot AND, after budget expiry,
    // clogs the background tail that warms the cache for the NEXT title —
    // the direct cause of "next movie opens with 3-5 streams". Skip them
    // entirely for movies. Series behavior is unchanged (anime sources are
    // the primary deliverers there). Env escape hatch kept for diagnostics.
    const ANIME_SOURCES_ON_MOVIES = process.env.ANIME_SOURCES_ON_MOVIES === '1';
    const isScheduled = (source, requestType) =>
      ANIME_SOURCES_ON_MOVIES || requestType !== 'movie' || !ANIME_ONLY_SOURCE_IDS.has(source.id);
    const waveOf = (sourceId, requestType) => {
      const w1 = WAVE1_SOURCE_ORDER.indexOf(sourceId);
      if (w1 !== -1) return w1; // 0..19 — exact start order within wave 0
      if (ANIME_ONLY_SOURCE_IDS.has(sourceId)) return requestType === 'series' ? 100 : 200;
      if (WAVE2_SOURCE_IDS.has(sourceId)) return 100;
      if (BACKGROUND_ONLY_SOURCE_IDS.has(sourceId)) return 200;
      return 100; // unclassified future sources: medium — get a chance, never starve wave-0
    };
    const sortedSources = [...sources].sort(
      (a, b) => waveOf(a.id, type) - waveOf(b.id, type)
    ).filter(s => isScheduled(s, type));
    const skippedAnimeCount = sources.length - sortedSources.length;
    if (skippedAnimeCount > 0) {
      this.logger.info(`StreamResolver: skipped ${skippedAnimeCount} anime-only sources (movie request)`);
    }

    let activeCount = 0;
    const waitQueue = [];

    // ─── Task 54: PLAYBACK PRIORITY for the background tail ───
    // When the client budget expires, sources that missed it keep resolving
    // in the background and cache for the next request. On the 0.1-CPU Render
    // instance that tail previously ran at the SAME concurrency as the
    // in-budget race (10 chains) and monopolized the event loop for
    // minutes-class chains — the player's /proxy playlist/segment requests
    // then queued behind scraping and EVERY source appeared "stuck on the
    // loading screen" (Task 54 production proof: /proxy 0 bytes in 20s during
    // churn vs 200 + 653KB in 1.08s once idle). Fix, two parts:
    //   1. After the budget, background starts wait for a QUIET playback gate
    //      (no in-flight /proxy or /range-proxy request) before beginning new
    //      upstream work — bounded so long playback sessions still let the
    //      tail progress at reduced concurrency instead of starving forever.
    //   2. The effective concurrency cap drops once the budget expires —
    //      in-flight sources finish naturally (no cancellation), only NEW
    //      starts are held back.
    // In-budget (client-facing) resolves are NEVER gated.
    let budgetExpired = false;
    // Task 69: default 2 → 4. The tail is what fills the per-source caches
    // between refreshes; at 2 concurrent a 25-source tail needed 3-4 minutes,
    // so refreshes kept surfacing partially-warm sets ("need 4-5 refreshes")
    // and a tail still draining from the PREVIOUS title starved the next
    // title's resolve. The Task 54 playback gate is untouched — starts still
    // yield to /proxy + /range-proxy traffic — so playback stays protected.
    const BACKGROUND_MAX_CONCURRENT = Math.max(1, parseInt(process.env.STREAM_BACKGROUND_MAX_CONCURRENT, 10) || 4);
    const BACKGROUND_PLAYBACK_MAX_WAIT_MS = Math.max(10000, parseInt(process.env.STREAM_BACKGROUND_PLAYBACK_MAX_WAIT_MS, 10) || 45000);
    const effectiveCap = () => (budgetExpired ? Math.min(BACKGROUND_MAX_CONCURRENT, MAX_CONCURRENT_SOURCES) : MAX_CONCURRENT_SOURCES);

    const withTimeout = (promise, ms, sourceId) => {
      let timer;
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`source ${sourceId} timed out after ${ms}ms`)), ms);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };

    const handleSource = async (source) => {
      // Concurrency gate: wait if too many sources are already running
      const queueStart = Date.now();
      if (activeCount >= effectiveCap()) {
        await new Promise(resolve => waitQueue.push(resolve));
      }
      // Task 54: post-budget starts additionally wait out active playback
      // (bounded). Holding this AFTER the slot wait keeps queue order stable:
      // the released slot is taken by this source, which then yields the CPU
      // to playback before firing its first upstream fetch.
      if (budgetExpired) {
        await playbackGate.quiet(BACKGROUND_PLAYBACK_MAX_WAIT_MS);
      }
      const queueTime = Date.now() - queueStart;
      activeCount++;

      const start = Date.now();
      let status = 'ok';
      let resultCount = 0;
      try {
        const sourceResults = await withTimeout(source.handle(ctx, type, id), sourceTimeoutMs(source.id, type), source.id);
        resultCount = sourceResults.length;
        this.logger.info(`Source ${source.id} returned ${sourceResults.length} results`);
        const sourceUrlResults = await Promise.all(
          sourceResults.map(({ url, meta, requestHeaders }) =>
            this.extractorRegistry.handle(ctx, url, { sourceLabel: source.label, sourceId: source.id, priority: source.priority, ...(requestHeaders && { requestHeaders }), ...meta }, true)
              .catch(e => {
                const msg = e?.message || e?.constructor?.name || String(e);
                this.logger.warn(`Extractor for ${source.id} ${url.href} error: ${msg}`);
                return [];
              })
          )
        );
        const flatResults = sourceUrlResults.flat();
        urlResults.push(...flatResults);
        // Task 42: fire-and-forget liveness probes for gated hosts
        // (pixeldrain files that are zips/decoys, vimeos.* 403-HTML fronts,
        // peakstorm/vidbolt dead-tree playlists, nexabloom/nhdapi html pages).
        // Probes run while OTHER sources are still resolving, so verdicts are
        // usually cached by the time the card-build loop consults them.
        // gateHostOf unwraps /proxy|/range-proxy cards to their INNER host.
        for (const r of flatResults) {
          if (r?.url) {
            const effHost = streamGate.gateHostOf(r.url.href);
            if (effHost && streamGate.isGatedHost(effHost)) streamGate.kick(r.url.href);
          }
        }
      } catch (error) {
        status = error?.message?.includes('timed out') ? 'timeout' : 'error';
        sourceErrorCount++;
        const msg = error?.message || error?.constructor?.name || String(error);
        this.logger.warn(`Source ${source.id} error: ${msg}`);
      } finally {
        const duration = Date.now() - start;
        sourceTimings.push({
          id: source.id,
          status,
          count: resultCount,
          durationMs: duration,
          queueMs: queueTime,
        });
        activeCount--;
        // Start next waiting source if any
        const next = waitQueue.shift();
        if (next) next();
      }
    };

    // CLIENT BUDGET — respond to the HTTP request as soon as this budget
    // expires, even while sources are still resolving. Production evidence
    // (Render 0.1-CPU, /debug/source isolation runs vs 70-source concurrent
    // runs, Sep 2026): stellarrip 5 cards isolated vs 0 concurrent, hindmoviez
    // 4 vs 0, moviesdrivev2 3 vs 0-3 — and total resolve wall time 33s+,
    // which is BEYOND Stremio's client patience (~20s). Cold requests were
    // timing out client-side and the user saw ZERO streams even when sources
    // could deliver. Fix: return partial results at the budget; sources that
    // are still running keep going in the BACKGROUND and their results land
    // in the per-source caches (Source.handle, 5min TTL), so the NEXT request
    // for the same id returns a much fuller set well within the budget.
    // Task 56: CLIENT BUDGET = the ORIGINAL repo's GLOBAL_TIMEOUT_MS (40s),
    // verbatim. The user has repeatedly demanded exact global-timeout parity
    // with github.com/SaugatXthaa/PhoeniX, whose resolve ends with:
    //   await Promise.race([Promise.all(sources), timeout(GLOBAL_TIMEOUT_MS=40s)])
    // — i.e. the HTTP response WAITS for every source (each capped at 35s)
    // and only cuts at 40s. Our 13s partial+background-continuation contract
    // assumed the background tail would cache results for the next refresh,
    // but on Render free tier the service routinely runs MORE THAN ONE
    // instance with per-instance memory caches — the next refresh hits a
    // DIFFERENT instance, the cached tail is invisible, and slow sources
    // (hdhub4u 35s+, 4khdhub under contention) appeared as "stuck on loading
    // / zero streams" no matter how many times the user refreshed. Waiting
    // for sources inside the request (like the original) is the only
    // multi-instance-correct architecture. The background tail is KEPT (it
    // is strictly better than the original's hard cut for sources exceeding
    // 40s) and the Task 54 playback-priority gate stays armed for it.
    const CLIENT_BUDGET_MS = Math.max(5000, parseInt(process.env.STREAM_CLIENT_BUDGET_MS, 10) || 40000);

    // Track how many sources have fully settled (scrape + extractor stage).
    let settledCount = 0;
    const allSourcePromises = sortedSources.map(s =>
      handleSource(s).finally(() => { settledCount++; })
    );

    // Task 69: EARLY SHIP. The response used to wait the FULL client budget
    // (40s) whenever even 1-3 stragglers were still resolving — production
    // measured 40.3s, 42.8s, 43.8s, 45.4s per round, every round, because
    // slow chains (uhdmovies 36s timeout class) held the resolve to the wire
    // while the user stared at a loading screen. New contract: after
    // STREAM_EARLY_SHIP_AFTER_MS (20s), if only ≤ STREAM_EARLY_SHIP_MAX_REMAINING
    // sources are still outstanding, ship what we have NOW; the stragglers
    // keep resolving in the background (existing machinery) and land in the
    // per-source caches for the next refresh. The 40s budget stays as the
    // absolute cap (original-parity), and warm resolves still return the
    // instant everything settles. Net effect: rounds drop from 40-45s to
    // ~20-25s and the full set converges in 1-2 fast refreshes instead of
    // 4-5 slow ones.
    const EARLY_SHIP_AFTER_MS = Math.max(0, parseInt(process.env.STREAM_EARLY_SHIP_AFTER_MS, 10) || 20000);
    const EARLY_SHIP_MAX_REMAINING = Math.max(0, parseInt(process.env.STREAM_EARLY_SHIP_MAX_REMAINING, 10) || 10);
    let earlyShipFired = false;
    const allSettled = await new Promise(resolve => {
      const raceT0 = Date.now();
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearInterval(poll); resolve(v); } };
      const poll = setInterval(() => {
        if (settledCount >= sortedSources.length) return finish(true);
        const elapsed = Date.now() - raceT0;
        if (elapsed >= CLIENT_BUDGET_MS) return finish(false);
        if (EARLY_SHIP_AFTER_MS > 0 && elapsed >= EARLY_SHIP_AFTER_MS &&
            (sortedSources.length - settledCount) <= EARLY_SHIP_MAX_REMAINING) {
          earlyShipFired = true;
          this.logger.info(`StreamResolver: early ship at ${elapsed}ms — ${sortedSources.length - settledCount} stragglers (≤${EARLY_SHIP_MAX_REMAINING}) keep resolving in background`);
          return finish(false);
        }
      }, 250);
    });
    this._lastEarlyShip = { fired: earlyShipFired, afterMs: EARLY_SHIP_AFTER_MS, maxRemaining: EARLY_SHIP_MAX_REMAINING };

    // Task 54: flip the background-tail switch the moment the budget expires —
    // queued sources now start at BACKGROUND_MAX_CONCURRENT and only between
    // quiet playback-gate windows (see handleSource above).
    if (!allSettled) budgetExpired = true;

    // When the budget expired first, the remaining allSourcePromises are
    // deliberately NOT awaited here — they keep executing (node does not
    // cancel promises), each completing handleSource's catch/finally and
    // caching via Source.handle. Same background behavior the old 40s
    // GLOBAL_TIMEOUT cutoff had, except the client now gets a response at
    // the budget instead of at 33-48s.

    // Stash timings on the instance for the /debug/stream endpoint to read.
    // (Not returned in the normal /stream response to avoid breaking Stremio.)
    this._lastSourceTimings = sourceTimings;
    this._lastResolveWasPartial = !allSettled;
    this._clientBudgetMs = CLIENT_BUDGET_MS;
    if (!allSettled) {
      this.logger.info(`StreamResolver: ${earlyShipFired ? 'early ship' : `client budget ${CLIENT_BUDGET_MS}ms hit`} (${settledCount}/${sortedSources.length} sources settled, ${urlResults.length} urlResults) — returning partial results; remaining sources complete in background and will be cached for the next request`);
    }

    // Task 42: give fire-and-forget gated-host probes a short settle window.
    // On cache-hit requests every source resolves instantly, so probes kicked
    // in the same tick would never land before the card-build loop consults
    // verdicts — gated-dead cards (vimeos 403-html, nexabloom, zips, dead
    // trees) would ship on EVERY warm request. Bounded: max 3s and never past
    // the client budget (the partial contract stays intact).
    if (streamGate.pendingCount() > 0) {
      const remainingBudget = CLIENT_BUDGET_MS - (Date.now() - resolveT0);
      const waitMs = Math.max(0, Math.min(3000, remainingBudget - 1500));
      if (waitMs > 0) {
        await Promise.race([
          streamGate.pendingSettled(),
          new Promise(resolve => setTimeout(resolve, waitMs)),
        ]);
      }
    }

    // Enrich metadata for all results (parse from title/URL — no source changes)
    for (const r of urlResults) {
      if (!r.error) enrichMeta(r);
    }

    // ─── Universal Subtitle Injection ───────────────────────────────────
    // For streams that DON'T have subtitles from their own source (most
    // movie/TV sources — anime sources like NikaStream/AnimeSuge already
    // return subtitles via meta.subtitles), fetch subtitles from
    // OpenSubtitles by TMDB ID + season + episode.
    //
    // SYNC STRATEGY:
    //   1. If a stream has a recognizable release name (from meta.filename
    //      or the URL), query OpenSubtitles with `moviereleasename` →
    //      subtitles match the EXACT release → perfect sync.
    //   2. If no release name, fall back to IMDB-only search → subtitles
    //      match the movie/show but may be for a different release →
    //      quality scoring (FPS, encoding, rating) picks the best.
    //   3. Source-provided subtitles (NikaStream, AnimeSuge, etc.) are
    //      always preferred — they come from the same source as the video.
    //
    // This is BEST-EFFORT — if OpenSubtitles fails (timeout, rate limit,
    // no result), streams are returned WITHOUT subtitles. Never breaks
    // stream playback.
    // Skip OpenSubtitles on the partial (budget-expired) path — subs are
    // best-effort and the 9s lookup would blow the budget promise to the
    // client. Also skip when everything settled LATE in the budget window
    // (sandbox evidence: all-70 settled at ~14.9s → full path → +9s subs →
    // 29s response, beyond client patience). Warm resolves that settle
    // comfortably early still get the full subtitle injection.
    if (allSettled && (Date.now() - resolveT0) < CLIENT_BUDGET_MS - 2000) {
    // Task 53: the 9s OpenSubtitles races below used to run UNBOUNDED inside
    // this block. Production evidence (Sep 2026): warm all-settled responses
    // measured 19-22s — past Stremio's ~20s client patience — so the user saw
    // "no streams" on refresh after refresh even though the sources had
    // delivered. Subtitles are best-effort; the client budget is a promise.
    // Bound the whole phase to the remaining budget (floor 500ms).
    const SUBS_PHASE_DEADLINE_MS = Math.max(500, CLIENT_BUDGET_MS - 1500 - (Date.now() - resolveT0));
    try {
      // Identify streams that need OpenSubtitles fallback
      const streamsNeedingSubs = urlResults.filter(r =>
        !r.error && !r.meta?.subtitles && r.url && typeof r.url === 'object'
      );

      if (streamsNeedingSubs.length > 0) {
        // Extract release names and group streams
        // Key: releaseName (or "" for IMDB-only fallback)
        // Value: array of urlResult objects
        const groups = new Map();
        for (const r of streamsNeedingSubs) {
          const releaseName = extractReleaseNameFromStream(r);
          const key = releaseName || '';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(r);
        }

        // Cap the number of distinct release-name lookups to prevent
        // OpenSubtitles API abuse. If there are more than 5 distinct
        // release names, only the 5 most common are fetched; the rest
        // fall back to IMDB-only (key="").
        const MAX_RELEASE_LOOKUPS = 5;
        const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
        const releaseGroups = sortedGroups.filter(([k]) => k !== '').slice(0, MAX_RELEASE_LOOKUPS);
        const imdbOnlyGroup = groups.get('') || [];

        // If we exceeded the cap, move excess release groups to IMDB-only
        if (sortedGroups.filter(([k]) => k !== '').length > MAX_RELEASE_LOOKUPS) {
          for (const [k, rs] of sortedGroups.filter(([k]) => k !== '').slice(MAX_RELEASE_LOOKUPS)) {
            imdbOnlyGroup.push(...rs);
          }
        }

        // Fetch subtitles for each group IN PARALLEL with a 9s global timeout.
        // Each SubtitleFetcher call is cached, so repeated release names
        // across different movies don't re-fetch.
        const fetchTasks = [];

        // IMDB-only fallback (no release name)
        if (imdbOnlyGroup.length > 0) {
          fetchTasks.push(
            Promise.race([
              SubtitleFetcher.fetchByTmdbId(
                this.fetcher, ctx,
                typeof id === 'object' ? id.id : id,
                type,
                typeof id === 'object' ? id.season : undefined,
                typeof id === 'object' ? id.episode : undefined,
              ),
              new Promise(resolve => setTimeout(() => resolve([]), 9000)),
            ]).then(subs => ({ key: '', subs: Array.isArray(subs) ? subs : [] }))
          );
        }

        // Per-release-name lookups
        for (const [releaseName] of releaseGroups) {
          fetchTasks.push(
            Promise.race([
              SubtitleFetcher.fetchByTmdbId(
                this.fetcher, ctx,
                typeof id === 'object' ? id.id : id,
                type,
                typeof id === 'object' ? id.season : undefined,
                typeof id === 'object' ? id.episode : undefined,
                releaseName,
              ),
              new Promise(resolve => setTimeout(() => resolve([]), 9000)),
            ]).then(subs => ({ key: releaseName, subs: Array.isArray(subs) ? subs : [] }))
          );
        }

        // Task 53: race the whole lookup batch against the remaining client
        // budget — on deadline, ship WITHOUT subs instead of overshooting the
        // response past Stremio's patience. Deadline → empty batch; the attach
        // loop below no-ops on it (every entry filtered by subs.length === 0).
        const results = await Promise.race([
          Promise.all(fetchTasks),
          new Promise(resolve => setTimeout(() => resolve([]), SUBS_PHASE_DEADLINE_MS)),
        ]);
        if (!Array.isArray(results) || results.length === 0) {
          this.logger.info(`StreamResolver: subtitle phase hit its ${SUBS_PHASE_DEADLINE_MS}ms deadline (or no subs) — shipping to protect the client budget`);
        }

        // Attach subtitles to each group
        let totalAttached = 0;
        for (const { key, subs } of results) {
          if (subs.length === 0) continue;
          const groupStreams = key === '' ? imdbOnlyGroup : (groups.get(key) || []);
          for (const r of groupStreams) {
            r.meta = r.meta || {};
            r.meta.subtitles = subs;
            totalAttached++;
          }
          const label = key ? `release "${key.slice(0, 30)}"` : 'IMDB fallback';
          this.logger.info(`StreamResolver: ${subs.length} subs for ${label} → ${groupStreams.length} streams`);
        }
        if (totalAttached > 0) {
          this.logger.info(`StreamResolver: subtitles attached to ${totalAttached}/${streamsNeedingSubs.length} streams`);
        }
      }
    } catch (e) {
      this.logger.warn(`StreamResolver: subtitle fetch failed — ${e?.message || e}`);
    }
    } // end if (allSettled && settled-early) — late-settled/partial responses skip the 9s subtitle lookup

    // Sort (user requirement, Task 46): streams that support up-to-4K ALWAYS
    // come first, then progressively lower qualities — for movies AND series
    // (this comparator is type-agnostic). height desc (2160 → 1080 → 720 →
    // 480 → unknown) → file size desc (HQ variants first within a tier) →
    // source priority. Numeric coercion defends against any source that sets
    // meta.height/meta.bytes as a string (NaN would silently break the tier
    // ordering). Errors still sort to the front of the array (they are
    // skipped by the build loop) and external-URL cards (zxcstream player
    // page, sanctioned exception) stay at the very end.
    const heightOf = (r) => Number(r.meta?.height) || 0;
    const bytesOf = (r) => Number(r.meta?.bytes) || 0;
    urlResults.sort((a, b) => {
      if (a.error || b.error) return a.error ? -1 : 1;
      if (a.isExternal || b.isExternal) return a.isExternal ? 1 : -1;
      const h = heightOf(b) - heightOf(a);
      if (h !== 0) return h;
      const bs = bytesOf(b) - bytesOf(a);
      if (bs !== 0) return bs;
      return (Number(b.meta?.priority) || 0) - (Number(a.meta?.priority) || 0);
    });

    // Build streams
    // Task 49: resolve the universal subtitle set without endangering budgets.
    //   - already settled (typical: fetched in parallel during the resolve) →
    //     use immediately, zero wait.
    //   - full path (all sources settled early) → wait up to 3s more (bounded;
    //     the OpenSubtitles pass above already spent time, and warm re-opens
    //     hit the 6h cache).
    //   - partial path (budget expired) → 0 wait — ship whatever is ready so
    //     the client-budget contract (Task 36) stays intact.
    if (!subsState.settled && allSettled) {
      // Task 53: the flat 3s wait could push the response past the client
      // budget (3s + card build after a late settle). Bound it by remaining.
      const unifiedWaitMs = Math.max(0, Math.min(3000, CLIENT_BUDGET_MS - 1200 - (Date.now() - resolveT0)));
      if (unifiedWaitMs > 0) {
        await Promise.race([
          unifiedSubsP.catch(() => []),
          new Promise(resolve => setTimeout(resolve, unifiedWaitMs)),
        ]);
      }
    }
    const universalSubs = subsState.value;

    const seen = new Set();
    for (const urlResult of urlResults) {
      if (urlResult.error) continue;

      // Filter out HubCloud CDN redirect URLs (pixel/gpdl/gpdl2.hubcloud.*).
      // These return HTML redirect pages (text/html) that redirect to dead
      // Cloudflare Workers (HTTP 500). Stremio can't parse HTML as video.
      // Only direct *.workers.dev, *.r2.dev, r2.cloudflarestorage.com, and
      // pixeldrain.dev URLs (which return actual video content) are kept.
      const filterHost = urlResult.url.hostname || '';
      if (/^(pixel|gpdl|gpdl2)\.hubcloud\.(cx|ist|net)$/.test(filterHost)) {
        continue;
      }
      // Also filter hubcloud.cx/tg/* (Telegram redirect — not a video URL)
      if (/^hubcloud\.(cx|ist|net)$/.test(filterHost) && urlResult.url.pathname.includes('/tg/')) {
        continue;
      }
      // Filter out known-dead pixeldrain files. The file ID 'negn6f' has been
      // deleted from PixelDrain and returns 404. This is a known-dead file.
      // Other pixeldrain files may still work — only filter this specific ID.
      if (filterHost.includes('pixeldrain') && urlResult.url.pathname.includes('negn6f')) {
        continue;
      }
      // Task 42: drop cards whose liveness probe came back definitively dead
      // (pixeldrain zips/decoy files, vimeos.* 403-HTML fronts, dead-tree
      // playlists, html-page "streams"). 'unknown' (probe pending/inconclusive)
      // ships as before — never block on probes. Gate on the EFFECTIVE host
      // (inner upstream for /proxy-wrapped cards).
      const effGateHost = streamGate.gateHostOf(urlResult.url.href);
      if (effGateHost && streamGate.isGatedHost(effGateHost) && streamGate.verdict(urlResult.url.href) === 'dead') {
        this.logger.info(`StreamResolver: dropping gated-dead card ${effGateHost}${urlResult.url.pathname.slice(0, 40)}`);
        continue;
      }

      // Dedup by URL + sourceId — allows the same URL from different sources
      // (e.g., HiAnime and AnimeKai both use zokoanime.video backend)
      const urlKey = `${urlResult.url.href}__${urlResult.meta?.sourceId || ''}`;
      if (seen.has(urlKey)) continue;
      seen.add(urlKey);

      // Route CDN URLs through /proxy if they're not already proxied
      // and don't have proxyHeaders set. CDN servers (cdn.valentine.guru,
      // cdn.fukggl.buzz, etc.) often reset connections when Stremio's
      // ffmpeg player fetches them directly.
      let finalUrl = urlResult.url;
      let finalMeta = urlResult.meta;
      const isAlreadyProxied = finalUrl.href.includes('/proxy?') || finalUrl.href.includes('/range-proxy?');

      // Task 49: workers.dev file hosts (hubcloud final links, 4khdhub /
      // 4khdhub.one / hdhub4u family) now IP-GATE datacenter IPs — live-
      // measured 403 "Access Denied" (plain-text worker deny, not a CF block
      // page) from BOTH /proxy (server-side fetch) AND direct server-side
      // fetch, same day. Shipping via /proxy forces OUR blocked egress IP →
      // guaranteed-dead cards → "stuck on loading screen, nothing plays".
      // Fix (Task 48 fix5 semantics, peraspera precedent): ship DIRECT with
      // requestHeaders so the PLAYER's residential IP makes the request —
      // exactly what the real site's browser does. In-codebase precedent:
      // hubcloud PixelServer cards already ship direct+requestHeaders
      // (HubCloud.js) and play. Must run BEFORE hasProxyHeaders is computed
      // so the proxyHeaders behaviorHints branch below engages.
      if (!isAlreadyProxied && !urlResult.requestHeaders && /(^|\.)workers\.dev$/i.test(finalUrl.hostname)) {
        urlResult.requestHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': 'https://hubcloud.cx/',
        };
        this.logger.info(`StreamResolver: workers.dev card shipped direct+proxyHeaders (datacenter IP-gate class): ${finalUrl.hostname}`);
      }

      const hasProxyHeaders = !!urlResult.requestHeaders;
      // Route URLs through /proxy ONLY if they are known to fail with direct access.
      // Proxying everything causes "network connection was lost" on Render when
      // downloading large files — Render kills long-running proxy connections.
      // Only proxy CDNs that return "Connection reset by peer" to Stremio's player.
      // Task 49: workers.dev REMOVED from this list — those hosts are now
      // handled by the direct+proxyHeaders branch above.
      //
      // IMPORTANT: hakunaymatata.com is NOT in this list because VidLink uses
      // bcdn.hakunaymatata.com for direct MP4 streams that play fine without
      // proxy. MovieBox URLs (which DO need proxy) have requestHeaders set and
      // are handled by the hasProxyHeaders block below.
      const needsProxy = /valentine|fukggl|fileserver|animeheaven|pixel\.hubcloud|gpdl\.hubcloud|img1\.|ngcorp\.dad|valhallastream/.test(finalUrl.hostname);

      if (!isAlreadyProxied && !hasProxyHeaders && needsProxy) {
        const proxyUrl = new URL('/proxy', ctx.hostUrl);
        proxyUrl.searchParams.set('url', finalUrl.href);
        // Add Referer for HubCloud CDN (pixel.hubcloud.cx → workers.dev redirect chain)
        if (/pixel\.hubcloud/.test(finalUrl.hostname)) {
          proxyUrl.searchParams.set('referer', 'https://hubcloud.cx/');
        }
        finalUrl = proxyUrl;
      }

      // hakunaymatata.com (MovieBox CDN) returns 429 (Too Many Requests) when
      // accessed without a Referer. If the source set requestHeaders with a
      // Referer, route through /proxy WITH the Referer param so the proxy
      // sends it. This avoids the 429 rate limit.
      if (!isAlreadyProxied && hasProxyHeaders && /hakunaymatata/.test(finalUrl.hostname)) {
        const proxyUrl = new URL('/proxy', ctx.hostUrl);
        proxyUrl.searchParams.set('url', finalUrl.href);
        const referer = urlResult.requestHeaders.Referer || urlResult.requestHeaders.referer || 'https://movie-box.co/';
        proxyUrl.searchParams.set('referer', referer);
        finalUrl = proxyUrl;
      }

      const stream = {
        ...(urlResult.isExternal ? { externalUrl: finalUrl.href } : { url: finalUrl.href }),
        name: this.buildName(urlResult),
        title: this.buildTitle(urlResult),
        behaviorHints: {
          bingeGroup: `phoenix-${urlResult.meta?.sourceId}-${urlResult.meta?.extractorId}`,
          ...(urlResult.format !== Format.mp4 && urlResult.notWebReady !== false && { notWebReady: true }),
          ...(urlResult.requestHeaders && {
            notWebReady: true,
            proxyHeaders: { request: urlResult.requestHeaders },
          }),
          ...(urlResult.meta?.bytes && { videoSize: urlResult.meta.bytes }),
        },
        // Subtitles pass-through — Task 49: EVERY card from EVERY source gets
        // the same subtitle providers. Source-provided tracks (NikaStream,
        // AniSuge, atlantic) and the OpenSubtitles release-matched tracks
        // (meta.subtitles, attached above on the full path) keep priority;
        // the universal granite+natsuki set (fetched in parallel at resolve
        // start) fills in the rest — deduped by base language, capped at 48.
        ...(() => {
          const merged = mergeSubtitleTracks(urlResult.meta?.subtitles, universalSubs);
          return merged.length > 0 ? { subtitles: merged } : {};
        })(),
      };
      streams.push(stream);
    }

    this.logger.info(`Returning ${streams.length} streams`);

    return { streams };
  }

  buildUrl(urlResult) {
    if (urlResult.isExternal) return { externalUrl: urlResult.url.href };
    return { url: urlResult.url.href };
  }

  buildName(urlResult) {
    const meta = urlResult.meta || {};
    const parts = ['🐦‍🔥 PhoeniX'];

    // Quality label (phoenix emoji for all resolutions)
    const height = meta.height;
    if (height >= 2160) parts.push('4K');
    else if (height >= 1080) parts.push('1080p');
    else if (height >= 720) parts.push('720p');
    else if (height >= 480) parts.push('480p');
    else if (height > 0) parts.push(getClosestResolution(height));

    // Source label + subsource (server name, provider, HubCloud server type, etc.)
    if (meta.sourceLabel) {
      // Use extractor label (e.g. "HubCloud (FSL)", "HubCloud (FSLv2)",
      // "HubCloud (10Gbps)", "HubCloud (Download)") as subSource if available
      // Prefer serverName (set by the source — e.g. "Orbit", "Valenox") over
      // extractorLabel (set by the extractor — e.g. "Nuvio"). The source knows
      // the specific server, while the extractor only knows the routing type.
      const subSource = meta.serverName || meta.extractorLabel || meta.provider || meta.subSource;
      if (subSource && subSource !== meta.sourceLabel) {
        parts.push(`${meta.sourceLabel} · ${subSource}`);
      } else {
        parts.push(meta.sourceLabel);
      }
    }

    // Download indicator for file-hosting sources
    if (['4khdhub', 'moviesdrive'].includes(meta.sourceId)) {
      parts.push('📥');
    }

    if (urlResult.isExternal) parts.push('⚠️ external');

    return parts.join(' · ');
  }

  buildTitle(urlResult) {
    const meta = urlResult.meta || {};
    const titleLines = [];

    // Line 1: Movie/show title (from source meta)
    if (meta.title) titleLines.push(meta.title);

    // Line 2: Technical specs — Quality · SourceType · Codec · AudioCodec · HDR · BitDepth
    const specs = [];

    // Quality
    const height = meta.height;
    if (height >= 2160) specs.push('2160p');
    else if (height >= 1080) specs.push('1080p');
    else if (height >= 720) specs.push('720p');
    else if (height >= 480) specs.push('480p');
    else if (height > 0) specs.push(getClosestResolution(height));

    // Source Type (BluRay Remux, WebDL, etc.)
    if (meta.sourceType) specs.push(meta.sourceType);

    // Video Codec (HEVC, AVC, AV1)
    if (meta.codec) {
      specs.push(meta.codec);
    } else if (meta.codecs) {
      const codecStr = meta.codecs;
      if (codecStr.includes('avc1')) specs.push('AVC');
      else if (codecStr.includes('hvc1') || codecStr.includes('hev1')) specs.push('HEVC');
      else if (codecStr.includes('av01')) specs.push('AV1');
    }

    // Audio Codec (TrueHD, Atmos, DD+, DTS, etc.)
    if (meta.audioCodec) specs.push(meta.audioCodec);

    // Audio channels (5.1, 7.1, etc.) — show with audio codec
    if (meta.audioChannels) specs.push(meta.audioChannels);

    // HDR (Dolby Vision, HDR10+, HDR)
    if (meta.hdr) specs.push(meta.hdr);

    // Bit Depth (10-bit, 8-bit)
    if (meta.bitDepth) specs.push(meta.bitDepth);

    // Container/stream format
    if (urlResult.format === Format.hls) specs.push('HLS');
    else if (urlResult.format === Format.mp4) specs.push('MP4');

    // Bitrate (if available from HLS manifest)
    if (meta.bandwidth) {
      const Mbps = (meta.bandwidth / 1000000).toFixed(1);
      specs.push(`~${Mbps} Mbps`);
    }

    if (specs.length > 0) titleLines.push(specs.join(' · '));

    // Line 3: File size
    if (meta.bytes) titleLines.push(`💾 ${bytes.format(meta.bytes)}`);

    // Line 4: Audio languages with flags (e.g. "Audio: 🇮🇳 Hindi, 🇺🇸 English").
    // meta.countryCodes is the language-flag system: sources set it directly
    // or via buildStreamResults from the API's audioTracks field, and
    // flagFromCountryCode maps each code to its emoji. Deduped — sources
    // that merge defaults with title-parsed languages used to double up.
    if (meta.countryCodes && meta.countryCodes.length > 0) {
      const langs = [...new Set(meta.countryCodes
        .filter(cc => cc !== 'multi')
        .map(cc => {
          const lang = languageFromCountryCode(cc);
          const flag = flagFromCountryCode(cc);
          return lang && lang !== 'Multi' ? (flag ? `${flag} ${lang}` : lang) : '';
        })
        .filter(Boolean))];
      if (langs.length > 0) {
        titleLines.push(`Audio: ${langs.join(', ')}`);
      }
    }

    // Line 5: Release group (if parsed from filename)
    if (meta.releaseGroup) {
      titleLines.push(`🏷️ ${meta.releaseGroup}`);
    }

    // Line 5b: Streaming platform + special tags
    const extraTags = [];
    if (meta.streamingPlatform) extraTags.push(meta.streamingPlatform);
    if (meta.specialTags) extraTags.push(meta.specialTags);
    if (meta.resolutionLabel) extraTags.push(meta.resolutionLabel);
    if (extraTags.length > 0) {
      titleLines.push(`📌 ${extraTags.join(' · ')}`);
    }

    // Line 6: Source link
    const sl = meta.sourceLabel;
    if (sl && sl !== urlResult.label) {
      titleLines.push(`🔗 ${urlResult.label} from ${sl}`);
    } else {
      titleLines.push(`🔗 ${urlResult.label}`);
    }

    return titleLines.join('\n');
  }
}
