// Stellar (stellar.gdn) — Direct Stream Extractor with 4K Support
// =========================================================================
// Returns DIRECT playable HLS stream URLs from stellar.gdn via api.stellar.gdn.
//
// FLOW:
//   1. GET https://api.stellar.gdn/api/challenge → PoW challenge (difficulty=4)
//   2. Solve PoW: SHA-256(challenge + nonce) starts with 4 hex zeros (~60ms)
//   3. AES-256-GCM encrypt payload with key derived from:
//      SHA-256("KT1b67W1DU2ebpGxQkMiFVyz1iaP/PeMgv/xJQDdDoU=:" + today's_date)
//   4. POST https://api.stellar.gdn/api/resolve → { url, source, availableSources }
//   5. The URL is a DIRECT HLS master playlist on cdn.reallyfast.ch
//   6. Streams work with NO auth headers — completely public once resolved
//
// The master playlist has 4 quality variants:
//   - 640x360 (360p)
//   - 1280x720 (720p)
//   - 1920x1080 (1080p)
//   - 3840x2160 (2160p / 4K UHD) ← when available!
//
// Stremio's HLS player auto-selects the highest quality variant (4K when available).
//
// USAGE:
//   const stellar = require('./stellar_all_in_one.js');
//   const streams = await stellar.getStreams('27205', 'movie');
//   const streams = await stellar.getStreams('1396', 'tv', 1, 1);

'use strict';

const crypto = require('crypto');

const PROVIDER_NAME = 'Stellar';
const STELLAR_GDN = 'https://stellar.gdn';
const BACKEND_URL = 'https://api.stellar.gdn';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// AES-GCM encryption key secret (ROTATED on 2026-09-02 — found in stellar.gdn JS bundle)
const AES_KEY_SECRET = 'KT1b67W1DU2ebpGxQkMiFVyz1iaP/PeMgv/xJQDdDoU=:';

// ---------------------------------------------------------------------------
// Solve PoW: find nonce where SHA-256(challenge + nonce) starts with `difficulty` hex zeros
// ---------------------------------------------------------------------------
function solvePoW(challenge, difficulty) {
  const target = '0'.repeat(difficulty);
  for (let a = 0; a <= 5000000; a++) {
    const hash = crypto.createHash('sha256').update(challenge + a).digest('hex');
    if (hash.startsWith(target)) return String(a);
  }
  throw new Error('PoW timed out');
}

// ---------------------------------------------------------------------------
// AES-256-GCM encrypt the payload
// Key = SHA-256(AES_KEY_SECRET + today's_date)
// Returns: { q: base64(ciphertext), s: base64(iv), t: base64(tag), d: date }
// ---------------------------------------------------------------------------
function encryptPayload(data) {
  const today = new Date().toISOString().slice(0, 10);
  const keyHash = crypto.createHash('sha256').update(AES_KEY_SECRET + today).digest();
  const aesKey = crypto.createSecretKey(keyHash);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { q: enc.toString('base64'), s: iv.toString('base64'), t: tag.toString('base64'), d: today };
}

// ---------------------------------------------------------------------------
async function getTMDBInfo(tmdbId, type) {
  const url = `https://api.themoviedb.org/3/${type === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  const j = await res.json();
  return { title: j.name || j.title || 'Unknown', year: (j.first_air_date || j.release_date || '').slice(0, 4), type, tmdbId: String(tmdbId) };
}

// ---------------------------------------------------------------------------
// Get challenge + solve PoW + encrypt + resolve stream URL
// Returns: { url, source, format, availableSources, subtitles }
// ---------------------------------------------------------------------------
async function resolveStreamUrl(mediaType, id, season, episode, source) {
  // 1. Get challenge
  const chRes = await fetch(`${BACKEND_URL}/api/challenge`, {
    headers: { 'User-Agent': UA, 'Origin': STELLAR_GDN, 'Referer': STELLAR_GDN + '/' },
    signal: AbortSignal.timeout(10000),
  });
  if (!chRes.ok) throw new Error(`Challenge HTTP ${chRes.status}`);
  const challenge = await chRes.json();

  // 2. Solve PoW
  const nonce = solvePoW(challenge.challenge, challenge.difficulty);

  // 3. Build + encrypt payload
  const payload = { mediaType, id: Number(id), challenge: challenge.challenge, nonce };
  if (season != null) payload.season = Number(season);
  if (episode != null) payload.episode = Number(episode);
  if (source) payload.source = source;
  const enc = encryptPayload(payload);

  // 4. POST /api/resolve
  const resRes = await fetch(`${BACKEND_URL}/api/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Origin': STELLAR_GDN, 'Referer': STELLAR_GDN + '/' },
    body: JSON.stringify(enc),
    signal: AbortSignal.timeout(15000),
  });
  if (!resRes.ok) throw new Error(`Resolve HTTP ${resRes.status}`);
  return resRes.json();
}

// ---------------------------------------------------------------------------
// Probe master playlist for resolution info
// Returns: { quality, width, height, has4K, variants }
// ---------------------------------------------------------------------------
async function probeMasterPlaylist(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const text = await res.text();
    const variants = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const m = line.match(/RESOLUTION=(\d+)x(\d+)/);
        const bw = line.match(/BANDWIDTH=(\d+)/);
        if (m) variants.push({ w: +m[1], h: +m[2], bw: bw ? +bw[1] : 0 });
      }
    }
    if (variants.length === 0) return null;
    variants.sort((a, b) => b.bw - a.bw);
    const best = variants[0];
    const r = Math.max(best.w, best.h);
    return {
      quality: r >= 3840 ? '2160p' : r >= 1920 ? '1080p' : r >= 1280 ? '720p' : 'SD',
      width: best.w, height: best.h, has4K: r >= 3840,
      variants: variants.map(v => `${v.w}x${v.h}`),
    };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
