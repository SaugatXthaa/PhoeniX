/**
 * 2Peckle / ShowBox Scraper — Node.js
 * ====================================
 * 2Peckle is a PenguPlay provider that wraps ShowBox.
 * ShowBox itself is just a curated index of FebBox share links.
 *
 * Architecture (verified live 2026-08-10):
 *
 *   ┌─ pengu.uk/2peckle ────────────────────────────────────┐
 *   │  Server-side wrapper with FebBox account pool          │
 *   │  (the "100 GB shared cookie-quota")                    │
 *   └─┬──────────────────────────────────────────────────────┘
 *     │
 *     ▼
 *   ┌─ showbox.media ──────────────────────────────────────┐
 *   │  Public movie/TV index (ThinkPHP on nginx)            │
 *   │  Maps title -> FebBox share link                      │
 *   │  GET /search/autocomplate2?keyword=<title>            │
 *   │  GET /index/share_link?id=<id>&type=<1|2>             │
 *   └─┬──────────────────────────────────────────────────────┘
 *     │
 *     ▼
 *   ┌─ febbox.com ─────────────────────────────────────────┐
 *   │  The actual file storage / CDN (Cloudflare-fronted)   │
 *   │  GET /file/file_share_list?share_key=<code>  (anon ✅)│
 *   │  GET /file/share_download?share_key=<code>   (cookie)│
 *   │  GET /console/video_quality_list?fid=<fid>   (cookie)│
 *   │  Direct MP4/MKV downloads (range-seekable)            │
 *   └───────────────────────────────────────────────────────┘
 *
 *   ┌─ id-mapping-api-showbox-proxy.hf.space ──────────────┐
 *   │  TMDB -> ShowBox ID mapping proxy (Nuvio addon)       │
 *   │  GET /api/media/movie/<tmdb>            -> {id,mid}   │
 *   │  GET /api/media/tv/<tmdb>/<s>/<e>       -> {id,mid}   │
 *   │  GET /api/media/movie/<tmdb>?cookie=<jwt> -> versions│
 *   │  (returns streams when cookie provided)               │
 *   └───────────────────────────────────────────────────────┘
 *
 * AUTH REQUIRED:
 *   A FebBox `ui` JWT cookie (100 GB / month quota per account).
 *   Get it: register at febbox.com (Google OAuth only), DevTools → Cookies → ui.
 *   Set env var: FEBBOX_COOKIE=<jwt>   (or FEBBOX_COOKIES=jwt1,jwt2,... for rotation)
 *
 * WITHOUT COOKIE:
 *   The scraper can still:
 *     - Search ShowBox by title
 *     - Resolve TMDB -> ShowBox ID via the proxy
 *     - List files in FebBox shares (file names, sizes, qualities)
 *   But cannot resolve direct stream URLs — they'll be `null`.
 *   (This is what PenguPlay does server-side with their cookie pool.)
 *
 * Install:
 *   npm install axios cheerio
 *
 * Usage:
 *   node 2peckle_scraper.js search "<query>"
 *   node 2peckle_scraper.js movie <tmdb_id>
 *   node 2peckle_scraper.js movie-by-title "<title>" [year]
 *   node 2peckle_scraper.js tv <tmdb_id> <season> <episode>
 *
 * Examples:
 *   node 2peckle_scraper.js movie 634649          # Spider-Man: No Way Home
 *   node 2peckle_scraper.js tv 82856 1 1          # The Mandalorian S01E01
 *   FEBBOX_COOKIE=eyJ... node 2peckle_scraper.js movie 634649   # with stream URLs
 */

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');

const SHOWBOX_BASE = 'https://showbox.media';
const FEBBOX_BASE = 'https://www.febbox.com';
const PROXY_BASE = 'https://id-mapping-api-showbox-proxy.hf.space/api/media';
const TMDB_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE = 'https://api.themoviedb.org/3';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                   '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Cookie management (rotation + quota check), ported from
// tapframe/NuvioStreamsAddon/providers/Showbox.js
// ---------------------------------------------------------------------------

function loadCookies() {
  const raw = process.env.FEBBOX_COOKIES || process.env.FEBBOX_COOKIE || '';
  return raw.split(',')
    .map(c => c.trim())
    .filter(Boolean)
    .map(c => c.startsWith('ui=') ? c.slice(3) : c); // store the bare JWT
}

