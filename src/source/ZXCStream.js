// src/source/ZXCStream.js
// ZXC[STREAM] — movies, series, anime, kdrama with multi-server support
//
// Site flow:
//   1. zxcstream.icu (Blogger search UI) → iframes to zxcstream.xyz/player/...
//   2. zxcstream.xyz 302-redirects to player.zxcstream.xyz
//   3. player.zxcstream.xyz is a Next.js SPA that calls a clean JSON API
//
// API flow (verified live, server-side playable):
//   1. GET /backend/tmdb/details/{type}/{tmdbId}?language=en-US
//        → { id, title, imdb_id, release_date, ... }
//   2. POST /backend/token__ with body { id, fToken, ts }
//        fToken = first 64 hex chars of sha512(`${ts}:${SECRET}:${tmdbId}`)
//        → { token, ts }
//   3. GET /backend_/servers/{serverId}?id=...&b=...&ts=...&token=...&fToken=...
//        &title=...&year=...&date=...[&season=...&episode=...][&imdbId=...]
//        [&dubCode=...&dubType=1]
//        → { success, links: [{ type, link, resolution, format, size, source }],
//            dubs: [{ lang, type, name, original }],
//            subtitles: [{ id, display, file }],
//            active: { langCode, langType, langName } }
//
// 7 server IDs (verified working):
//   - 1orion    (Built-In Subtitle - English)  — MP4 + HLS proxy
//   - 1icarus   (Multi Audio Support)          — Multi-quality MP4 (480/720/1080p)
//   - 1berkas   (4K Support & Fast)             — HLS multi-quality
//   - 1resshin  (Multi Audio Support)          — MP4 with multi-audio dubs
//   - 1daedalus (Alternative)                   — MP4 via nflixmovies.app
//   - 1athena   (Main Server & Multi Audio)     — HLS via imdb ID
//   - 1sentinel (K-Dramas, C-Dramas & Asian)    — HLS with subtitles
//
// Stream URLs are direct Cloudflare Worker / CDN URLs — Stremio plays them
// directly without an extractor. URLs are time-limited (some carry `exp`
// query param), so we use a short 5-minute cache TTL.
//
// For anime (detected via dubs array containing `ja/0` = Japanese Original),
// we make a second pass with dubCode=en&dubType=1 to get the English dub.
// Result: separate SUB (Japanese audio + EN subs) and DUB (English audio) streams.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import crypto from 'crypto';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const BASE = 'https://player.zxcstream.xyz';
const SECRET = '24356351231432574635345245245252324';

// Obfuscated field names from the Next.js bundle (module 92852)
const FIELD_MAP = {
  id: 'c81f7a42d9e253b16f408',
  fToken: '9e3c7bd314af65281d0e49b73',
  ts: '54d8b21fc9a374e60b1fd',
  token: 'b7f18e4c25d963a50ef81c4a9',
  title: '2af9c71de384b5630c91e',
  year: 'f0b34e8d61c6a9275a14f',
  season: 'd41e8c6b259af73510fc48a7e',
  episode: '8b7d13fa8e620c9541d8e7bc2',
  imdbId: '6e2af5c97d19840b3f81a6d54',
};

// Server catalog (from chunk ea array)
const SERVERS = [
  { id: '1orion',    label: 'Orion'    }, // MP4 + HLS proxy
  { id: '1icarus',   label: 'Icarus'   }, // Multi-quality MP4 (480/720/1080p)
  { id: '1berkas',   label: 'Berkas'   }, // HLS multi-quality
  { id: '1resshin',  label: 'Resshin'  }, // MP4 with multi-audio dubs
  { id: '1daedalus', label: 'Daedalus' }, // MP4 via nflixmovies.app
  { id: '1athena',   label: 'Athena'   }, // HLS via imdb ID
  { id: '1sentinel', label: 'Sentinel' }, // HLS with subtitles (Asian content)
];

const hg = new HeaderGenerator({
  browsers: ['chrome'],
  devices: ['desktop'],
  operatingSystems: ['windows'],
  locales: ['en-US', 'en'],
});

function genFrontendToken(tmdbId) {
  const ts = Date.now();
  const xt = crypto.createHash('sha512')
    .update(`${ts}:${SECRET}:${tmdbId}`)
    .digest('hex')
    .slice(0, 64);
  return { xt, rt: ts };
}

