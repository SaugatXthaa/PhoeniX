// Stellar (stellar.rip) — Direct Stream Extractor with 4K Support
// =========================================================================
// Returns DIRECT playable HLS stream URLs from stellar.rip via the
// /api/request-token + /api/playback-init (PoW) + /api/encrypt flow.
//
// TASK 64 UPDATE (2026-09-19, recovered from the deployed site bundles):
//   1. The server catalog EXPANDED from 6 to 18 servers and the ids were
//      remapped. Current catalog (from /_next chunk 33hvzlvd8f2ku.js):
//        s24 Spica, s25 Vega, s0 Sirius, s2 Rigel, s26 Capella,
//        s19 Betelgeuse, s13 Arcturus, s4 Procyon, s5 Aldebaran, s6 Deneb,
//        s15 Altair, s7 Antares, s8 Regulus, s16 Castor, s1 Polaris,
//        s12 Fomalhaut, s10 Bellatrix, s3 Pollux
//      (most carry capabilities.maxResolutionHint:2160 / 4K "confirmed")
//   2. /api/request-token now REQUIRES the body {"path": "/watch/embed/…",
//      "embedPlayback": true} — the embed page's inline bootstrap sends
//      exactly that (verified in a live browser session). Empty bodies were
//      previously accepted but no longer reflect the embed session.
//   3. New endpoint GET /api/dead-sources?mediaId&mediaType&tv_slug →
//      {deadSources: []} — servers listed there answer playback-unavailable;
//      skip them instead of burning encrypt calls.
//   4. The site self-rate-limits /api/encrypt to ~6/minute with a 60s
//      window (bundle constant n>=6 → wait). We pace in batches of 6 and
//      retry once on 429 (Retry-After honored when present).
//   5. The stream-encrypted step answers /api/playback-unavailable/…
//      per-source for clients it gates (datacenter IPs, drought windows).
//      Those are dropped HONESTLY — the provider returns only real streams.
//
// FLOW (per resolve):
//   1. GET embed page → session cookies (_stellar_site, stellar-language)
//   2. POST /api/request-token {path, embedPlayback:true} → requestToken
//   3. POST /api/playback-init → PoW challenge (18 bits) → solve → streamToken
//   4. GET /api/dead-sources → skip set
//   5. POST /api/encrypt {data:{mediaId, mediaType, tv_slug, source},
//      endpoint:"stream-encrypted", requestToken} per server (paced)
//      → {url:"/api/stream-encrypted?data=…"} → fetch with requestToken+token
//      → {data:{stream_url}} — drop playback-unavailable paths
//   6. Probe master playlist for resolution (4K detection)
//
// The stream URL needs Referer: embed URL + Origin: https://stellar.rip
// Stremio plays via behaviorHints.proxyHeaders.request
//
// USAGE:
//   const stellar = require('./stellarrip.cjs');
//   const streams = await stellar.getStreams('27205', 'movie');
//   const streams = await stellar.getStreams('1396', 'tv', 1, 1);

'use strict';

const crypto = require('crypto');

