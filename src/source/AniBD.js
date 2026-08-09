// src/source/AniBD.js
// anibd.app — anime BD (Blu-ray) streaming site (different from anidb.app!)
//
// NOTE: This is NOT the same as the existing AniDB source (anidb.app).
//   - anidb.app: Laravel backend, /api/frontend/* endpoints, hls.anidb.app CDN
//   - anibd.app: WordPress + external animeapps.top API cluster, playeng.animeapps.top CDN
//
// Flow (all JSON, no scraping):
//   1. Search: GET https://eng.animeapps.top/api/search3.php?keyword={title}
//      → {data:[{postid, postname, anilist, anitypes, postyear, ...}]}
//   2. Episodes: GET https://epeng.animeapps.top/api2.php?epid={anilistId}
//      → [{id, server_name, server_data:[{name, slug, link}]}]
//      (link is a playerDataId, not the final URL)
//   3. Resolve: GET https://epeng.animeapps.top/apilink.php?data={playerDataId}
//      → [{server:"SR", link:"https://playeng.animeapps.top/r2/play2.php?id=aniN&url={token}"}]
//      (only SR works; SB 404s)
//   4. Build HLS: https://playeng.animeapps.top/r2/cachehd/{token}/index.m3u8
//   5. m3u8 requires Referer: https://anibd.app/ → route through /proxy
//
// SUB-only (single "S-sub" server). No dub available on this site.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://anibd.app';
const SEARCH_API = 'https://eng.animeapps.top/api/search3.php';
const EPISODES_API = 'https://epeng.animeapps.top/api2.php';
const APILINK_API = 'https://epeng.animeapps.top/apilink.php';
const PLAYENG_BASE = 'https://playeng.animeapps.top/r2/cachehd';
const REFERER = 'https://anibd.app/';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Normalize for fuzzy title matching
const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function apiGet(url) {
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Referer': BASE_URL + '/',
    },
    timeout: { request: 15000 },
    throwHttpErrors: false,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

export class AniBD extends Source {
  constructor(fetcher) {
    super();
    this.id = 'anibd';
    this.label = 'AniBD';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search for the anime
    const animeInfo = await this.findAnime(name);
    if (!animeInfo) return [];

    // Step 2: Get episodes (epid = anilist ID)
    const anilistId = animeInfo.anilist;
    if (!anilistId) return [];

    const servers = await apiGet(`${EPISODES_API}?epid=${anilistId}`);
    if (!Array.isArray(servers) || servers.length === 0) return [];

    // Step 3: Find the requested episode
    // Only one server ("S-sub") exists — SUB-only site
    const server = servers[0];
    if (!server?.server_data?.length) return [];

    const targetEp = tmdbId.season ? (tmdbId.episode || 1) : 1;
    let episode = null;
    for (const ep of server.server_data) {
      if (parseInt(ep.name, 10) === targetEp) {
        episode = ep;
        break;
      }
    }
    // Fallback: first episode (for movies)
    if (!episode) episode = server.server_data[0];
    if (!episode?.link) return [];

    // Step 4: Resolve the embed URL via apilink
    const mirrors = await apiGet(`${APILINK_API}?data=${encodeURIComponent(episode.link)}`);
    if (!Array.isArray(mirrors) || mirrors.length === 0) return [];

    // Pick the SR mirror (SB is dead — 404s)
    const srMirror = mirrors.find(m => m.server === 'SR') || mirrors[0];
    if (!srMirror?.link) return [];

    // Extract the token from the link URL's `url` query param
    let token;
    try {
      const mirrorUrl = new URL(srMirror.link);
      token = mirrorUrl.searchParams.get('url');
    } catch { return []; }
    if (!token) return [];

    // Step 5: Build the HLS URL
    const m3u8Url = `${PLAYENG_BASE}/${token}/index.m3u8`;
    let parsed;
    try { parsed = new URL(m3u8Url); } catch { return []; }

    // Return the DIRECT m3u8 URL with requestHeaders.
    // The AnimeDirect extractor claims playeng.animeapps.top URLs and routes
    // them through /proxy with the Referer from meta.requestHeaders.
    // AniBD streams are 1080p Blu-ray rips.
    const results = [{
      url: parsed,
      format: Format.hls,
      requestHeaders: { Referer: REFERER },
      meta: {
        countryCodes: [CountryCode.multi, CountryCode.ja],
        title: `${title} (Sub · ${server.server_name})`,
        sourceId: this.id,
        sourceLabel: this.label,
        height: 1080,
      },
    }];

    return results;
  }

  // Search AniBD by name and return {postid, anilist} of the best match
  async findAnime(name) {
    const queries = [
      name,
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    const nameNorm = normalize(name);

    for (const query of queries) {
      const data = await apiGet(`${SEARCH_API}?keyword=${encodeURIComponent(query)}`);
      if (!data?.data?.length) continue;

      let best = null;
      let bestScore = 0;
      for (const r of data.data) {
        const titles = [r.postname, r.english, r.romaji, r.native].filter(Boolean);
        let itemBest = 0;
        for (const t of titles) {
          const tNorm = normalize(t);
          if (!tNorm) continue;
          let score = 0;
          if (tNorm === nameNorm) score = 100;
          else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
            score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
          }
          if (score > itemBest) itemBest = score;
        }
        if (itemBest > bestScore) {
          bestScore = itemBest;
          best = r;
        }
      }

      // Only accept matches with score >= 0.5 (at least 50% title overlap).
      // Lower thresholds cause wrong anime matches (e.g. "Naruto The Lost
      // Story" matching "ROAD TO NINJA: NARUTO THE MOVIE" — both contain
      // "Naruto" but are completely different titles).
      if (best && bestScore >= 0.5) {
        return { postid: best.postid, anilist: best.anilist };
      }
    }

    return null;
  }
}
