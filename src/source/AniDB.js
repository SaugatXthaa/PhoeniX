// src/source/AniDB.js
// anidb.app — anime streaming with sub + dub, direct HLS streams
//
// Flow:
//   1. Search: /search/suggestions?q={title} → find /anime/{slug}-{id}
//   2. Episodes: /api/frontend/anime/{id}/episodes → [{id, number}, ...]
//   3. Languages: /api/frontend/episode/{epId}/languages → {languages: [{code, embed_url}]}
//      - code 'jpn' = Japanese (SUB)
//      - code 'eng' = English (DUB)
//   4. Embed page: /embed/{token} → contains `file: 'https://hls.anidb.app/stream/{token}/master.m3u8'`
//   5. Direct HLS URL — no Referer needed, plays natively in Stremio
//
// The anime ID is extracted from the URL slug: /anime/{slug}-{id} → id = last segment after last dash

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://anidb.app';

export class AniDB extends Source {
  constructor(fetcher) {
    super();
    this.id = 'anidb';
    this.label = 'AniDB';
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
    const animeInfo = await this.findAnime(ctx, name);
    if (!animeInfo) return [];

    // Step 2: Get episodes list
    const episodes = await this.fetchEpisodes(ctx, animeInfo.id);
    if (episodes.length === 0) return [];

    // Step 3: Find the requested episode
    const targetEp = tmdbId.season ? (tmdbId.episode || 1) : 1;
    const episode = episodes.find(ep => ep.number === targetEp) || episodes[0];
    if (!episode) return [];

    // Step 4: Get languages (sub/dub) for this episode
    const languages = await this.fetchLanguages(ctx, episode.id);
    if (languages.length === 0) return [];

    // Step 5: For each language, fetch the embed page to get the HLS URL
    const results = [];
    const seenUrls = new Set();

    for (const lang of languages) {
      if (!lang.embed_url) continue;

      try {
        const hlsUrl = await this.extractHlsUrl(ctx, lang.embed_url);
        if (!hlsUrl) continue;
        if (seenUrls.has(hlsUrl)) continue;
        seenUrls.add(hlsUrl);

        // Determine if this is sub or dub
        const isDub = lang.code === 'eng' || lang.code === 'en';
        const audioLabel = isDub ? 'Dub' : 'Sub';
        const countryCodes = isDub
          ? [CountryCode.multi, CountryCode.en]
          : [CountryCode.multi, CountryCode.ja];

        results.push({
          url: new URL(hlsUrl),
          format: Format.hls,
          meta: {
            countryCodes,
            title: `${title} (${audioLabel})`,
            sourceId: this.id,
            sourceLabel: this.label,
          },
        });
      } catch { /* skip failed language */ }
    }

    return results;
  }

  async findAnime(ctx, name) {
    // Search via suggestions API
    const searchUrl = new URL(`/search/suggestions?q=${encodeURIComponent(name)}`, BASE_URL);
    let html;
    try {
      html = await this.fetcher.text(ctx, searchUrl, {
        headers: {
          Accept: 'text/html,application/json,*/*',
          Referer: BASE_URL + '/home',
        },
      });
    } catch { return null; }

    // Parse the search results — links can be /anime/{slug}-{id} or full URL
    const nameLower = name.toLowerCase();

    // Find all anime links (both relative and absolute URLs)
    const matches = [...html.matchAll(/href="(?:https?:\/\/anidb\.app)?\/anime\/([^"]+)-(\d+)"/g)];
    if (matches.length === 0) return null;

    // Find the best match by title text
    for (const match of matches) {
      const slug = match[1];
      const id = match[2];
      // Check if the link text contains the search name
      const linkRegex = new RegExp(`href="(?:https?://anidb\\.app)?/anime/${slug}-${id}"[^>]*>[\\s\\S]*?<p[^>]*>([^<]+)</p>`, 'i');
      const linkMatch = html.match(linkRegex);
      if (linkMatch) {
        const linkTitle = linkMatch[1].toLowerCase().trim();
        if (linkTitle.includes(nameLower) || nameLower.includes(linkTitle.slice(0, 20))) {
          return { id: parseInt(id), slug };
        }
      }
    }

    // Fallback: return the first result
    const first = matches[0];
    return { id: parseInt(first[2]), slug: first[1] };
  }

  async fetchEpisodes(ctx, animeId) {
    const apiUrl = new URL(`/api/frontend/anime/${animeId}/episodes`, BASE_URL);
    try {
      const json = await this.fetcher.json(ctx, apiUrl, {
        headers: {
          Accept: 'application/json',
          Referer: BASE_URL + '/anime/' + animeId,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
        },
      });
      return Array.isArray(json.episodes) ? json.episodes : [];
    } catch { return []; }
  }

  async fetchLanguages(ctx, episodeId) {
    const apiUrl = new URL(`/api/frontend/episode/${episodeId}/languages`, BASE_URL);
    try {
      const json = await this.fetcher.json(ctx, apiUrl, {
        headers: {
          Accept: 'application/json',
          Referer: BASE_URL + '/',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
        },
      });
      return Array.isArray(json.languages) ? json.languages : [];
    } catch { return []; }
  }

  async extractHlsUrl(ctx, embedUrl) {
    const fullUrl = embedUrl.startsWith('http') ? embedUrl : BASE_URL + embedUrl;
    let html;
    try {
      html = await this.fetcher.text(ctx, new URL(fullUrl), {
        headers: { Referer: BASE_URL + '/' },
      });
    } catch { return null; }

    // Look for: file: 'https://hls.anidb.app/stream/{token}/master.m3u8'
    const match = html.match(/file\s*:\s*['"](https:\/\/hls\.anidb\.app\/stream\/[^'"]+\/master\.m3u8)['"]/i);
    return match?.[1] || null;
  }
}