const PROVIDER_NAME = 'Stellar';
const STELLAR_RIP = 'https://stellar.rip';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Current 18-server catalog (id → label), bundle-verified 2026-09-19.
// Order = the site's own display order (4K-confirmed first).
const SERVERS = [
  { id: 's24', name: 'Spica' },
  { id: 's25', name: 'Vega' },
  { id: 's0', name: 'Sirius' },
  { id: 's2', name: 'Rigel' },
  { id: 's26', name: 'Capella' },
  { id: 's19', name: 'Betelgeuse' },
  { id: 's13', name: 'Arcturus' },
  { id: 's4', name: 'Procyon' },
  { id: 's5', name: 'Aldebaran' },
  { id: 's6', name: 'Deneb' },
  { id: 's15', name: 'Altair' },
  { id: 's7', name: 'Antares' },
  { id: 's8', name: 'Regulus' },
  { id: 's16', name: 'Castor' },
  { id: 's1', name: 'Polaris' },
  { id: 's12', name: 'Fomalhaut' },
  { id: 's10', name: 'Bellatrix' },
  { id: 's3', name: 'Pollux' },
];
const SERVER_NAMES = Object.fromEntries(SERVERS.map(s => [s.id, s.name]));

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
// Step 1: Fetch embed page → session cookies (+ inline token rollback guard)
// Task 41: the embed page no longer inlines the JWT — the session comes from
// POST /api/request-token. Task 64: that POST now carries {path, embedPlayback:true}.
// ---------------------------------------------------------------------------
async function getRequestToken(tmdbId, type, season, episode) {
  const isMovie = type !== 'tv';
  const watchPath = isMovie
    ? `/watch/embed/movie/${tmdbId}`
    : `/watch/embed/tv/${tmdbId}-${season}-${episode}`;
  const embedPath = `/en${watchPath}`;
  // Task 82 (2026-09-23): the site degraded to 8-12s per round-trip; the old
  // flow downloaded the full 92KB embed body just to regex an inline token
  // that no longer exists (verified: `__REQUEST_TOKEN__` string appears in
  // bundle code only, the value-assignment regex matches nothing). We now
  // read HEADERS ONLY (session cookies) and cancel the body, going straight
  // to POST /api/request-token — saving the body transfer from the critical
  // path. If the POST fails we fall back to the full body read + inline
  // regex once, covering a site-side revert to inline-only tokens.
  const res = await fetch(STELLAR_RIP + embedPath, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Embed page HTTP ${res.status}`);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookieJar = setCookies.map(c => c.split(';')[0]).filter(Boolean).join('; ');
  try { await res.body?.cancel(); } catch { /* body already consumed */ }

  // Task 64 body — path WITHOUT the /en prefix + embedPlayback, verbatim from
  // the site's inline bootstrap: {"path":"/watch/embed/movie/27205","embedPlayback":true}
  try {
    const tokRes = await fetch(STELLAR_RIP + '/api/request-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': STELLAR_RIP, 'Referer': STELLAR_RIP + embedPath, 'User-Agent': UA, ...(cookieJar && { Cookie: cookieJar }) },
      body: JSON.stringify({ path: watchPath, embedPlayback: true }),
      signal: AbortSignal.timeout(12000),
    });
    if (tokRes.ok) {
      const tokData = await tokRes.json().catch(() => null);
      const merged = [cookieJar, ...(tokRes.headers.getSetCookie ? tokRes.headers.getSetCookie().map(c => c.split(';')[0]) : [])].filter(Boolean).join('; ');
      if (tokData && tokData.token) return { token: tokData.token, embedPath, cookieJar: merged };
    }
  } catch { /* fall through to the inline-token fallback */ }

  // Fallback: full body read + inline token (Task 41 path, kept for safety).
  const htmlRes = await fetch(STELLAR_RIP + embedPath, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000),
  });
  if (!htmlRes.ok) throw new Error('No __REQUEST_TOKEN__ in embed page and /api/request-token failed');
  const html = await htmlRes.text();
  const sc2 = htmlRes.headers.getSetCookie ? htmlRes.headers.getSetCookie().map(c => c.split(';')[0]) : [];
  const jar2 = [cookieJar, ...sc2].filter(Boolean).join('; ');
  const match = html.match(/__REQUEST_TOKEN__\s*=\s*"([^"]+)"/);
  if (match) return { token: match[1], embedPath, cookieJar: jar2 };
  throw new Error('No __REQUEST_TOKEN__ in embed page and /api/request-token failed');
}

// ---------------------------------------------------------------------------
// Steps 2-4: Get stream token via /api/playback-init (PoW)
// ---------------------------------------------------------------------------
async function getStreamToken(mediaId, mediaType, tvSlug, requestToken, cookieJar, embedPath) {
  const initRes = await fetch(STELLAR_RIP + '/api/playback-init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': STELLAR_RIP, 'Referer': STELLAR_RIP + embedPath, 'User-Agent': UA, ...(cookieJar && { Cookie: cookieJar }) },
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
    headers: { 'Content-Type': 'application/json', 'Origin': STELLAR_RIP, 'Referer': STELLAR_RIP + embedPath, 'User-Agent': UA, ...(cookieJar && { Cookie: cookieJar }) },
    body: JSON.stringify({ mediaId, mediaType, tv_slug: tvSlug || '', requestToken, pow: { challengeId, nonce: String(nonce) } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!solveRes.ok) throw new Error(`playback-init solve HTTP ${solveRes.status}`);
  const solveData = await solveRes.json();
  if (!solveData.success || !solveData.token) throw new Error('No stream token after PoW');
  return solveData.token;
}

// ---------------------------------------------------------------------------
// Step 5: Get stream URL for a specific server (paced; Retry-After aware)
// ---------------------------------------------------------------------------
async function resolveSource(mediaId, mediaType, tvSlug, requestToken, streamToken, source, embedPath, cookieJar) {
  const encRes = await fetch(STELLAR_RIP + '/api/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': STELLAR_RIP, 'Referer': STELLAR_RIP + embedPath, 'User-Agent': UA, ...(cookieJar && { Cookie: cookieJar }) },
    body: JSON.stringify({ data: { mediaId, mediaType, tv_slug: tvSlug || '', source }, endpoint: 'stream-encrypted', requestToken }),
    signal: AbortSignal.timeout(12000),
  });
  if (encRes.status === 429) return { retryAfter: encRes.headers.get('retry-after') };
  if (!encRes.ok) return null;
  const encData = await encRes.json();
  if (!encData.url) return null;
  const opaqueUrl = encData.url + (encData.url.includes('?') ? '&' : '?') +
    'requestToken=' + encodeURIComponent(requestToken) + '&token=' + encodeURIComponent(streamToken);
  const streamRes = await fetch(STELLAR_RIP + opaqueUrl, {
    headers: { 'Referer': STELLAR_RIP + embedPath, 'User-Agent': UA },
    signal: AbortSignal.timeout(12000),
  });
  if (!streamRes.ok) return null;
  const streamData = await streamRes.json();
  if (!streamData.success || !streamData.data || !streamData.data.stream_url) return null;
  const streamUrl = streamData.data.stream_url;
  if (streamUrl.includes('playback-unavailable')) return null;
  return { streamUrl };
}

// ---------------------------------------------------------------------------
// Dead-source skip set (Task 64 endpoint)
// ---------------------------------------------------------------------------
async function fetchDeadSources(mediaId, mediaType, tvSlug, cookieJar, embedPath) {
  try {
    const q = `mediaId=${encodeURIComponent(mediaId)}&mediaType=${encodeURIComponent(mediaType)}&tv_slug=${encodeURIComponent(tvSlug || '')}`;
    const res = await fetch(STELLAR_RIP + '/api/dead-sources?' + q, {
      headers: { 'User-Agent': UA, Referer: STELLAR_RIP + embedPath, ...(cookieJar && { Cookie: cookieJar }) },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return new Set();
    const j = await res.json();
    return new Set(Array.isArray(j.deadSources) ? j.deadSources : []);
  } catch { return new Set(); }
}

// ---------------------------------------------------------------------------
// Probe master playlist for resolution (needs Referer + Origin!)
// ---------------------------------------------------------------------------
async function probeMasterPlaylist(url, embedPath) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Referer': STELLAR_RIP + embedPath, 'Origin': STELLAR_RIP },
      signal: AbortSignal.timeout(8000),
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
    const { token: requestToken, embedPath, cookieJar } = await getRequestToken(tmdbId, type, season, episode);
    console.log('[Stellar] Request token acquired');

    // Task 82: dead-sources needs ONLY cookies + embedPath — run it in
    // parallel with the PoW chain instead of after it (saves 2-4s of the
    // ~32s convergence budget on the degraded site). Best-effort: an empty
    // set just means a fuller sweep.
    const chainT0 = Date.now();
    const [streamToken, dead] = await Promise.all([
      getStreamToken(mediaId, mediaType, tvSlug, requestToken, cookieJar, embedPath),
      fetchDeadSources(mediaId, mediaType, tvSlug, cookieJar, embedPath),
    ]);
    console.log('[Stellar] Stream token acquired; dead=' + dead.size);
    const servers = SERVERS.filter(s => !dead.has(s.id));

    // Paced sweep: the site's own client limits itself to ~6 encrypt calls
    // per 60s window AND answers "playback-unavailable" (not 429) to clients
    // it gates — Task 82 live-measured: an 18-encrypt burst @72/min saw every
    // subsequent encrypt go unavailable, while a single paced call right
    // before had returned a real stream-OK URL. So the sweep now covers the
    // 12 best servers (the 4K-confirmed-first order), batches of 6 with a
    // 3s gap (≈12/min worst case, 3× gentler than before), and starts a new
    // batch only while there's realistic budget — soft stop (results in
    // hand) at 24s, hard stop at 29s, both inside the wrapper's 32s race and
    // the resolver's 35s cutoff.
    const allStreams = [];
    let hit429 = false;
    const BATCH = 6;
    const SWEEP_CAP = 12;
    const sweepServers = servers.slice(0, SWEEP_CAP);
    for (let i = 0; i < sweepServers.length; i += BATCH) {
      const elapsed = Date.now() - chainT0;
      if (i > 0 && (allStreams.length > 0 ? elapsed > 24000 : elapsed > 29000)) {
        console.log('[Stellar] sweep deadline @' + (elapsed / 1000).toFixed(1) + 's — stopping with ' + allStreams.length + ' streams');
        break;
      }
      const batch = sweepServers.slice(i, i + BATCH);
      const settled = await Promise.allSettled(batch.map(async (srv) => {
        const r = await resolveSource(mediaId, mediaType, tvSlug, requestToken, streamToken, srv.id, embedPath, cookieJar);
        return { srv, r };
      }));
      const hits = [];
      for (const s of settled) {
        if (s.status !== 'fulfilled' || !s.value) continue;
        const { srv, r } = s.value;
        if (!r) continue;
        if (r.retryAfter) { hit429 = true; continue; }
        hits.push({ srv, streamUrl: r.streamUrl });
      }
      // Task 82: probe all playlists in PARALLEL (was sequential per stream —
      // an 8s timeout each used to serialize 6-18 probes after the sweep).
      const probes = await Promise.allSettled(hits.map(h =>
        probeMasterPlaylist(h.streamUrl, embedPath)));
      hits.forEach((h, k) => {
        const p = probes[k];
        const probe = p.status === 'fulfilled' ? p.value : null;
        const quality = probe ? probe.quality : '1080p';
        const resStr = probe && probe.width ? ` ${probe.width}x${probe.height}` : '';
        const is4K = probe && probe.has4K;
        console.log('[Stellar] + ' + h.srv.name + ' (' + quality + (is4K ? ' 4K!' : '') + '): ' + h.streamUrl.slice(0, 60) + '...');
        allStreams.push(buildStream({
          title: `${info.title} [Stellar ${h.srv.name}${resStr}${is4K ? ' 4K' : ''}]`,
          url: h.streamUrl,
          quality,
          serverLabel: h.srv.name,
          bingeGroup: `stellar-${h.srv.id}-${tmdbId}`,
          referer: STELLAR_RIP + embedPath,
        }));
      });
      // one 429 retry pass for the rate-limited servers after a short pause
      if (hit429 && i + BATCH < sweepServers.length && (Date.now() - chainT0) < 20000) {
        await new Promise(r2 => setTimeout(r2, 3000));
        hit429 = false;
      }
    }

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
  resolveSource, solveBitPoW, probeMasterPlaylist, SERVERS, SERVER_NAMES,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) { console.log('Usage: node stellarrip.cjs <tmdbId> <movie|tv> [season] [episode]'); process.exit(1); }
  getStreams(args[0], args[1], args[2] ? parseInt(args[2]) : null, args[3] ? parseInt(args[3]) : null)
    .then(s => {
      console.log('\n=== Final streams ===');
      s.forEach((x, i) => console.log((i+1) + '. ' + x.name + ' | ' + x.quality + ' | ' + x.url.slice(0, 100)));
      console.log('\nTotal: ' + s.length);
    })
    .catch(e => console.error('FATAL: ' + e.stack));
}