function asCookieHeader(jwt) {
  return jwt.startsWith('ui=') ? jwt : `ui=${jwt}`;
}

/** Check remaining quota for one cookie. Returns { ok, remainingMB, cookie }. */
async function checkCookieQuota(jwt) {
  try {
    const resp = await axios.get(`${FEBBOX_BASE}/console/user_cards`, {
      headers: {
        Cookie: asCookieHeader(jwt),
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'User-Agent': BROWSER_UA,
      },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (resp.status === 200 && resp.data && resp.data.data && resp.data.data.flow) {
      const f = resp.data.data.flow;
      const remaining = (Number(f.traffic_limit_mb) || 0) - (Number(f.traffic_usage_mb) || 0);
      return { ok: true, remainingMB: remaining, cookie: jwt };
    }
  } catch (e) {
    process.stderr.write(`[quota] check failed: ${e.message}\n`);
  }
  return { ok: false, remainingMB: -1, cookie: jwt };
}

/** Pick the cookie with the most remaining quota. */
async function selectBestCookie(jwts) {
  if (jwts.length === 0) return { cookie: null, remainingMB: -1 };
  if (jwts.length === 1) {
    const r = await checkCookieQuota(jwts[0]);
    return { cookie: r.cookie, remainingMB: r.remainingMB };
  }
  const results = await Promise.all(jwts.map(checkCookieQuota));
  const ok = results.filter(r => r.ok).sort((a, b) => b.remainingMB - a.remainingMB);
  if (ok.length) return { cookie: ok[0].cookie, remainingMB: ok[0].remainingMB };
  return { cookie: jwts[0], remainingMB: -1 };
}

// ---------------------------------------------------------------------------
// Filename parsing (ported from Nuvio providers/Showbox.js)
// ---------------------------------------------------------------------------

function parseQualityFromLabel(label) {
  if (!label) return 'ORG';
  const l = String(label).toLowerCase();
  if (/(2160p|2160|4k|uhd)/.test(l)) return '2160p';
  if (/(1080p|1080)/.test(l)) return '1080p';
  if (/(720p|720)/.test(l)) return '720p';
  if (/(480p|480)/.test(l)) return '480p';
  if (/(360p|360)/.test(l)) return '360p';
  if (/hd/.test(l)) return '720p';
  if (/sd/.test(l)) return '480p';
  return 'ORG';
}

function extractCodecDetails(text) {
  if (!text || typeof text !== 'string') return [];
  const out = new Set();
  const t = text.toLowerCase();
  if (/(dolby vision|dovi|\.dv\.)/.test(t)) out.add('DV');
  if (/hdr10\+|hdr10plus/.test(t)) out.add('HDR10+');
  else if (/hdr/.test(t)) out.add('HDR');
  if (/sdr/.test(t)) out.add('SDR');
  if (/av1/.test(t)) out.add('AV1');
  else if (/h265|x265|hevc/.test(t)) out.add('H.265');
  else if (/h264|x264|avc/.test(t)) out.add('H.264');
  if (/atmos/.test(t)) out.add('Atmos');
  if (/truehd|true-hd/.test(t)) out.add('TrueHD');
  else if (/dts-hd ma|dtshdma|dts-hdhr/.test(t)) out.add('DTS-HD MA');
  else if (/dts-hd/.test(t)) out.add('DTS-HD');
  else if (/dts/.test(t)) out.add('DTS');
  if (/eac3|e-ac-3|dd\+|ddplus/.test(t)) out.add('EAC3');
  else if (/ac3|\bdd\b/.test(t)) out.add('AC3');
  if (/aac/.test(t)) out.add('AAC');
  if (/opus/.test(t)) out.add('Opus');
  if (/mp3/.test(t)) out.add('MP3');
  if (/10bit|10-bit/.test(t)) out.add('10-bit');
  else if (/8bit|8-bit/.test(t)) out.add('8-bit');
  return [...out];
}

function parseSizeToBytes(s) {
  if (!s || typeof s !== 'string') return Number.MAX_SAFE_INTEGER;
  const sl = s.toLowerCase();
  if (/unknown|n\/a/.test(sl)) return Number.MAX_SAFE_INTEGER;
  const units = { gb: 1024 ** 3, mb: 1024 ** 2, kb: 1024, b: 1 };
  const m = s.match(/([\d.]+)\s*(gb|mb|kb|b)/i);
  if (m && m[1] && m[2]) {
    const v = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    if (!isNaN(v) && units[u]) return Math.floor(v * units[u]);
  }
  return Number.MAX_SAFE_INTEGER;
}

function matchEpisode(name, wantSeason, wantEpisode) {
  const m = name.match(/[._\s-]s(\d{1,2})e(\d{1,3})[._\s-]/i);
  if (!m) return null;
  const s = parseInt(m[1], 10), e = parseInt(m[2], 10);
  if (wantSeason != null && s !== wantSeason) return null;
  if (wantEpisode != null && e !== wantEpisode) return null;
  return { season: s, episode: e };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, { retries = 3, baseDelay = 800 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e.response && e.response.status;
      const retriable = !status || status === 429 || (status >= 500 && status < 600);
      if (!retriable || attempt === retries) throw e;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      process.stderr.write(`[retry] ${status || e.code} — waiting ${delay}ms (attempt ${attempt}/${retries})\n`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// HTTP clients
// ---------------------------------------------------------------------------

const sb = axios.create({
  baseURL: SHOWBOX_BASE,
  timeout: 15000,
  headers: {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

const fb = axios.create({
  baseURL: FEBBOX_BASE,
  timeout: 20000,
  headers: {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
  },
});

// ---------------------------------------------------------------------------
// Proxy API (TMDB -> ShowBox ID mapping, optional stream resolution)
// ---------------------------------------------------------------------------

/**
 * Resolve TMDB ID -> ShowBox internal ID via the Nuvio proxy API.
 * Returns { id, mid, versions } — versions[] is empty without a cookie.
 */
async function resolveTmdbToId(tmdbId, mediaType, season = null, episode = null, cookie = null) {
  let url;
  if (mediaType === 'tv' && season && episode) {
    url = `${PROXY_BASE}/tv/${tmdbId}/${season}/${episode}`;
  } else {
    url = `${PROXY_BASE}/movie/${tmdbId}`;
  }
  const params = {};
  if (cookie) params.cookie = cookie;

  const { data } = await axios.get(url, {
    params,
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 15000,
  });
  return data; // { success, id, mid, versions: [] }
}

/**
 * Process the proxy's versions[] response into stream objects.
 * (Only populated when a valid FebBox cookie is passed to the proxy.)
 */
function processProxyVersions(data, mediaInfo, mediaType, seasonNum, episodeNum) {
  const streams = [];
  if (!data || !data.success) return streams;
  if (!Array.isArray(data.versions)) return streams;

  let streamTitle = mediaInfo.title || 'Unknown Title';
  if (mediaInfo.year) streamTitle += ` (${mediaInfo.year})`;
  if (mediaType === 'tv' && seasonNum && episodeNum) {
    streamTitle = `${mediaInfo.title || 'Unknown'} S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
    if (mediaInfo.year) streamTitle += ` (${mediaInfo.year})`;
  }

  data.versions.forEach((version, vIdx) => {
    const versionName = version.name || `Version ${vIdx + 1}`;
    const versionSize = version.size || 'Unknown';
    if (Array.isArray(version.links)) {
      version.links.forEach(link => {
        if (!link.url) return;
        const quality = parseQualityFromLabel(link.quality || 'Unknown');
        streams.push({
          name: `2Peckle${data.versions.length > 1 ? ` V${vIdx + 1}` : ''} ${quality}`,
          title: streamTitle,
          url: link.url,
          quality,
          size: link.size || versionSize,
          codecs: extractCodecDetails(`${versionName} ${link.quality || ''}`),
          provider: '2Peckle',
          speed: link.speed || null,
        });
      });
    }
  });
  return streams;
}

// ---------------------------------------------------------------------------
// showbox.media layer (title search + share_link resolution)
// ---------------------------------------------------------------------------

async function searchTitle(query) {
  const { data } = await sb.get('/search/autocomplate2', {
    params: { keyword: query },
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  const $ = cheerio.load(data);
  const out = [];
  $('a.nav-item').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/^\/(movie|tv)\/detail\/(\d+)$/);
    if (!m) return;
    const type = m[1] === 'tv' ? 'tv' : 'movie';
    const id = m[2];
    const title = $(el).find('.film-name').text().trim();
    const infor = $(el).find('.film-infor').text().replace(/\s+/g, ' ').trim();
    const yearMatch = infor.match(/(19|20)\d{2}/);
    out.push({
      type, id, title,
      year: yearMatch ? parseInt(yearMatch[0], 10) : null,
      extra: infor,
    });
  });
  return out;
}

function pickHit(hits, wantTitle, wantYear, wantType) {
  const wt = (wantTitle || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let candidates = hits.filter(h => !wantType || h.type === wantType);
  if (!candidates.length) candidates = hits;
  const scored = candidates.map(h => {
    const ht = (h.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let score = 0;
    if (ht === wt) score += 100;
    else if (ht.includes(wt) || wt.includes(ht)) score += 60;
    if (wantYear && h.year === wantYear) score += 40;
    return { h, score };
  }).sort((a, b) => b.score - a.score);
  return scored.length && scored[0].score > 0 ? scored[0].h : (candidates[0] || null);
}

/**
 * Resolve a showbox.media internal id to a FebBox share URL.
 * type: 1 = movie bundle, 2 = TV (season-structured) bundle.
 */
async function getShareCode(internalId, type = 1) {
  const { data } = await sb.get('/index/share_link', {
    params: { id: internalId, type },
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${SHOWBOX_BASE}/`,
    },
  });
  if (!data || data.code !== 1 || !data.data || !data.data.link) return null;
  const link = data.data.link.replace(/\/$/, '');
  const code = link.split('/').pop();
  return { code, link };
}

// ---------------------------------------------------------------------------
// febbox.com layer (file listing + stream URL resolution)
// ---------------------------------------------------------------------------

/**
 * List files in a FebBox share (optionally under a parent dir).
 * ANONYMOUS — no cookie needed for listing.
 */
async function listShareFiles(shareCode, parentId) {
  const params = { share_key: shareCode };
  if (parentId) params.parent_id = parentId;
  const { data } = await withRetry(() => fb.get('/file/file_share_list', {
    params,
    headers: { Referer: `${FEBBOX_BASE}/share/${shareCode}` },
  }));
  if (!data || data.code !== 1) return [];
  return (data.data && data.data.file_list) || [];
}

/** Recursively walk a share, yielding leaf (is_dir=0) files. */
async function* walkShare(shareCode, parentId) {
  const items = await listShareFiles(shareCode, parentId);
  for (const it of items) {
    if (it.is_dir === 1 || it.is_dir === '1') {
      await sleep(150);
      yield* walkShare(shareCode, it.fid);
    } else {
      yield it;
    }
  }
}

/**
 * Resolve download_url for every file in a share. REQUIRES a `ui` JWT.
 * Returns a map: file_name -> { download_url, file_name, file_size, error }.
 */
async function resolveShareDownloads(shareCode, jwt) {
  const { data } = await fb.get('/file/share_download', {
    params: { share_key: shareCode },
    headers: {
      Referer: `${FEBBOX_BASE}/share/${shareCode}`,
      Cookie: asCookieHeader(jwt),
    },
  });
  if (!data || data.code !== 1 || !Array.isArray(data.data)) return {};
  const map = {};
  for (const f of data.data) {
    map[f.file_name] = {
      download_url: f.download_url || null,
      file_name: f.file_name,
      file_size: f.file_size,
      error: f.error,
    };
  }
  return map;
}

/**
 * Fetch video qualities (transcoded HLS variants) for a file. REQUIRES cookie.
 * Returns an HTML page from /console/video_quality_list — parsed with cheerio.
 */
async function resolveVideoQualities(shareCode, fid, jwt) {
  const { data } = await fb.get('/console/video_quality_list', {
    params: { fid, share_key: shareCode },
    headers: {
      Referer: `${FEBBOX_BASE}/share/${shareCode}`,
      Cookie: asCookieHeader(jwt),
    },
  });
  if (!data || !data.html) return [];
  const $ = cheerio.load(data.html);
  const out = [];
  $('div.file_quality').each((_, el) => {
    const $q = $(el);
    out.push({
      url: $q.attr('data-url'),
      quality: $q.attr('data-quality'),
      size: $q.find('.size').text().trim(),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Stream assembly
// ---------------------------------------------------------------------------

const VIDEO_EXT = /\.(mkv|mp4|m4v|mov|avi|ts|webm)$/i;

function buildStream(file, downloadUrl) {
  const name = file.file_name || '';
  return {
    name: '2Peckle',
    title: name,
    url: downloadUrl || null,
    quality: parseQualityFromLabel(name),
    codecs: extractCodecDetails(name),
    size: file.file_size || 'Unknown',
    fid: file.fid,
    provider: '2Peckle',
  };
}

async function getTmdbDetails(tmdbId, mediaType) {
  const { data } = await axios.get(`${TMDB_BASE}/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}`, {
    params: { api_key: TMDB_KEY },
    timeout: 8000,
  });
  return {
    title: data.title || data.name,
    year: data.release_date ? parseInt(data.release_date.slice(0, 4), 10)
       : data.first_air_date ? parseInt(data.first_air_date.slice(0, 4), 10)
       : null,
  };
}

// ---------------------------------------------------------------------------
// HIGH-LEVEL: stream getters
// ---------------------------------------------------------------------------

/**
 * Get streams for a MOVIE by TMDB ID.
 * Uses the Nuvio proxy for TMDB -> showbox ID mapping, then FebBox for streams.
 *
 * @param {number} tmdbId TMDB movie ID
 * @returns {Promise<Array>} array of stream objects
 */
async function getMovieStreams(tmdbId) {
  const jwts = loadCookies();
  const cookie = jwts.length ? (await selectBestCookie(jwts)).cookie : null;
  const mediaInfo = await getTmdbDetails(tmdbId, 'movie').catch(() => ({}));

  // Path 1: try the proxy with cookie (returns streams directly if cookie valid)
  if (cookie) {
    try {
      const data = await resolveTmdbToId(tmdbId, 'movie', null, null, cookie);
      const proxyStreams = processProxyVersions(data, mediaInfo, 'movie');
      if (proxyStreams.length) {
        process.stderr.write(`[2peckle] proxy returned ${proxyStreams.length} streams\n`);
        return proxyStreams;
      }
    } catch (e) {
      process.stderr.write(`[2peckle] proxy lookup failed: ${e.message}\n`);
    }
  }

  // Path 2: fall back to direct ShowBox -> FebBox flow
  const data = await resolveTmdbToId(tmdbId, 'movie');
  if (!data.success || !data.id) {
    process.stderr.write(`[2peckle] no ShowBox match for TMDB ${tmdbId}\n`);
    return [];
  }
  const showboxId = data.id;
  process.stderr.write(`[2peckle] TMDB ${tmdbId} -> ShowBox ID ${showboxId}\n`);

  // Try movie bundle (type=1) first, then TV bundle (type=2)
  let sc = await getShareCode(showboxId, 1);
  if (!sc) sc = await getShareCode(showboxId, 2);
  if (!sc) return [];
  process.stderr.write(`[2peckle] FebBox share: ${sc.link}\n`);

  // List files (anonymous)
  const files = [];
  for await (const f of walkShare(sc.code)) {
    if (VIDEO_EXT.test(f.file_name || '')) files.push(f);
  }
  process.stderr.write(`[2peckle] ${files.length} video file(s) in share\n`);

  // Resolve download URLs (REQUIRES cookie)
  let dlMap = {};
  if (cookie) {
    dlMap = await resolveShareDownloads(sc.code, cookie);
    process.stderr.write(`[2peckle] resolved ${Object.keys(dlMap).length} download URLs\n`);
  } else {
    process.stderr.write('[2peckle] no FEBBOX_COOKIE set — url will be null (listing only)\n');
  }

  return files
    .map(f => buildStream(f, dlMap[f.file_name] && dlMap[f.file_name].download_url))
    .sort((a, b) => parseSizeToBytes(b.size) - parseSizeToBytes(a.size));
}

/**
 * Get streams for a TV EPISODE by TMDB ID + season + episode.
 */
async function getEpisodeStreams(tmdbId, season, episode) {
  const jwts = loadCookies();
  const cookie = jwts.length ? (await selectBestCookie(jwts)).cookie : null;
  const mediaInfo = await getTmdbDetails(tmdbId, 'tv').catch(() => ({}));

  // Path 1: proxy
  if (cookie) {
    try {
      const data = await resolveTmdbToId(tmdbId, 'tv', season, episode, cookie);
      const proxyStreams = processProxyVersions(data, mediaInfo, 'tv', season, episode);
      if (proxyStreams.length) {
        process.stderr.write(`[2peckle] proxy returned ${proxyStreams.length} streams\n`);
        return proxyStreams;
      }
    } catch (e) {
      process.stderr.write(`[2peckle] proxy lookup failed: ${e.message}\n`);
    }
  }

  // Path 2: direct
  const data = await resolveTmdbToId(tmdbId, 'tv', season, episode);
  if (!data.success || !data.id) {
    process.stderr.write(`[2peckle] no ShowBox match for TMDB ${tmdbId}\n`);
    return [];
  }
  const showboxId = data.id;
  process.stderr.write(`[2peckle] TMDB ${tmdbId} -> ShowBox ID ${showboxId}\n`);

  // TV: type=2 gives the season-structured share
  let sc = await getShareCode(showboxId, 2);
  if (!sc) sc = await getShareCode(showboxId, 1);
  if (!sc) return [];
  process.stderr.write(`[2peckle] FebBox share: ${sc.link}\n`);

  // Walk and filter by SxxExx
  const matched = [];
  for await (const f of walkShare(sc.code)) {
    if (!VIDEO_EXT.test(f.file_name || '')) continue;
    const m = matchEpisode(f.file_name, season, episode);
    if (m) matched.push(f);
  }
  process.stderr.write(`[2peckle] ${matched.length} file(s) match S${season}E${episode}\n`);

  let dlMap = {};
  if (cookie) {
    dlMap = await resolveShareDownloads(sc.code, cookie);
  } else {
    process.stderr.write('[2peckle] no FEBBOX_COOKIE set — url will be null (listing only)\n');
  }

  return matched
    .map(f => buildStream(f, dlMap[f.file_name] && dlMap[f.file_name].download_url))
    .sort((a, b) => parseSizeToBytes(b.size) - parseSizeToBytes(a.size));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const [, , cmd, ...rest] = process.argv;
  let streams;
  try {
    if (cmd === 'search') {
      const q = rest.join(' ');
      const hits = await searchTitle(q);
      console.log(JSON.stringify(hits, null, 2));
      return;
    }
    if (cmd === 'movie') {
      const tmdbId = parseInt(rest[0], 10);
      streams = await getMovieStreams(tmdbId);
    } else if (cmd === 'tv') {
      const tmdbId = parseInt(rest[0], 10);
      const season = parseInt(rest[1], 10);
      const episode = parseInt(rest[2], 10);
      streams = await getEpisodeStreams(tmdbId, season, episode);
    } else if (cmd === 'movie-by-title') {
      const year = rest.length > 1 ? parseInt(rest[rest.length - 1], 10) : null;
      const title = (year ? rest.slice(0, -1) : rest).join(' ');
      const hits = await searchTitle(title);
      const hit = pickHit(hits.filter(h => h.type === 'movie'), title, isNaN(year) ? null : year, 'movie');
      if (!hit) {
        process.stderr.write(`[2peckle] no match for "${title}"\n`);
        process.exit(1);
      }
      streams = await getMovieStreams(parseInt(hit.id, 10));
    } else {
      process.stderr.write(
        'Usage:\n' +
        '  node 2peckle_scraper.js search "<query>"\n' +
        '  node 2peckle_scraper.js movie <tmdb_id>\n' +
        '  node 2peckle_scraper.js movie-by-title "<title>" [year]\n' +
        '  node 2peckle_scraper.js tv <tmdb_id> <season> <episode>\n' +
        '\nEnv: FEBBOX_COOKIE=<ui jwt>   (or FEBBOX_COOKIES=jwt1,jwt2,... for rotation)\n'
      );
      process.exit(2);
    }
    console.log(JSON.stringify(streams, null, 2));
  } catch (e) {
    process.stderr.write(`[2peckle] error: ${e.stack || e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  // High-level
  getMovieStreams,
  getEpisodeStreams,
  // Mid-level
  searchTitle,
  pickHit,
  getShareCode,
  listShareFiles,
  walkShare,
  resolveShareDownloads,
  resolveVideoQualities,
  resolveTmdbToId,
  processProxyVersions,
  getTmdbDetails,
  // Cookie management
  loadCookies,
  checkCookieQuota,
  selectBestCookie,
  // Filename parsing
  parseQualityFromLabel,
  extractCodecDetails,
  parseSizeToBytes,
  matchEpisode,
  // Constants
  SHOWBOX_BASE,
  FEBBOX_BASE,
  PROXY_BASE,
};

if (require.main === module) main();