function buildStream(opts) {
  const is4K = opts.quality === '2160p';
  return {
    name: PROVIDER_NAME + ' - ' + opts.serverLabel + (is4K ? ' 4K' : ''),
    title: opts.title,
    url: opts.url,
    quality: opts.quality || '1080p',
    type: 'application/vnd.apple.mpegurl',
    behaviorHints: { bingeGroup: opts.bingeGroup || 'stellar-' + opts.serverLabel.toLowerCase() },
    ...(opts.subtitles && opts.subtitles.length > 0 ? {
      subtitles: opts.subtitles.map(s => ({ id: s.language || 'en', url: s.url, lang: s.label || s.language || 'English' }))
    } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isMovie = type !== 'tv';
  const mediaType = isMovie ? 'movie' : 'tv';

  if (!isMovie && (season == null || episode == null)) return [];

  console.log('[Stellar] Request: tmdb=' + tmdbId + ' type=' + type + (isMovie ? '' : ' S' + season + 'E' + episode));

  // TMDB info
  let info;
  try {
    info = await Promise.race([
      getTMDBInfo(tmdbId, type),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TMDB timeout')), 10000)),
    ]);
  } catch (e) { info = { title: 'TMDB ' + tmdbId, year: '', type, tmdbId }; }
  console.log('[Stellar] TMDB: ' + info.title + (info.year ? ' (' + info.year + ')' : ''));

  const allStreams = [];

  // Resolve stream (default source — usually Orbit)
  console.log('[Stellar] Resolving stream via /api/resolve (PoW + AES-GCM)...');
  let result;
  try {
    result = await resolveStreamUrl(mediaType, tmdbId, season, episode);
    console.log('[Stellar] Resolved: source=' + result.source + ', availableSources=' + JSON.stringify(result.availableSources));
  } catch (e) {
    console.log('[Stellar] Resolve failed: ' + e.message);
    return [];
  }

  if (!result.url) { console.log('[Stellar] No stream URL'); return []; }

  // Probe for resolution (4K detection)
  const probe = await probeMasterPlaylist(result.url);
  if (probe) {
    console.log('[Stellar] Master playlist: ' + probe.variants.join(', ') + ' → max=' + probe.width + 'x' + probe.height + ' (' + probe.quality + (probe.has4K ? ' 4K!' : '') + ')');
  }

  const quality = probe ? probe.quality : '1080p';
  const resStr = probe ? ' ' + probe.width + 'x' + probe.height : '';
  const sourceLabel = result.source || 'Default';

  allStreams.push(buildStream({
    title: `${info.title} [Stellar ${sourceLabel}${resStr}${probe && probe.has4K ? ' 4K' : ''}]`,
    url: result.url,
    quality,
    serverLabel: sourceLabel,
    bingeGroup: `stellar-${sourceLabel.toLowerCase()}-${tmdbId}`,
    subtitles: result.subtitles,
  }));
  console.log('[Stellar] + ' + sourceLabel + ' (' + quality + '): ' + result.url.slice(0, 80));

  // Try other available sources
  if (result.availableSources && result.availableSources.length > 1) {
    for (const src of result.availableSources) {
      if (src === result.source) continue;
      try {
        console.log('[Stellar] Trying source: ' + src + '...');
        const altResult = await resolveStreamUrl(mediaType, tmdbId, season, episode, src);
        if (altResult.url) {
          const altProbe = await probeMasterPlaylist(altResult.url);
          const altQuality = altProbe ? altProbe.quality : '1080p';
          const altResStr = altProbe ? ' ' + altProbe.width + 'x' + altProbe.height : '';

          allStreams.push(buildStream({
            title: `${info.title} [Stellar ${src}${altResStr}${altProbe && altProbe.has4K ? ' 4K' : ''}]`,
            url: altResult.url,
            quality: altQuality,
            serverLabel: src,
            bingeGroup: `stellar-${src.toLowerCase()}-${tmdbId}`,
            subtitles: altResult.subtitles,
          }));
          console.log('[Stellar] + ' + src + ' (' + altQuality + '): ' + altResult.url.slice(0, 80));
        }
      } catch (e) {
        console.log('[Stellar]   ' + src + ' failed: ' + e.message);
      }
    }
  }

  // Sort by quality (4K first)
  const qOrder = { '2160p': 0, '1080p': 1, '720p': 2, '480p': 3, 'SD': 4 };
  allStreams.sort((a, b) => (qOrder[a.quality] || 99) - (qOrder[b.quality] || 99));

  console.log('[Stellar] ' + allStreams.length + ' streams total');
  return allStreams;
}

module.exports = {
  getStreams, getTMDBInfo, solvePoW, encryptPayload,
  resolveStreamUrl, probeMasterPlaylist,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) { console.log('Usage: node stellar_all_in_one.js <tmdbId> <movie|tv> [season] [episode]'); process.exit(1); }
  getStreams(args[0], args[1], args[2] ? parseInt(args[2]) : null, args[3] ? parseInt(args[3]) : null)
    .then(s => {
      console.log('\n=== Final streams ===');
      s.forEach((x, i) => console.log((i+1) + '. ' + x.name + ' | ' + x.quality + ' | ' + x.type + '\n   ' + x.url.slice(0, 120)));
      console.log('\nTotal: ' + s.length);
    })
    .catch(e => console.error('FATAL: ' + e.stack));
}
