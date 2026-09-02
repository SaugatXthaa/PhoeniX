// Stellar (stellar.rip) — Direct Stream Extractor with 4K Support
// =========================================================================
// Returns DIRECT playable HLS stream URLs from stellar.rip via the
// /api/playback-init (PoW) + /api/encrypt flow.
//
// FLOW (6 steps per source):
//   1. Fetch embed page HTML → extract __REQUEST_TOKEN__ (JWT, server-set)
//   2. POST /api/playback-init → PoW challenge (difficulty=18 bits)
//   3. Solve PoW: SHA-256(challenge + nonce) with 18 leading zero bits (~200ms)
//   4. POST /api/playback-init with PoW solution → get streamToken (JWT, 120s TTL)
//   5. POST /api/encrypt { data: {mediaId, mediaType, tv_slug, source}, endpoint: "stream-encrypted", requestToken }
//      → { url: "/api/stream-encrypted?data=..." }
//   6. GET opaque URL + "?requestToken=...&token=..." → stream URL on proxy2.heistotron.uk
//
// SOURCES (6 available, each with different quality):
//   s0: 1080p (default, source.heistotron.uk)
//   s1: 720p  (proxy2.heistotron.uk)
//   s2: 4K!   (proxy2.heistotron.uk) — 3840x2160 + 1080p/720p/360p
//   s3: 1080p scope (proxy2.heistotron.uk) — 1920x800
//   s4: 1080p/720p/360p scope (proxy2.heistotron.uk)
//   s5: 1080p/720p/360p scope (proxy2.heistotron.uk)
//
// The stream URL needs Referer: embed URL + Origin: https://stellar.rip
// Stremio plays via behaviorHints.proxyHeaders.request
//
// USAGE:
//   const stellar = require('./stellar_all_in_one.js');
//   const streams = await stellar.getStreams('27205', 'movie');
//   const streams = await stellar.getStreams('1396', 'tv', 1, 1);

'use strict';

const crypto = require('crypto');

const PROVIDER_NAME = 'Stellar';
const STELLAR_RIP = 'https://stellar.rip';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// All available source IDs (s2 has 4K!)
const ALL_SOURCES = ['s2', 's0', 's3', 's1', 's4', 's5'];

