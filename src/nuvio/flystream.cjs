// src/nuvio/flystream.cjs
// FlyStream — movies, TV series, anime (sub+dub) with HLS streams up to 4K
//
// Uses the FlyStream API at https://flystream.net/api/playback-search
//
// Flow:
//   1. Fetch homepage to get Cloudflare cookies (fs_seen2)
//   2. Call /api/playback-search with TMDB/IMDB params
//   3. Returns HLS m3u8 streams (480p/720p/1080p/2160p)
//
// All streams are HLS from media.flystream.net. No Referer needed.
// The API requires browser-like headers (HeaderGenerator) + cookies.

'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE_URL = 'https://flystream.net';

// got-scraping + header-generator loaders
let _gs = null;
let _hg = null;
async function getGs() {
  if (_gs !== null) return _gs;
  try { _gs = (await import('got-scraping')).gotScraping; } catch { _gs = false; }
  return _gs;
}
async function getHg() {
  if (_hg !== null) return _hg;
  try { _hg = new (await import('header-generator')).HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] }); } catch { _hg = null; }
  return _hg;
}

// Cache cookies from homepage fetch
let _cookieCache = { str: '', ts: 0 };
const COOKIE_TTL = 4 * 60 * 60 * 1000; // 4 hours

async function getCookie() {
  if (_cookieCache.str && Date.now() - _cookieCache.ts < COOKIE_TTL) return _cookieCache.str;
  const gs = await getGs();
  const hg = await getHg();
  if (!gs) return '';
  try {
    const headers = hg ? { ...hg.getHeaders({ httpVersion: '2' }) } : { 'User-Agent': UA };
    const res = await gs.get(BASE_URL + '/', { headers, timeout: { request: 15000 }, throwHttpErrors: false, http2: true });
    const cookies = res.headers['set-cookie'] || [];
    const cookieStr = Array.isArray(cookies) ? cookies.map(c => c.split(';')[0]).join('; ') : '';
    if (cookieStr) {
      _cookieCache = { str: cookieStr, ts: Date.now() };
    }
    return cookieStr;
  } catch { return _cookieCache.str; }
}

async function fetchJson(url, timeout = 15000) {
  const gs = await getGs();
  const hg = await getHg();
  const cookie = await getCookie();
  if (!gs) return null;
  try {
    const headers = hg ? { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': BASE_URL + '/', ...(cookie && { 'Cookie': cookie }) } : { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': BASE_URL + '/', ...(cookie && { 'Cookie': cookie }) };
    const res = await gs.get(url, { headers, timeout: { request: timeout }, throwHttpErrors: false, http2: true });
    if (res.statusCode !== 200) return null;
    try { return JSON.parse(res.body); } catch { return null; }
  } catch { return null; }
}

async function getStreams(tmdbId, type, season, episode, opts = {}) {
  const isTV = type === 'tv' || type === 'anime';
  const mediaType = isTV ? 'tv' : 'movie';
  const imdbId = opts.imdbId || '';
  const title = opts.title || '';
  const year = opts.year || '';
  const isAnime = opts.isAnime || false;

  console.log(`[FlyStream] Request: tmdb=${tmdbId} type=${mediaType} S${season || '?'}E${episode || '?'}`);

  // Build API params — needs IMDB + title + year for the API to return streams
  const params = new URLSearchParams({ type: mediaType, want4k: '1' });
  if (imdbId) params.set('imdb', imdbId);
  if (tmdbId) params.set('tmdbId', String(tmdbId));
  if (title) params.set('title', title);
  if (year) params.set('year', String(year));
  if (isAnime) params.set('isAnime', '1');
  if (isTV && season) {
    params.set('season', String(season));
    params.set('episode', String(episode || 1));
  }

  const apiUrl = `${BASE_URL}/api/playback-search?${params}`;
  console.log(`[FlyStream] Fetching: ${apiUrl.slice(0, 80)}...`);

  const data = await fetchJson(apiUrl, 15000);
  if (!data || !Array.isArray(data.streams) || data.streams.length === 0) {
    console.log('[FlyStream] No streams found');
    return [];
  }

  console.log(`[FlyStream] Found ${data.streams.length} stream(s)`);

  const streams = [];
  const seenUrls = new Set();

  for (const src of data.streams) {
    if (!src.url || !src.url.startsWith('http')) continue;
    if (seenUrls.has(src.url)) continue;
    seenUrls.add(src.url);

    const quality = src.quality || 'Unknown';
    const isHls = src.isHls || src.url.includes('.m3u8');
    const isDub = src.isDub || false;
    const isSub = src.isSub || false;
    const size = src.size || '';

    // Build display title
    let titleLine = `TMDB ${tmdbId}`;
    if (isTV) {
      titleLine += ` S${String(season || 1).padStart(2, '0')}E${String(episode || 1).padStart(2, '0')}`;
    }
    titleLine += ` ${quality}`;
    if (isDub) titleLine += ' [DUB]';
    if (isSub) titleLine += ' [SUB]';

    streams.push({
      name: `FlyStream - ${quality}${isDub ? ' DUB' : isSub ? ' SUB' : ''}`,
      title: titleLine,
      url: src.url,
      quality: quality,
      type: isHls ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      headers: {},
      behaviorHints: {
        bingeGroup: `flystream-${quality}${isDub ? '-dub' : isSub ? '-sub' : ''}`,
      },
    });
  }

  console.log(`[FlyStream] Returning ${streams.length} stream(s)`);
  return streams;
}

module.exports = { getStreams };
