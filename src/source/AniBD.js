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

// Normalize for fuzzy title matching — also collapses doubled vowels
// (e.g. "Shippuuden" → "Shippuden") to handle romanization variants
const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
  .replace(/(uu|oo|aa|ee|ii)/g, m => m[0]); // collapse doubled vowels

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

    // Step 1a: Try AniList GraphQL API to get the anilist ID by English title.
    // This is more reliable than text matching because AniBD indexes by
    // Japanese romanization (e.g. "Shingeki no Kyojin") while TMDB gives
    // English titles (e.g. "Attack on Titan"). AniList maps both.
    let anilistId = null;
    let serverName = '';
    try {
      const anilistData = await this.getAniListId(name);
      if (anilistData?.id) {
        anilistId = String(anilistData.id);
        // Use romaji title for display if available
        if (anilistData.romaji) serverName = anilistData.romaji;
      }
    } catch { /* fall through to text search */ }

    // Step 1b: If AniList lookup failed, fall back to text search
    if (!anilistId) {
      const animeInfo = await this.findAnime(name, year);
      if (!animeInfo) return [];
      anilistId = animeInfo.anilist;
      if (!anilistId) return [];
      serverName = animeInfo.postname || serverName;
    }

    // Step 2: Get episodes (epid = anilist ID)
    const servers = await apiGet(`${EPISODES_API}?epid=${anilistId}`);
    if (!Array.isArray(servers) || servers.length === 0) return [];

    // Step 3: Find the requested episode
    // Only one server ("S-sub") exists — SUB-only site
    const server = servers[0];
    if (!server?.server_data?.length) return [];
    if (!serverName) serverName = server.server_name || 'AniBD';

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

  // Look up the AniList ID + romaji title via GraphQL API.
  // This maps English TMDB titles to the AniList ID (which AniBD uses as
  // its 'epid' parameter) without relying on text matching against the
  // Japanese romanization that AniBD indexes by.
  async getAniListId(name) {
    const { gotScraping } = await import('got-scraping');
    const query = 'query($search: String) { Media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id title { romaji english } } }';
    try {
      const res = await gotScraping.post('https://graphql.anilist.co', {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ query, variables: { search: name } }),
        timeout: { request: 10000 },
        throwHttpErrors: false,
        http2: false,
      });
      if (res.statusCode !== 200) return null;
      const data = JSON.parse(res.body);
      const media = data?.data?.Media;
      if (!media?.id) return null;
      return {
        id: media.id,
        romaji: media.title?.romaji || '',
        english: media.title?.english || '',
      };
    } catch {
      return null;
    }
  }

  // Search AniBD by name and return {postid, anilist} of the best match
  async findAnime(name, year) {
    const queries = [
      name,
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
      // Try the main title before the first colon — TMDB titles often have
      // subtitles (e.g. "Demon Slayer: Kimetsu no Yaiba") but the AniBD API
      // indexes by Japanese romanization ("Kimetsu no Yaiba BD"), so searching
      // for just the prefix or just the subtitle yields different results.
      ...(name.indexOf(':') > 0 ? [
        name.substring(0, name.indexOf(':')).trim(),
        name.substring(name.indexOf(':') + 1).trim(),
      ] : []),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    const nameNorm = normalize(name);
    const yearNum = year ? parseInt(String(year), 10) : null;

    for (const query of queries) {
      const data = await apiGet(`${SEARCH_API}?keyword=${encodeURIComponent(query)}`);
      if (!data?.data?.length) continue;

      let best = null;
      let bestScore = 0;
      const nameWords = new Set(nameNorm.split(' ').filter(w => w.length > 2));
      for (const r of data.data) {
        // The API only returns postname (Japanese romanization) — no english
        // field. Try multiple variants: strip common suffixes like "BD", "TV".
        const rawPostname = r.postname || '';
        const cleanedPostname = rawPostname
          .replace(/\s+(BD|TV|Movie|OVA|ONA|Special)\s*$/i, '')
          .replace(/[():]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const titles = [cleanedPostname, rawPostname].filter(Boolean);
        let itemBest = 0;
        for (const t of titles) {
          const tNorm = normalize(t);
          if (!tNorm) continue;
          let score = 0;
          if (tNorm === nameNorm) score = 100;
          else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
            score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
          }
          // Word-overlap scoring — lowered threshold from 0.6 to 0.4 because
          // TMDB uses "Demon Slayer" prefix while the API indexes by Japanese
          // romanization ("Kimetsu no Yaiba"). The two share only "kimetsu"
          // and "yaiba" — that's a 50% overlap, which is still a strong
          // match when paired with year matching (below).
          if (score < 50 && nameWords.size >= 2) {
            const titleWords = new Set(tNorm.split(' ').filter(w => w.length > 2));
            const common = [...nameWords].filter(w => titleWords.has(w));
            const overlap = common.length / Math.max(nameWords.size, titleWords.size);
            if (overlap >= 0.4) {
              score = overlap * 80;
            }
          }
          // Year matching — strong signal. TMDB year should match API postyear.
          if (score > 0 && yearNum) {
            const postYear = parseInt(r.postyear, 10);
            if (!isNaN(postYear) && Math.abs(postYear - yearNum) <= 1) {
              score += 25; // year match is strong confirmation
            } else if (!isNaN(postYear) && Math.abs(postYear - yearNum) > 2) {
              score -= 15; // year mismatch is a strong negative signal
            }
          }
          if (score > itemBest) itemBest = score;
        }
        if (itemBest > bestScore) {
          bestScore = itemBest;
          best = r;
        }
      }

      // Lower threshold from 50 to 40 — TMDB titles with subtitles don't
      // match well against the API's Japanese romanization postnames, even
      // with year matching the score may only reach ~50.
      if (best && bestScore >= 40) {
        return { postid: best.postid, anilist: best.anilist };
      }
    }

    return null;
  }
}
