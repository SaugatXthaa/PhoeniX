// Stellar (stellar.gdn) All-In-One — Direct Stream Extractor
// =========================================================================
// Fetches DIRECT playable HLS stream URLs from stellar.gdn.
//
// ARCHITECTURE
// ------------
// Stellar uses a proof-of-work (PoW) challenge system to protect its stream
// API. The flow is:
//
//   1. GET https://api.stellar.gdn/api/challenge
//      → { challenge: "hex_string", difficulty: 4, expiresIn: 90 }
//
//   2. Solve PoW: find nonce where SHA-256(challenge + nonce) starts with
//      `difficulty` zeros. Typically takes ~60ms for difficulty=4.
//
//   3. AES-256-GCM encrypt the payload:
//      { mediaType, id, season?, episode?, source?, challenge, nonce }
//      Key = SHA-256("+Llfj2dFC+cgFDwWSo4Yyd6ZtZmgXC7nIjaNUupYq4PCVQelINhtKiohtmm0dYUI:" + today)
//      IV = 12 random bytes
//      Returns: { q: base64(ciphertext), s: base64(iv), t: base64(tag), d: "YYYY-MM-DD" }
//
//   4. POST https://api.stellar.gdn/api/resolve with encrypted payload
//      → { url: "https://cdn.reallyfast.ch/playlist/p/...", source: "Orbit",
//          format: "hls", availableSources: ["Orbit", "Valenox"], subtitles: [] }
//
//   5. The returned URL is a MASTER HLS playlist with multiple quality variants:
//      - 640x360 (800kbps)
//      - 1280x720 (2.8Mbps)
//      - 1920x1080 (5Mbps)
//      - 3840x2160 (20Mbps) — 4K UHD (when available)
//      Plus multiple audio tracks.
//
//   6. The stream URL works with NO auth headers — completely public once
//      you have the URL. Stremio plays it directly via HLS.
//
// SOURCES
// -------
// Stellar has multiple sources (star/constellation names):
//   - Orbit (cdn.reallyfast.ch) — master playlist with 360p/720p/1080p/4K
//   - Valenox (h.midnightexpress.workers.dev) — alternate CDN
//   - And more (dynamically discovered via availableSources)
//
// 4K SUPPORT
// ----------
// Some titles (e.g. Oppenheimer TMDB 872585) have a 3840x2160 (4K UHD) variant
// in the master playlist. Stremio's HLS player automatically selects the
// highest quality variant. We probe the master playlist to detect the actual
// max resolution and label the stream accordingly (2160p/1080p/720p).
//
// MULTI-METHOD FETCH
// ------------------
// Uses got-scraping (Chrome TLS fingerprint) → curl → Node.js fetch to
// bypass Cloudflare's bot detection. The site sometimes returns 522
// (origin timeout) — the scraper retries with exponential backoff.
//
// USAGE
// -----
//   const stellar = require('./stellar_all_in_one.js');
//   const streams = await stellar.getStreams('27205', 'movie');
//   const streams = await stellar.getStreams('1396', 'tv', 1, 1);
//
// CLI:
//   node stellar_all_in_one.js 27205 movie
//   node stellar_all_in_one.js 1396 tv 1 1

'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PROVIDER_NAME = 'Stellar';
const STELLAR_ORIGIN = 'https://stellar.gdn';
const STELLAR_RIP_ORIGIN = 'https://stellar.rip'; // fallback domain
const BACKEND_URL = 'https://api.stellar.gdn';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';