function browserHeaders(referer) {
  return {
    ...hg.getHeaders({ httpVersion: '2' }),
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(referer && { Referer: referer }),
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
}

// Fetch TMDB details (title, year, date, imdb_id) from the ZXC backend
async function fetchDetails(tmdbId, mediaType, playerUrl) {
  const url = `${BASE}/backend/tmdb/details/${mediaType}/${tmdbId}?language=en-US`;
  const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });
  const res = await gotScraping.get(url, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), ...browserHeaders(playerUrl) },
    timeout: { request: 15000 },
    throwHttpErrors: false,
    http2: true,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

// POST /backend/token__ to get the real token + ts
async function fetchToken(tmdbId, playerUrl) {
  const { xt, rt } = genFrontendToken(String(tmdbId));
  const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });
  const res = await gotScraping.post(`${BASE}/backend/token__`, {
    headers: {
      ...hg.getHeaders({ httpVersion: '2' }),
      ...browserHeaders(playerUrl),
      'Content-Type': 'application/json',
      'Origin': BASE,
    },
    body: JSON.stringify({
      [FIELD_MAP.id]: String(tmdbId),
      [FIELD_MAP.fToken]: xt,
      [FIELD_MAP.ts]: String(rt),
    }),
    timeout: { request: 15000 },
    throwHttpErrors: false,
    http2: true,
  });
  if (res.statusCode !== 200) return null;
  try {
    const j = JSON.parse(res.body);
    const token = j[FIELD_MAP.token];
    const ts = j[FIELD_MAP.ts];
    if (!token || !ts) return null;
    return { token, ts, xt };
  } catch { return null; }
}

// GET /backend_/servers/{serverId} to get stream links
async function fetchServer(serverId, params, playerUrl) {
  const url = `${BASE}/backend_/servers/${serverId}?${params.toString()}`;
  const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });
  const res = await gotScraping.get(url, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), ...browserHeaders(playerUrl) },
    timeout: { request: 20000 },
    throwHttpErrors: false,
    http2: true,
  });
  if (res.statusCode !== 200) return null;
  try {
    const j = JSON.parse(res.body);
    if (!j.success || !Array.isArray(j.links)) return null;
    return j;
  } catch { return null; }
}

function buildParams(tmdbId, mediaType, tokenInfo, details, season, episode, dubCode, dubType) {
  const params = new URLSearchParams();
  params.set(FIELD_MAP.id, String(tmdbId));
  params.set('b', mediaType);
  params.set(FIELD_MAP.ts, String(tokenInfo.ts));
  params.set(FIELD_MAP.token, tokenInfo.token);
  params.set(FIELD_MAP.fToken, tokenInfo.xt);
  params.set(FIELD_MAP.title, details.title || details.name || '');
  params.set(FIELD_MAP.year, (details.release_date || details.first_air_date || '').slice(0, 4));
  params.set('date', details.release_date || details.first_air_date || '');
  if (mediaType === 'tv') {
    params.set(FIELD_MAP.season, String(season));
    params.set(FIELD_MAP.episode, String(episode));
  }
  if (details.imdb_id) params.set(FIELD_MAP.imdbId, details.imdb_id);
  if (dubCode && dubType) {
    params.set('dubCode', dubCode);
    params.set('dubType', String(dubType));
  }
  return params;
}

// Parse resolution to height (number)
function parseHeight(resolution) {
  if (!resolution && resolution !== 0) return undefined;
  if (typeof resolution === 'number') {
    // Berkas returns 1, 2, 3 (quality tiers) — no direct height mapping
    if (resolution <= 10) return undefined;
    return resolution;
  }
  const m = String(resolution).match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : undefined;
}

// Detect anime: dubs array contains { lang: 'ja', type: 0 } (Japanese Original audio)
function isAnimeByDubs(dubs) {
  return Array.isArray(dubs) && dubs.some(d => d.lang === 'ja' && d.type === 0 && d.original);
}

// Detect KDrama: dubs array contains { lang: 'ko', type: 0 } (Korean Original audio)
function isKDramaByDubs(dubs) {
  return Array.isArray(dubs) && dubs.some(d => d.lang === 'ko' && d.type === 0 && d.original);
}

