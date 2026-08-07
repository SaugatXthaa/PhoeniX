// src/source/AniNeko.js
// anineko.to — anime with hard-sub, soft-sub, and dub
//
// Flow:
//   1. Search: /browser?keyword={title} → find /watch/{slug}
//   2. Anime page: /watch/{slug} → find episode link /watch/{slug}/ep-{N}
//   3. Episode page: /watch/{slug}/ep-{N} → find .nv-server-btn buttons with
//      data-video="https://otakuvid.online/embed/{id}"
//   4. Parent [data-id] tells us: hsub (hard sub), sub (soft sub), dub (dubbed)
//   5. Fetch otakuvid embed page → decode packed eval JS → extract HLS URL
//   6. Direct HLS — plays natively in Stremio

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://anineko.to';

export class AniNeko extends Source {
  constructor(fetcher) {
    super();
    this.id = 'anineko';
    this.label = 'AniNeko';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search
    const animeSlug = await this.findAnime(ctx, name);
    if (!animeSlug) return [];

    // Step 2: Find episode URL
    const targetEp = tmdbId.season ? (tmdbId.episode || 1) : 1;
    const epUrl = await this.findEpisodeUrl(ctx, animeSlug, targetEp);
    if (!epUrl) return [];

    // Step 3: Extract server embed URLs with sub/dub type
    const servers = await this.extractServers(ctx, epUrl);
    if (servers.length === 0) return [];

    // Step 4: For each server, fetch the embed and extract HLS URL
    const results = [];
    const seenUrls = new Set();

    for (const server of servers) {
      if (!server.embedUrl) continue;

      try {
        const hlsUrl = await this.extractHlsUrl(ctx, server.embedUrl);
        if (!hlsUrl) continue;
        if (seenUrls.has(hlsUrl)) continue;
        seenUrls.add(hlsUrl);

        // Determine sub/dub label
        let audioLabel = 'Sub';
        let countryCodes = [CountryCode.multi, CountryCode.ja];
        if (server.type === 'dub') {
          audioLabel = 'Dub';
          countryCodes = [CountryCode.multi, CountryCode.en];
        } else if (server.type === 'hsub') {
          audioLabel = 'Hard Sub';
        }

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
      } catch { /* skip failed server */ }
    }

    return results;
  }

  async findAnime(ctx, name) {
    const searchUrl = new URL(`/browser?keyword=${encodeURIComponent(name)}`, BASE_URL);
    let html;
    try {
      html = await this.fetcher.text(ctx, searchUrl);
    } catch { return null; }

    const $ = cheerio.load(html);
    const nameLower = name.toLowerCase();

    // Find the best matching /watch/ link
    let bestMatch = null;
    $('a[href*="/watch/"]').each((_i, el) => {
      if (bestMatch) return;
      const href = $(el).attr('href');
      if (!href || href.includes('/ep-')) return;

      // Check if the link text or nearby text matches
      const linkText = $(el).text().toLowerCase().trim();
      const titleAttr = ($(el).attr('title') || '').toLowerCase();
      const imgAlt = ($(el).find('img').attr('alt') || '').toLowerCase();

      if (linkText.includes(nameLower) || titleAttr.includes(nameLower) || imgAlt.includes(nameLower) ||
          nameLower.includes(linkText.slice(0, 20))) {
        bestMatch = href;
      }
    });

    // Fallback: first /watch/ link
    if (!bestMatch) {
      bestMatch = $('a[href*="/watch/"]').first().attr('href');
    }

    return bestMatch || null;
  }

  async findEpisodeUrl(ctx, animeSlug, episodeNum) {
    const url = new URL(animeSlug, BASE_URL);
    let html;
    try {
      html = await this.fetcher.text(ctx, url);
    } catch { return null; }

    const $ = cheerio.load(html);

    // Find the episode link: /watch/{slug}/ep-{N}
    const epPattern = `/ep-${episodeNum}`;
    let epUrl = null;

    $(`a[href*="${epPattern}"]`).each((_i, el) => {
      if (epUrl) return;
      const href = $(el).attr('href');
      // Make sure it's exactly ep-N, not ep-NN (e.g. ep-1 not ep-10)
      if (href && href.match(new RegExp(`/ep-${episodeNum}$`))) {
        epUrl = href;
      }
    });

    // Fallback: try ep-1 if looking for episode 1
    if (!epUrl && episodeNum === 1) {
      epUrl = $(`a[href*="/ep-1"]`).first().attr('href');
    }

    return epUrl || null;
  }