// AES-GCM encryption key secret (from stellar.gdn JS bundle).
// Updated 2024-09 — the previous key ("+Llfj2dFC...YUI:") expired and the
// backend started rejecting requests with "Invalid or expired encryption".
// Pulled from /_next/static/chunks/43z1m9c5fr_0f.js — the format is
// `${secret}:${date}` SHA-256 hashed to derive the AES-256 key.
// If this expires again, search the stellar.gdn JS bundle for
// `crypto.subtle.digest("SHA-256"` and grab the preceding string literal.
const AES_KEY_SECRET = 'KT1b67W1DU2ebpGxQkMiFVyz1iaP/PeMgv/xJQDdDoU=:';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Proof-of-Work solver
// Finds nonce where SHA-256(challenge + nonce) starts with `difficulty` zeros
// ---------------------------------------------------------------------------
function solvePoW(challenge, difficulty) {
  const target = '0'.repeat(difficulty);
  for (let a = 0; a <= 5000000; a++) {
    const hash = crypto.createHash('sha256').update(challenge + a).digest('hex');
    if (hash.startsWith(target)) {
      return String(a);
    }
  }
  throw new Error('PoW timed out after 5M iterations');
}

// ---------------------------------------------------------------------------
// AES-256-GCM encrypt the payload
// Key = SHA-256(AES_KEY_SECRET + today's_date)
// Returns: { q: base64(ciphertext), s: base64(iv), t: base64(tag), d: date }
// ---------------------------------------------------------------------------
function encryptPayload(data) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const keyMaterial = AES_KEY_SECRET + today;
  const keyHash = crypto.createHash('sha256').update(keyMaterial).digest();
  const aesKey = crypto.createSecretKey(keyHash);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    q: encrypted.toString('base64'), // ciphertext (without tag)
    s: iv.toString('base64'),        // IV (12 bytes)
    t: tag.toString('base64'),       // auth tag (16 bytes)
    d: today,                        // date used for key derivation
  };
}

// ---------------------------------------------------------------------------
// got-scraping loader — stellar.gdn/api.stellar.gdn are behind Cloudflare
// which can challenge native fetch() with 403. got-scraping uses Chrome's
// TLS fingerprint to bypass CF. Falls back to native fetch if unavailable.
// ---------------------------------------------------------------------------
var _gotScrapingMod = null;
function getGotScraping() {
  if (_gotScrapingMod !== null) return Promise.resolve(_gotScrapingMod);
  return import('got-scraping').then(function (mod) {
    _gotScrapingMod = mod.gotScraping || (mod.default && mod.default.gotScraping) || mod.default;
    return _gotScrapingMod;
  }).catch(function () {
    _gotScrapingMod = false;
    return false;
  });
}