// Run async tasks with bounded concurrency
async function mapBounded(items, limit, fn) {
  const results = [];
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (idx < items.length) {
      const cur = idx++;
      try {
        results[cur] = await fn(items[cur], cur);
      } catch (e) {
        results[cur] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export class ZXCStream extends Source {
  constructor(fetcher) {
    super();
    this.id = 'zxcstream';
    this.label = 'ZXCStream';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = BASE;
    this.fetcher = fetcher;
    // Stream URLs are time-limited (exp query param) — short cache
    this.ttl = 5 * 60 * 1000; // 5min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const mediaType = tmdbId.season ? 'tv' : 'movie';

    const playerUrl = `${BASE}/player/${mediaType}/${tmdbId.id}${mediaType === 'tv' ? `/${tmdbId.season}/${tmdbId.episode}` : ''}?server=1athena&subLang=english`;

    // Step 1: parallel fetch — details (gives us title/year/imdb_id) + token
    // Skip getTmdbNameAndYear since ZXC's /backend/tmdb/details returns everything
    const [details, tokenInfo] = await Promise.all([
      fetchDetails(tmdbId.id, mediaType, playerUrl),
      fetchToken(tmdbId.id, playerUrl),
    ]);
    if (!details || !tokenInfo) return [];

    const name = details.title || details.name || `TMDB ${tmdbId.id}`;
    const year = (details.release_date || details.first_air_date || '').slice(0, 4);
    const titleBase = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 2: query all 7 servers in parallel (concurrency limit 4)
    const serverResults = await mapBounded(SERVERS, 4, async (srv) => {
      const params = buildParams(tmdbId.id, mediaType, tokenInfo, details, tmdbId.season, tmdbId.episode);
      const data = await fetchServer(srv.id, params, playerUrl);
      return { server: srv, data };
    });

    // Detect anime from any server's dubs array
    let anime = false;
    let kdrama = false;
    for (const r of serverResults) {
      if (r?.data?.dubs) {
        if (isAnimeByDubs(r.data.dubs)) anime = true;
        if (isKDramaByDubs(r.data.dubs)) kdrama = true;
        if (anime && kdrama) break;
      }
    }

    const results = [];
    const seenUrls = new Set();

    const addStream = (link, server, label, countryCodes, height, format) => {
      if (!link?.link) return;
      if (seenUrls.has(link.link)) return;
      seenUrls.add(link.link);

      let parsed;
      try { parsed = new URL(link.link); } catch { return; }

      const h = height ?? parseHeight(link.resolution);
      results.push({
        url: parsed,
        format,
        meta: {
          countryCodes,
          title: `${titleBase} (${label} · ${server.label}${h ? ` ${h}p` : ''})`,
          sourceId: this.id,
          sourceLabel: this.label,
          serverId: server.id,
          ...(h && { height: h }),
        },
      });
    };

    // Process default streams (original audio)
    // For anime: default is Japanese audio → label as SUB
    // For kdrama: default is Korean audio → label as SUB
    // For movies/series: default is original audio → label with server name
    for (const r of serverResults) {
      if (!r?.data) continue;
      for (const link of r.data.links) {
        const format = link.type === 'hls' ? Format.hls : Format.mp4;
        let ccs, label;
        if (anime) {
          ccs = [CountryCode.multi, CountryCode.ja];
          label = 'SUB';
        } else if (kdrama) {
          ccs = [CountryCode.multi, CountryCode.ko];
          label = 'SUB';
        } else {
          ccs = [CountryCode.multi];
          label = r.server.label;
        }
        addStream(link, r.server, label, ccs, undefined, format);
      }
    }

    // Step 3: For anime, fetch English DUB streams
    if (anime) {
      const dubResults = await mapBounded(SERVERS, 4, async (srv) => {
        // Skip servers that didn't have anime dubs (e.g., 1sentinel for non-Asian)
        const origResult = serverResults.find(x => x.server.id === srv.id);
        if (!origResult?.data?.dubs) return null;
        const hasEnDub = origResult.data.dubs.some(d => d.lang === 'en' && d.type === 0);
        if (!hasEnDub) return null;

        const params = buildParams(tmdbId.id, mediaType, tokenInfo, details, tmdbId.season, tmdbId.episode, 'en', 1);
        const data = await fetchServer(srv.id, params, playerUrl);
        return { server: srv, data };
      });

      for (const r of dubResults) {
        if (!r?.data) continue;
        for (const link of r.data.links) {
          const format = link.type === 'hls' ? Format.hls : Format.mp4;
          addStream(link, r.server, 'DUB', [CountryCode.multi, CountryCode.en], undefined, format);
        }
      }
    }

    return results;
  }
}
