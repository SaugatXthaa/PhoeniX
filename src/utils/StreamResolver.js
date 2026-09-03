// src/utils/StreamResolver.js

import bytes from 'bytes';
import { Format } from '../types.js';
import { getClosestResolution } from './resolution.js';
import { flagFromCountryCode, languageFromCountryCode } from './language.js';
import { SubtitleFetcher } from './SubtitleFetcher.js';

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
function enrichMeta(urlResult) {
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

    const streams = [];
    const urlResults = [];
    let sourceErrorCount = 0;

    // Per-source timing data — exposed via /debug/stream for diagnostics.
    // Helps identify which sources are slow or failing under load.
    const sourceTimings = [];

    const SOURCE_TIMEOUT_MS = 35_000;
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
    const MAX_CONCURRENT_SOURCES = 15;

    // Priority sources — these are started FIRST, before other sources, so they
    // don't get stuck waiting in the queue behind 85+ other sources. Without this,
    // Cinejoy (which needs ~6s of CPU) would wait 10-15s in the queue, leaving
    // only 15-20s for execution — tight enough that it sometimes times out.
    // Priority sources — these are started FIRST, before other sources, so they
    // don't get stuck waiting in the queue behind 75+ other sources. Without this,
    // slow sources (Cinejoy's lumen-gate-v1 crypto, StellarRip's PoW + 19-server
    // probing) would wait 10-15s in the queue, leaving only 15-20s before the
    // GLOBAL_TIMEOUT_MS = 33s cutoff.
    const PRIORITY_SOURCE_IDS = new Set([
      'cinejoy', 'zinkmovies', '4khdhub', 'playimdb',
      // Stellar sources — PoW + AES-GCM takes 5-10s; must start early
      'stellar', 'stellarrip',
      // VidEasy — speedracelight API takes 15-25s; must start early
      'videasy',
      // NikaStream — Anivexa API takes 20-30s; must start early
      'nikastream',
      // AniKage — prox.anicore.tv API takes 15-25s; must start early
      'anikage',
      // AniNeko — vivibebe.site API takes 15-25s; must start early
      'anineko',
      // AnimeWorldIN — play.zephyrix.top API takes 15-25s; must start early
      'animeworldindia',
      // Itachi — VidHawk API (3 servers × resolve + play) takes 10-20s
      'itachi',
    ]);
    const sortedSources = [...sources].sort((a, b) => {
      const aPriority = PRIORITY_SOURCE_IDS.has(a.id) ? 0 : 1;
      const bPriority = PRIORITY_SOURCE_IDS.has(b.id) ? 0 : 1;
      return aPriority - bPriority;
    });

    let activeCount = 0;
    const waitQueue = [];

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
      if (activeCount >= MAX_CONCURRENT_SOURCES) {
        await new Promise(resolve => waitQueue.push(resolve));
      }
      const queueTime = Date.now() - queueStart;
      activeCount++;

      const start = Date.now();
      let status = 'ok';
      let resultCount = 0;
      try {
        const sourceResults = await withTimeout(source.handle(ctx, type, id), SOURCE_TIMEOUT_MS, source.id);
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
        urlResults.push(...sourceUrlResults.flat());
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

    // GLOBAL TIMEOUT: Return whatever streams we have after 20s.
    // This prevents OOM on Render's 512MB free tier — without it, all 74
    // sources run simultaneously, each holding response data in memory.
    // The global cutoff ensures we collect results and free memory quickly.
    const GLOBAL_TIMEOUT_MS = 40_000;
    await Promise.race([
      Promise.all(sortedSources.map(s => handleSource(s))),
      new Promise(resolve => setTimeout(resolve, GLOBAL_TIMEOUT_MS)),
    ]);

    // Stash timings on the instance for the /debug/stream endpoint to read.
    // (Not returned in the normal /stream response to avoid breaking Stremio.)
    this._lastSourceTimings = sourceTimings;

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

        const results = await Promise.all(fetchTasks);

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

    // Sort: errors first, then by height desc, then bytes desc, then priority
    urlResults.sort((a, b) => {
      if (a.error || b.error) return a.error ? -1 : 1;
      if (a.isExternal || b.isExternal) return a.isExternal ? 1 : -1;
      const h = (b.meta?.height ?? 0) - (a.meta?.height ?? 0);
      if (h !== 0) return h;
      const bs = (b.meta?.bytes ?? 0) - (a.meta?.bytes ?? 0);
      if (bs !== 0) return bs;
      return (b.meta?.priority ?? 0) - (a.meta?.priority ?? 0);
    });

    // Build streams
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
      const isAlreadyProxied = finalUrl.href.includes('/proxy?');
      const hasProxyHeaders = !!urlResult.requestHeaders;
      // Route URLs through /proxy ONLY if they are known to fail with direct access.
      // Proxying everything causes "network connection was lost" on Render when
      // downloading large files — Render kills long-running proxy connections.
      // Only proxy CDNs that return "Connection reset by peer" to Stremio's player.
      //
      // IMPORTANT: hakunaymatata.com is NOT in this list because VidLink uses
      // bcdn.hakunaymatata.com for direct MP4 streams that play fine without
      // proxy. MovieBox URLs (which DO need proxy) have requestHeaders set and
      // are handled by the hasProxyHeaders block below.
      const needsProxy = /valentine|fukggl|fileserver|animeheaven|pixel\.hubcloud|gpdl\.hubcloud|workers\.dev/.test(finalUrl.hostname);

      if (!isAlreadyProxied && !hasProxyHeaders && needsProxy) {
        const proxyUrl = new URL('/proxy', ctx.hostUrl);
        proxyUrl.searchParams.set('url', finalUrl.href);
        // Add Referer for HubCloud CDN (pixel.hubcloud.cx → workers.dev redirect chain)
        if (/pixel\.hubcloud|workers\.dev/.test(finalUrl.hostname)) {
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
        // Subtitles pass-through — sources that return subtitle tracks
        // (e.g. NikaStream, AniSuge) store them in meta.subtitles as
        // Stremio-format objects: { id, url, lang }. Stremio reads this
        // array directly from the stream object and shows subtitle tracks
        // in the player UI.
        ...(Array.isArray(urlResult.meta?.subtitles) && urlResult.meta.subtitles.length > 0 && {
          subtitles: urlResult.meta.subtitles,
        }),
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

    // Line 4: Audio languages
    if (meta.countryCodes && meta.countryCodes.length > 0) {
      const langs = meta.countryCodes
        .filter(cc => cc !== 'multi')
        .map(cc => languageFromCountryCode(cc))
        .filter(l => l && l !== 'Multi');
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
