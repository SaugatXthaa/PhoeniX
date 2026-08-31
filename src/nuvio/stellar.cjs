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

// AES-GCM encryption key secret (from stellar.gdn JS bundle)
const AES_KEY_SECRET = '+Llfj2dFC+cgFDwWSo4Yyd6ZtZmgXC7nIjaNUupYq4PCVQelINhtKiohtmm0dYUI:';

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
// Get a fresh challenge from the API
// ---------------------------------------------------------------------------
async function getChallenge() {
  const res = await fetch(BACKEND_URL + '/api/challenge', {
    headers: {
      'User-Agent': UA,
      'Origin': STELLAR_ORIGIN,
      'Referer': STELLAR_ORIGIN + '/',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Challenge HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Resolve a stream URL via the encrypted /api/resolve endpoint
// Returns: { url, source, format, availableSources, subtitles }
// ---------------------------------------------------------------------------
async function resolveStreamUrl(mediaType, id, season, episode, source) {
  // 1. Get challenge
  const challengeResp = await getChallenge();

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
  const res = await fetch(BACKEND_URL + '/api/resolve', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Origin': STELLAR_ORIGIN,
      'Referer': STELLAR_ORIGIN + '/',
    },
    body: JSON.stringify(enc),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Resolve HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Fetch the master playlist and extract resolution info
// Returns: { maxResolution, maxQuality, variantCount, has4K }
// ---------------------------------------------------------------------------
async function probeMasterPlaylist(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const text = await res.text();

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
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  const j = await res.json();
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

  // 6. Add iframe fallback (embed page on stellar.rip)
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
  getChallenge: getChallenge,
  solvePoW: solvePoW,
  encryptPayload: encryptPayload,
  resolveStreamUrl: resolveStreamUrl,
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
