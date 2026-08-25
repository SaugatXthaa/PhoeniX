// src/nuvio/framextv.cjs
// FrameX TV — movies, TV series, anime (sub+dub) with HLS streams up to 4K
//
// Uses the FrameX API at https://api.framextv.tech/api/stream
//
// Flow:
//   1. Resolve TMDB ID → name/year (done by source wrapper)
//   2. Call API: GET /api/stream?id={tmdbId}&type={movie|tv}&season={s}&episode={e}
//      → Returns { provider, sources: [{url, quality, type, server, headers}] }
//   3. Sources include 480p, 720p, 1080p, 2160p HLS streams
//   4. Anime: GET /api/stream?id={anilistId}&type=anime&season={s}&episode={e}
//      (Anime uses AniList IDs — resolved via AniList GraphQL API)
//
// All streams are HLS (m3u8). Some require Referer header.
// The source wrapper handles metadata enrichment + Referer routing.

'use strict';

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const API_BASE = 'https://api.framextv.tech';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// got-scraping loader
let _gs = null;
async function getGs() {
  if (_gs !== null) return _gs;
  try { _gs = (await import('got-scraping')).gotScraping; }
  catch (e) { _gs = false; }
  return _gs;
}

async function fetchJson(url, timeout = 15000) {
  const gs = await getGs();
  if (gs) {
    const res = await gs.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      timeout: { request: timeout },
      throwHttpErrors: false,
      http2: false,
    });
    if (res.statusCode !== 200) return null;
    try { return JSON.parse(res.body); } catch { return null; }
  }
  // Fallback: plain fetch
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Look up AniList ID via GraphQL (for anime)
async function getAniListId(title) {
  const query = 'query($search: String) { Media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id title { romaji english } } }';
  const gs = await getGs();
  if (!gs) return null;
  try {
    const res = await gs.post('https://graphql.anilist.co', {
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ query, variables: { search: title } }),
      timeout: { request: 10000 },
      throwHttpErrors: false,
      http2: false,
    });
    if (res.statusCode !== 200) return null;
    const data = JSON.parse(res.body);
    const media = data?.data?.Media;
    if (!media?.id) return null;
    return { id: media.id, romaji: media.title?.romaji || '', english: media.title?.english || '' };
  } catch { return null; }
}

// Check which providers are available for a given content
async function checkProviders(id, type, season, episode) {
  const providers = ['barbarian', 'goblin', 'wizard', 'archer', 'pekka', 'witch', 'giant', 'lavahound', 'electro_wizard', 'hog_rider', 'headhunter', 'valkyrie'];
  const available = [];
  for (const p of providers) {
    try {
      const params = new URLSearchParams({ id: String(id), type, provider: p });
      if (season) { params.set('season', String(season)); params.set('episode', String(episode || 1)); }
      const data = await fetchJson(`${API_BASE}/api/stream/check?${params}`, 8000);
      if (data && data.available) {
        available.push(p);
      }
    } catch {}
  }
  return available;
}

async function getStreams(tmdbId, type, season, episode) {
  const isAnime = type === 'anime';
  const isTV = type === 'tv' || isAnime;

  console.log(`[FrameX] Request: tmdb=${tmdbId} type=${type} S${season || '?'}E${episode || '?'}`);

  // For anime, convert TMDB ID to AniList ID
  let apiId = tmdbId;
  let apiType = type === 'tv' ? 'tv' : (isAnime ? 'anime' : 'movie');
  let animeTitle = '';

  if (isAnime) {
    // Get title from TMDB first
    const tmdbData = await fetchJson(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`);
    if (!tmdbData) {
      console.log('[FrameX] TMDB lookup failed');
      return [];
    }
    animeTitle = tmdbData.name || tmdbData.title || '';
    console.log(`[FrameX] TMDB: ${animeTitle}`);

    // Get AniList ID
    const anilist = await getAniListId(animeTitle);
    if (!anilist?.id) {
      console.log('[FrameX] AniList lookup failed for: ' + animeTitle);
      return [];
    }
    apiId = anilist.id;
    console.log(`[FrameX] AniList ID: ${apiId}`);
  }

  // Build API URL
  const params = new URLSearchParams({ id: String(apiId), type: apiType });
  if (isTV && season) {
    params.set('season', String(season));
    params.set('episode', String(episode || 1));
  }

  // Try default (barbarian) provider first — it's the fastest
  const apiUrl = `${API_BASE}/api/stream?${params}`;
  console.log(`[FrameX] Fetching: ${apiUrl}`);

  const data = await fetchJson(apiUrl, 25000);
  if (!data || !data.success || !Array.isArray(data.sources) || data.sources.length === 0) {
    console.log('[FrameX] No streams from default provider');
    return [];
  }

  console.log(`[FrameX] Provider: ${data.provider} | Sources: ${data.sources.length}`);

  // Convert API response to Nuvio stream format
  const streams = [];
  const seenUrls = new Set();

  for (const src of data.sources) {
    if (!src.url || !src.url.startsWith('http')) continue;
    if (seenUrls.has(src.url)) continue;
    seenUrls.add(src.url);

    const quality = src.quality || 'Unknown';
    const server = src.server || data.provider || 'FrameX';
    const streamType = src.type || 'hls';
    const headers = src.headers || {};
    const category = src.category || '';

    // Build display title
    let titleLine = animeTitle || `TMDB ${tmdbId}`;
    if (isTV) {
      titleLine += ` S${String(season || 1).padStart(2, '0')}E${String(episode || 1).padStart(2, '0')}`;
    }
    titleLine += ` ${quality} ${server}`;
    if (category) titleLine += ` [${category}]`;

    streams.push({
      name: `FrameX - ${quality} ${server}${category ? ' ' + category : ''}`,
      title: titleLine,
      url: src.url,
      quality: quality,
      type: streamType === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      headers: headers,
      behaviorHints: {
        bingeGroup: `framextv-${quality}`,
      },
    });
  }

  console.log(`[FrameX] Returning ${streams.length} stream(s)`);
  return streams;
}

module.exports = { getStreams };