// Wrapper: GET JSON via got-scraping (with native fetch fallback).
async function gotGetJson(url, referer, timeoutMs) {
  const gs = await getGotScraping();
  if (gs) {
    const res = await gs({
      url: url,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': STELLAR_ORIGIN,
        'Referer': referer || (STELLAR_ORIGIN + '/'),
      },
      timeout: { request: timeoutMs || 15000 },
      throwHttpErrors: false,
      followRedirect: true,
      headerGeneratorOptions: {
        browsers: ['chrome'],
        devices: ['desktop'],
        operatingSystems: ['windows'],
      },
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const err = new Error('HTTP ' + res.statusCode + ' for ' + url);
      err.status = res.statusCode;
      err.body = res.body;
      throw err;
    }
    try { return JSON.parse(res.body); } catch (e) {
      throw new Error('Invalid JSON from ' + url + ': ' + String(res.body).slice(0, 200));
    }
  }
  // Fallback: native fetch
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Origin': STELLAR_ORIGIN,
      'Referer': referer || (STELLAR_ORIGIN + '/'),
    },
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  if (!r.ok) {
    const err = new Error('HTTP ' + r.status + ' for ' + url);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// Wrapper: POST JSON via got-scraping (with native fetch fallback).
async function gotPostJson(url, data, referer, timeoutMs) {
  const bodyStr = JSON.stringify(data);
  const gs = await getGotScraping();
  if (gs) {
    const res = await gs({
      url: url,
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'Origin': STELLAR_ORIGIN,
        'Referer': referer || (STELLAR_ORIGIN + '/'),
      },
      body: bodyStr,
      timeout: { request: timeoutMs || 15000 },
      throwHttpErrors: false,
      followRedirect: true,
      headerGeneratorOptions: {
        browsers: ['chrome'],
        devices: ['desktop'],
        operatingSystems: ['windows'],
      },
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const err = new Error('HTTP ' + res.statusCode + ' for ' + url + ': ' + String(res.body).slice(0, 200));
      err.status = res.statusCode;
      err.body = res.body;
      throw err;
    }
    try { return JSON.parse(res.body); } catch (e) {
      throw new Error('Invalid JSON from ' + url + ': ' + String(res.body).slice(0, 200));
    }
  }
  // Fallback: native fetch
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Accept': 'application/json',
      'Origin': STELLAR_ORIGIN,
      'Referer': referer || (STELLAR_ORIGIN + '/'),
    },
    body: bodyStr,
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    const err = new Error('HTTP ' + r.status + ' for ' + url + ': ' + txt.slice(0, 200));
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// ---------------------------------------------------------------------------
// Resolve a stream URL via the encrypted /api/resolve endpoint
// Returns: { url, source, format, availableSources, subtitles }
// ---------------------------------------------------------------------------
async function resolveStreamUrl(mediaType, id, season, episode, source) {
  // 1. Get challenge
  const challengeResp = await gotGetJson(BACKEND_URL + '/api/challenge', STELLAR_ORIGIN + '/', 15000);

  // 2. Solve PoW
  const nonce = solvePoW(challengeResp.challenge, challengeResp.difficulty);

  // 3. Build payload
  const payload = {
    mediaType: mediaType,
    id: Number(id),
    challenge: challengeResp.challenge,
    nonce: nonce,
  };
  if (season != null) payload.season = Number(season);
  if (episode != null) payload.episode = Number(episode);
  if (source) payload.source = source;

  // 4. Encrypt
  const enc = encryptPayload(payload);

  // 5. POST to /api/resolve
  return await gotPostJson(BACKEND_URL + '/api/resolve', enc, STELLAR_ORIGIN + '/', 20000);
}

// ---------------------------------------------------------------------------
// Fetch download files via /api/download endpoint
// Returns: { files: [{ source, label, file_name, resolution, size, url, urls }] }
// These are DIRECT .mkv/.mp4 download URLs (up to 4K 2160p BluRay REMUX)
//
// NOTE: stellar.gdn only accepts type "movie" or "tv". Anime and kdrama are
// served as "tv" type with their TMDB IDs. The API returns season-pack
// downloads for TV shows (not per-episode).
// ---------------------------------------------------------------------------
async function fetchDownloadFiles(mediaType, id, season, episode) {
  try {
    const challengeResp = await gotGetJson(BACKEND_URL + '/api/challenge', STELLAR_ORIGIN + '/', 15000);
    const nonce = solvePoW(challengeResp.challenge, challengeResp.difficulty);

    // /api/download uses "type" instead of "mediaType"
    // Anime and kdrama are mapped to "tv" — stellar only supports movie/tv
    const apiType = mediaType === 'movie' ? 'movie' : 'tv';

    const payload = {
      type: apiType,
      id: Number(id),
      challenge: challengeResp.challenge,
      nonce: nonce,
    };
    if (season != null) payload.season = Number(season);
    if (episode != null) payload.episode = Number(episode);

    const enc = encryptPayload(payload);

    const data = await gotPostJson(BACKEND_URL + '/api/download', enc, STELLAR_ORIGIN + '/', 20000);
    if (!data.files || !Array.isArray(data.files)) return [];
    return data.files;
  } catch (e) {
    console.log('[Stellar] Download API error: ' + e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Quick-check a download URL — returns HTTP status (not full validation)
// Used to sort streams: playable ones first, quota-limited ones last
// Returns: { playable: boolean, status: number }
// Uses got-scraping for CF-protected CDNs (cdn.reallyfast.ch etc.).
// ---------------------------------------------------------------------------
async function quickCheckUrl(url) {
  try {
    const gs = await getGotScraping();
    if (gs) {
      const res = await gs({
        url: url,
        method: 'GET',
        headers: { 'User-Agent': UA, Range: 'bytes=0-3', Accept: '*/*' },
        timeout: { request: 6000 },
        throwHttpErrors: false,
        followRedirect: true,
      });
      if (res.statusCode === 200 || res.statusCode === 206) {
        return { playable: true, status: res.statusCode };
      }
      return { playable: false, status: res.statusCode };
    }
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-3' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok || res.status === 206) {
      return { playable: true, status: res.status };
    }
    return { playable: false, status: res.status };
  } catch (e) {
    return { playable: false, status: 0 };
  }
}

// ---------------------------------------------------------------------------
// Fetch the master playlist and extract resolution info
// Returns: { maxResolution, maxQuality, variantCount, has4K }
// Uses got-scraping so CF-protected stream CDNs (cdn.reallyfast.ch) work.
// ---------------------------------------------------------------------------
async function probeMasterPlaylist(url) {
  try {
    let text;
    const gs = await getGotScraping();
    if (gs) {
      const res = await gs({
        url: url,
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: '*/*' },
        timeout: { request: 12000 },
        throwHttpErrors: false,
        followRedirect: true,
      });
      if (res.statusCode < 200 || res.statusCode >= 300) return null;
      text = res.body;
    } else {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      text = await res.text();
    }

    // Find all RESOLUTION= variants
    const variants = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const resMatch = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
        if (resMatch) {
          variants.push({
            width: parseInt(resMatch[1], 10),
            height: parseInt(resMatch[2], 10),
            bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
          });
        }
      }
    }

    if (variants.length === 0) return null;

    // Find the highest quality variant
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const best = variants[0];
    const maxRes = Math.max(best.width, best.height);

    return {
      maxWidth: best.width,
      maxHeight: best.height,
      maxResolution: `${best.width}x${best.height}`,
      maxQuality: mapResolutionToQuality(best.width, best.height),
      variantCount: variants.length,
      has4K: maxRes >= 3840,
      variants: variants.map(v => `${v.width}x${v.height}`),
    };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Map resolution to Stremio quality label
// ---------------------------------------------------------------------------
function mapResolutionToQuality(w, h) {
  const r = Math.max(w, h);
  if (r >= 3840) return '2160p';        // 4K UHD
  if (r >= 2560) return '1440p';        // 2K QHD
  if (r >= 1920) return '1080p';        // Full HD
  if (r >= 1280) return '720p';         // HD
  if (r >= 1024) return '576p';         // PAL SD
  if (r >= 854)  return '480p';         // NTSC SD
  return 'SD';
}

// ---------------------------------------------------------------------------
// TMDB metadata fetcher
// ---------------------------------------------------------------------------
async function getTMDBInfo(tmdbId, type) {
  const url = `https://api.themoviedb.org/3/${type === 'tv' ? 'tv' : 'movie'}/${tmdbId}` +
    `?api_key=${TMDB_API_KEY}&language=en-US`;

  // Try got-scraping first (Chrome TLS fingerprint), then fall back to native fetch
  let body = null;
  try {
    const gs = await getGotScraping();
    if (gs) {
      const res = await gs({
        url: url,
        method: 'GET',
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        timeout: { request: 10000 },
        throwHttpErrors: false,
        followRedirect: true,
      });
      if (res.statusCode === 200) body = res.body;
    }
  } catch (e) { /* fall through to native fetch */ }

  if (!body) {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
    body = await res.text();
  }

  const j = JSON.parse(body);
  return {
    title: j.name || j.title || 'Unknown',
    year: (j.first_air_date || j.release_date || '').slice(0, 4),
    type,
    tmdbId: String(tmdbId),
  };
}

// ---------------------------------------------------------------------------
// Build a Stremio stream object
// ---------------------------------------------------------------------------
function buildStream(opts) {
  const s = {
    name: PROVIDER_NAME + ' - ' + opts.serverLabel,
    title: opts.title,
    url: opts.url,
    quality: opts.quality || '1080p',
    behaviorHints: { bingeGroup: opts.bingeGroup || 'stellar-' + opts.serverLabel.toLowerCase() },
  };
  if (opts.type === 'iframe') {
    s.type = 'iframe';
    s.behaviorHints.notWebVideo = true;
  } else {
    s.type = 'application/vnd.apple.mpegurl';
  }
  if (opts.subtitles && opts.subtitles.length > 0) {
    s.subtitles = opts.subtitles.map(sub => ({
      id: sub.language || sub.label || 'en',
      url: sub.url,
      lang: sub.label || sub.language || 'English',
    }));
  }
  return s;
}

// ---------------------------------------------------------------------------
// Main entry: get streams for a TMDB item
// ---------------------------------------------------------------------------
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isMovie = type !== 'tv';
  const mediaType = isMovie ? 'movie' : 'tv';

  if (!isMovie && (season == null || episode == null)) {
    console.log('[Stellar] TV request without season/episode — returning empty');
    return [];
  }
  if (!tmdbId) {
    console.log('[Stellar] Empty TMDB ID — returning empty');
    return [];
  }

  console.log('[Stellar] Request: tmdb=' + tmdbId + ' type=' + type +
    (isMovie ? '' : ' S' + season + 'E' + episode));

  // 1. Fetch TMDB info
  let info;
  try {
    info = await Promise.race([
      getTMDBInfo(tmdbId, type),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TMDB timeout')), 10000)),
    ]);
  } catch (e) {
    console.log('[Stellar] TMDB fetch error: ' + e.message);
    info = { title: 'TMDB ' + tmdbId, year: '', type, tmdbId };
  }
  console.log('[Stellar] TMDB: ' + info.title + (info.year ? ' (' + info.year + ')' : ''));

  const allStreams = [];

  // 2. Resolve stream URL (default source — usually Orbit)
  console.log('[Stellar] Resolving stream via /api/resolve (PoW + AES-GCM)...');
  let resolveResult;
  try {
    resolveResult = await resolveStreamUrl(mediaType, tmdbId, season, episode);
    console.log('[Stellar] Resolved: source=' + resolveResult.source +
      ', format=' + resolveResult.format +
      ', availableSources=' + JSON.stringify(resolveResult.availableSources));
  } catch (e) {
    console.log('[Stellar] Resolve failed: ' + e.message);
    // Fallback to iframe embed
    return getIframeFallbacks(tmdbId, type, season, episode, info);
  }

  if (!resolveResult.url) {
    console.log('[Stellar] No stream URL returned');
    return getIframeFallbacks(tmdbId, type, season, episode, info);
  }

  // 3. Probe the master playlist for resolution info
  console.log('[Stellar] Probing master playlist for resolution...');
  const probe = await probeMasterPlaylist(resolveResult.url);
  if (probe) {
    console.log('[Stellar] Master playlist: ' + probe.variantCount + ' variants, max=' +
      probe.maxResolution + ' (' + probe.maxQuality + ')' +
      (probe.has4K ? ' [4K!]' : ''));
  }

  // 4. Add the primary stream (master playlist URL — Stremio auto-selects best quality)
  const quality = probe ? probe.maxQuality : '1080p';
  const resStr = probe ? ' ' + probe.maxResolution : '';
  const sourceLabel = resolveResult.source || 'Default';

  allStreams.push(buildStream({
    title: `${info.title} [Stellar ${sourceLabel}${resStr}${probe && probe.has4K ? ' 4K' : ''}]`,
    url: resolveResult.url,
    quality: quality,
    serverLabel: sourceLabel,
    bingeGroup: `stellar-${sourceLabel.toLowerCase()}-${tmdbId}`,
    type: 'hls',
    subtitles: resolveResult.subtitles,
  }));
  console.log('[Stellar] + ' + sourceLabel + ' stream (' + quality + '): ' + resolveResult.url.slice(0, 80));

  // 5. Try other available sources
  if (resolveResult.availableSources && resolveResult.availableSources.length > 1) {
    for (const sourceName of resolveResult.availableSources) {
      if (sourceName === resolveResult.source) continue; // skip the one we already have
      try {
        console.log('[Stellar] Trying source: ' + sourceName + '...');
        const altResult = await resolveStreamUrl(mediaType, tmdbId, season, episode, sourceName);
        if (altResult.url) {
          const altProbe = await probeMasterPlaylist(altResult.url);
          const altQuality = altProbe ? altProbe.maxQuality : '1080p';
          const altResStr = altProbe ? ' ' + altProbe.maxResolution : '';

          allStreams.push(buildStream({
            title: `${info.title} [Stellar ${sourceName}${altResStr}${altProbe && altProbe.has4K ? ' 4K' : ''}]`,
            url: altResult.url,
            quality: altQuality,
            serverLabel: sourceName,
            bingeGroup: `stellar-${sourceName.toLowerCase()}-${tmdbId}`,
            type: 'hls',
            subtitles: altResult.subtitles,
          }));
          console.log('[Stellar] + ' + sourceName + ' stream (' + altQuality + '): ' + altResult.url.slice(0, 80));
        }
      } catch (e) {
        console.log('[Stellar]   ' + sourceName + ' failed: ' + e.message);
      }
    }
  }

  // 6. Fetch download files (4K BluRay REMUX, 1080p BluRay, etc.)
  // These are DIRECT .mkv/.mp4 file URLs — up to 4K (2160p) with HDR/DV
  // ALL files are included (even quota-limited ones — they reset daily)
  console.log('[Stellar] Fetching download files via /api/download...');
  const downloadFiles = await fetchDownloadFiles(mediaType, tmdbId, season, episode);
  console.log('[Stellar] Download files: ' + downloadFiles.length);

  // Quick-check all URLs in parallel to determine which are currently playable
  const checkedFiles = await Promise.all(
    downloadFiles.map(async (file) => {
      const url = file.url || (file.urls && file.urls[0]);
      if (!url) return { file, url: null, playable: false, status: 0 };
      const check = await quickCheckUrl(url);
      return { file, url, playable: check.playable, status: check.status };
    })
  );

  // Sort: playable first (by resolution descending), then quota-limited (by resolution descending)
  const resolutionOrder = { '2160p': 0, '1440p': 1, '1080p': 2, '720p': 3, '576p': 4, '480p': 5 };
  checkedFiles.sort((a, b) => {
    if (a.playable !== b.playable) return a.playable ? -1 : 1; // playable first
    const ra = resolutionOrder[a.file.resolution] || 99;
    const rb = resolutionOrder[b.file.resolution] || 99;
    return ra - rb; // higher resolution first
  });

  // Add ALL download files as streams
  for (const { file, url, playable, status } of checkedFiles) {
    if (!url) continue;

    const fileQuality = file.resolution || '1080p';
    const is4K = fileQuality === '2160p';

    // Build a descriptive title with format info
    const formatInfo = file.label || file.file_name || '';
    const hdrInfo = formatInfo.includes('HDR') ? ' HDR' : '';
    const dvInfo = formatInfo.includes('DV') ? ' DV' : '';
    const releaseInfo = file.release ? ' ' + file.release : '';
    const sizeInfo = file.size ? ' (' + file.size + ')' : '';
    const playStatus = playable ? '' : ' [quota-limited, try later]';

    allStreams.push({
      name: PROVIDER_NAME + ' - DL ' + fileQuality + (hdrInfo || dvInfo) + (playable ? '' : ' ⚠'),
      title: `${info.title} [Stellar DL ${fileQuality}${releaseInfo}${hdrInfo}${dvInfo}]${sizeInfo}${playStatus}`,
      url: url,
      quality: fileQuality,
      type: 'video/x-matroska', // MKV — Stremio plays directly
      behaviorHints: {
        bingeGroup: `stellar-download-${fileQuality.toLowerCase()}-${tmdbId}`,
        filename: file.file_name || `${info.title} ${fileQuality}.mkv`,
      },
    });
    console.log('[Stellar] + DL ' + fileQuality + (is4K ? ' [4K]' : '') + (hdrInfo || dvInfo) + ': ' + (file.size || '?') +
      ' — ' + (playable ? '✓ playable' : '✗ quota-limited (HTTP ' + status + ')') +
      ' | ' + (file.label || '').slice(0, 50));
  }

  // 7. Add iframe fallback (embed page on stellar.rip)
  const embedUrl = isMovie
    ? `${STELLAR_RIP_ORIGIN}/en/watch/embed/movie/${tmdbId}`
    : `${STELLAR_RIP_ORIGIN}/en/watch/embed/tv/${tmdbId}-${season}-${episode}`;
  allStreams.push(buildStream({
    title: `${info.title} [Stellar Player (iframe)]`,
    url: embedUrl,
    quality: '1080p',
    serverLabel: 'Player',
    bingeGroup: 'stellar-player-iframe',
    type: 'iframe',
  }));

  console.log('[Stellar] ' + allStreams.length + ' streams total');
  return allStreams;
}

// ---------------------------------------------------------------------------
// Iframe fallback (used when /api/resolve fails)
// ---------------------------------------------------------------------------
async function getIframeFallbacks(tmdbId, type, season, episode, info) {
  const isMovie = type !== 'tv';
  const streams = [];

  // stellar.gdn watch page (the player)
  const watchUrl = isMovie
    ? `${STELLAR_ORIGIN}/watch/movie/${tmdbId}`
    : `${STELLAR_ORIGIN}/watch/tv/${tmdbId}-${season}-${episode}`;

  streams.push(buildStream({
    title: `${info.title} [Stellar Player]`,
    url: watchUrl,
    quality: '1080p',
    serverLabel: 'Player',
    bingeGroup: 'stellar-player',
    type: 'iframe',
  }));

  // stellar.rip embed page (backup)
  const embedUrl = isMovie
    ? `${STELLAR_RIP_ORIGIN}/en/watch/embed/movie/${tmdbId}`
    : `${STELLAR_RIP_ORIGIN}/en/watch/embed/tv/${tmdbId}-${season}-${episode}`;

  streams.push(buildStream({
    title: `${info.title} [Stellar Embed]`,
    url: embedUrl,
    quality: '1080p',
    serverLabel: 'Embed',
    bingeGroup: 'stellar-embed',
    type: 'iframe',
  }));

  console.log('[Stellar] ' + streams.length + ' iframe fallback streams');
  return streams;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getStreams: getStreams,
  getTMDBInfo: getTMDBInfo,
  solvePoW: solvePoW,
  encryptPayload: encryptPayload,
  resolveStreamUrl: resolveStreamUrl,
  fetchDownloadFiles: fetchDownloadFiles,
  quickCheckUrl: quickCheckUrl,
  probeMasterPlaylist: probeMasterPlaylist,
  mapResolutionToQuality: mapResolutionToQuality,
  getIframeFallbacks: getIframeFallbacks,
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node stellar_all_in_one.js <tmdbId> <movie|tv> [season] [episode]');
    console.log('Examples:');
    console.log('  node stellar_all_in_one.js 27205 movie        # Inception');
    console.log('  node stellar_all_in_one.js 1396 tv 1 1        # Breaking Bad S01E01');
    console.log('  node stellar_all_in_one.js 872585 movie       # Oppenheimer (4K!)');
    process.exit(1);
  }
  const tmdbId = args[0];
  const type = args[1];
  const season = type === 'tv' ? parseInt(args[2] || '1', 10) : null;
  const episode = type === 'tv' ? parseInt(args[3] || '1', 10) : null;

  getStreams(tmdbId, type, season, episode).then(streams => {
    console.log('\n=== Final streams ===');
    streams.forEach((s, i) => {
      console.log((i + 1) + '. ' + s.name + ' | ' + s.quality + ' | ' + s.type);
      console.log('   ' + s.url.slice(0, 120));
    });
    console.log('\nTotal: ' + streams.length + ' stream(s)');
  }).catch(e => {
    console.error('FATAL: ' + e.stack);
    process.exit(1);
  });
}