// ---------------------------------------------------------------------------
// Solve PoW: SHA-256(challenge + nonce) with N leading zero BITS
// ---------------------------------------------------------------------------
function solveBitPoW(challenge, difficultyBits) {
  const byteCount = Math.floor(difficultyBits / 8);
  const extraBits = difficultyBits % 8;
  const extraMask = extraBits ? (0xFF << (8 - extraBits)) & 0xFF : 0;
  for (let nonce = 0; nonce < 100000000; nonce++) {
    const hash = crypto.createHash('sha256').update(challenge + nonce).digest();
    let ok = true;
    for (let i = 0; i < byteCount; i++) { if (hash[i] !== 0) { ok = false; break; } }
    if (ok && extraMask && (hash[byteCount] & extraMask) !== 0) ok = false;
    if (ok) return nonce;
  }
  throw new Error('PoW timed out');
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
// Step 1: Fetch embed page → extract __REQUEST_TOKEN__
// ---------------------------------------------------------------------------
async function getRequestToken(tmdbId, type, season, episode) {
  const isMovie = type !== 'tv';
  const embedPath = isMovie
    ? `/en/watch/embed/movie/${tmdbId}`
    : `/en/watch/embed/tv/${tmdbId}-${season}-${episode}`;
  const res = await fetch(STELLAR_RIP + embedPath, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Embed page HTTP ${res.status}`);
  const html = await res.text();
  const match = html.match(/__REQUEST_TOKEN__\s*=\s*"([^"]+)"/);
  if (!match) throw new Error('No __REQUEST_TOKEN__ in embed page');
  return { token: match[1], embedPath };
}

// ---------------------------------------------------------------------------
// Steps 2-4: Get stream token via /api/playback-init (PoW)
// ---------------------------------------------------------------------------
async function getStreamToken(mediaId, mediaType, tvSlug, requestToken) {
  const initRes = await fetch(STELLAR_RIP + '/api/playback-init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': STELLAR_RIP, 'User-Agent': UA },
    body: JSON.stringify({ mediaId, mediaType, tv_slug: tvSlug || '', requestToken }),
    signal: AbortSignal.timeout(15000),
  });
  if (!initRes.ok) throw new Error(`playback-init HTTP ${initRes.status}`);
  const initData = await initRes.json();
  if (!initData.requiresPow || !initData.pow) {
    if (initData.token) return initData.token;
    throw new Error('No PoW challenge and no token');
  }
  const { challengeId, challenge, difficulty } = initData.pow;
  const nonce = solveBitPoW(challenge, difficulty);
  const solveRes = await fetch(STELLAR_RIP + '/api/playback-init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': STELLAR_RIP, 'User-Agent': UA },
    body: JSON.stringify({ mediaId, mediaType, tv_slug: tvSlug || '', requestToken, pow: { challengeId, nonce: String(nonce) } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!solveRes.ok) throw new Error(`playback-init solve HTTP ${solveRes.status}`);
  const solveData = await solveRes.json();
  if (!solveData.success || !solveData.token) throw new Error('No stream token after PoW');
  return solveData.token;
}

// ---------------------------------------------------------------------------
// Steps 5-6: Get stream URL for a specific source
// ---------------------------------------------------------------------------
async function resolveSource(mediaId, mediaType, tvSlug, requestToken, streamToken, source, embedPath) {
  const encRes = await fetch(STELLAR_RIP + '/api/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': STELLAR_RIP, 'User-Agent': UA },
    body: JSON.stringify({ data: { mediaId, mediaType, tv_slug: tvSlug || '', source }, endpoint: 'stream-encrypted', requestToken }),
    signal: AbortSignal.timeout(15000),
  });
  if (!encRes.ok) return null;
  const encData = await encRes.json();
  if (!encData.url) return null;
  const opaqueUrl = encData.url + (encData.url.includes('?') ? '&' : '?') +
    'requestToken=' + encodeURIComponent(requestToken) + '&token=' + encodeURIComponent(streamToken);
  const streamRes = await fetch(STELLAR_RIP + opaqueUrl, {
    headers: { 'Referer': STELLAR_RIP + embedPath, 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!streamRes.ok) return null;
  const streamData = await streamRes.json();
  if (!streamData.success || !streamData.data || !streamData.data.stream_url) return null;
  const streamUrl = streamData.data.stream_url;
  if (streamUrl.includes('playback-unavailable')) return null;
  return streamUrl;
}

// ---------------------------------------------------------------------------
// Probe master playlist for resolution (needs Referer + Origin!)
// ---------------------------------------------------------------------------
async function probeMasterPlaylist(url, embedPath) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Referer': STELLAR_RIP + embedPath, 'Origin': STELLAR_RIP },
      signal: AbortSignal.timeout(10000),
    });
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
    if (variants.length === 0) return { quality: '1080p', width: 0, height: 0, has4K: false, variants: [] };
    variants.sort((a, b) => b.bw - a.w);
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
    behaviorHints: {
      bingeGroup: opts.bingeGroup || 'stellar-' + opts.serverLabel.toLowerCase(),
      proxyHeaders: { request: { 'User-Agent': UA, 'Referer': opts.referer, 'Origin': STELLAR_RIP } },
    },
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isMovie = type !== 'tv';
  const mediaType = isMovie ? 'movie' : 'tv';
  const mediaId = Number(tmdbId);
  const tvSlug = isMovie ? '' : `${season}-${episode}`;
  if (!isMovie && (season == null || episode == null)) return [];

  console.log('[Stellar] Request: tmdb=' + tmdbId + ' type=' + type + (isMovie ? '' : ' S' + season + 'E' + episode));

  let info;
  try {
    info = await Promise.race([
      getTMDBInfo(tmdbId, type),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TMDB timeout')), 10000)),
    ]);
  } catch (e) { info = { title: 'TMDB ' + tmdbId, year: '', type, tmdbId }; }
  console.log('[Stellar] TMDB: ' + info.title + (info.year ? ' (' + info.year + ')' : ''));

  try {
    // Step 1: Get request token
    const { token: requestToken, embedPath } = await getRequestToken(tmdbId, type, season, episode);
    console.log('[Stellar] Request token acquired');

    // Steps 2-4: Get stream token (PoW)
    console.log('[Stellar] Solving PoW (18 bits)...');
    const streamToken = await getStreamToken(mediaId, mediaType, tvSlug, requestToken);
    console.log('[Stellar] Stream token acquired');

    // Steps 5-6: Try all sources (s2 first for 4K!)
    const allStreams = [];
    for (const source of ALL_SOURCES) {
      try {
        const streamUrl = await resolveSource(mediaId, mediaType, tvSlug, requestToken, streamToken, source, embedPath);
        if (!streamUrl) { console.log('[Stellar]   ' + source + ': unavailable'); continue; }

        const probe = await probeMasterPlaylist(streamUrl, embedPath);
        const quality = probe ? probe.quality : '1080p';
        const resStr = probe && probe.width ? ` ${probe.width}x${probe.height}` : '';
        const is4K = probe && probe.has4K;

        allStreams.push(buildStream({
          title: `${info.title} [Stellar ${source}${resStr}${is4K ? ' 4K' : ''}]`,
          url: streamUrl,
          quality,
          serverLabel: source,
          bingeGroup: `stellar-${source}-${tmdbId}`,
          referer: STELLAR_RIP + embedPath,
        }));
        console.log('[Stellar] + ' + source + ' (' + quality + (is4K ? ' 4K!' : '') + '): ' + streamUrl.slice(0, 60) + '...');
      } catch (e) {
        console.log('[Stellar]   ' + source + ': ' + e.message);
      }
    }

    // Sort by quality (4K first)
    const qOrder = { '2160p': 0, '1080p': 1, '720p': 2, '480p': 3, 'SD': 4 };
    allStreams.sort((a, b) => (qOrder[a.quality] || 99) - (qOrder[b.quality] || 99));

    console.log('[Stellar] ' + allStreams.length + ' streams total');
    return allStreams;
  } catch (e) {
    console.log('[Stellar] Error: ' + e.message);
    return [];
  }
}

module.exports = {
  getStreams, getTMDBInfo, getRequestToken, getStreamToken,
  resolveSource, solveBitPoW, probeMasterPlaylist,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) { console.log('Usage: node stellar_all_in_one.js <tmdbId> <movie|tv> [season] [episode]'); process.exit(1); }
  getStreams(args[0], args[1], args[2] ? parseInt(args[2]) : null, args[3] ? parseInt(args[3]) : null)
    .then(s => {
      console.log('\n=== Final streams ===');
      s.forEach((x, i) => console.log((i+1) + '. ' + x.name + ' | ' + x.quality + ' | ' + x.url.slice(0, 100)));
      console.log('\nTotal: ' + s.length);
    })
    .catch(e => console.error('FATAL: ' + e.stack));
}