  async extractServers(ctx, episodeUrl) {
    const url = new URL(episodeUrl, BASE_URL);
    let html;
    try {
      html = await this.fetcher.text(ctx, url);
    } catch { return []; }

    const $ = cheerio.load(html);
    const servers = [];

    // Find all .nv-server-btn buttons with data-video
    $('.nv-server-btn[data-video]').each((_i, el) => {
      const embedUrl = $(el).attr('data-video');
      if (!embedUrl || !embedUrl.includes('otakuvid.online')) return;

      // Find the parent [data-id] to determine sub/dub type
      const parentType = $(el).closest('[data-id]').attr('data-id') || 'sub';

      // Get the server name
      const serverName = $(el).text().trim().slice(0, 40);

      servers.push({
        embedUrl,
        type: parentType,
        serverName,
      });
    });

    return servers;
  }

  async extractHlsUrl(ctx, embedUrl) {
    let html;
    try {
      html = await this.fetcher.text(ctx, new URL(embedUrl), {
        headers: { Referer: BASE_URL + '/' },
      });
    } catch { return null; }

    // The embed page has packed eval JS with the stream URL
    // Pattern: eval(function(p,a,c,k,e,d){...}('packed',base,count,'keys'.split('|')))

    // Find the eval block
    const evalStart = html.indexOf('eval(function(p,a,c,k,e,d)');
    if (evalStart === -1) return null;

    // Find .split('|'))
    const splitIdx = html.indexOf(".split('|'))", evalStart);
    if (splitIdx === -1) return null;

    // The keys string is between the last two ' before .split('|'))
    const beforeSplit = html.slice(0, splitIdx);
    const lastQuote = beforeSplit.lastIndexOf("'");
    const secondLastQuote = beforeSplit.lastIndexOf("'", lastQuote - 1);
    const keysStr = beforeSplit.slice(secondLastQuote + 1, lastQuote);
    const keys = keysStr.split('|');

    // Find base and count: ...,base,count,'keys
    const beforeKeys = beforeSplit.slice(0, secondLastQuote);
    const bcMatch = beforeKeys.match(/,(\d+),(\d+),$/);
    if (!bcMatch) return null;

    const a = parseInt(bcMatch[1]);
    const c = parseInt(bcMatch[2]);

    // Find the packed string: }('packed',base,count,
    const packedStart = html.indexOf("}('", evalStart) + 3;
    let packed = html.slice(packedStart, secondLastQuote);
    // Remove trailing ,base,count,
    packed = packed.replace(new RegExp(`,${a},${c},$`), '');
    // Unescape
    packed = packed.replace(/\\'/g, "'");

    // Decode
    let decoded = packed;
    for (let i = c - 1; i >= 0; i--) {
      if (keys[i]) {
        const numStr = i.toString(a);
        const regex = new RegExp('\\b' + numStr + '\\b', 'g');
        decoded = decoded.replace(regex, keys[i]);
      }
    }

    // Extract HLS URL from decoded JS
    // Pattern: "hls2":"https://...master.m3u8?..." or "hls3":"https://...master.txt"
    // hls2 uses .m3u8 extension, hls3 uses .txt extension (same HLS content)
    // Both play in Stremio — return the URL as-is without converting extensions
    const hlsMatch = decoded.match(/"hls\d"\s*:\s*"(https:\/\/[^"]+(?:master\.m3u8|master\.txt)[^"]*)"/i);
    if (hlsMatch) {
      return hlsMatch[1];
    }

    // Fallback: find any m3u8 URL
    const m3u8Match = decoded.match(/(https:\/\/[^"'\s]+master\.m3u8[^"'\s]*)/i);
    return m3u8Match?.[1] || null;
  }
}
