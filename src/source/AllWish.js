// src/source/AllWish.js
// all-wish.me — Animesuge/hianime clone with Laravel AJAX backend
//
// Flow (all JSON, no VRF/token validation needed):
//   1. Search: GET /filter?keyword={title} → HTML cards with /watch/{slug}-{5charId}/ep-N
//   2. Detail page: GET /watch/{slug}-{5charId} → extract data-id (numeric anime ID)
//   3. Episode list: GET /ajax/episode/list/{animeId}
//      Headers: X-Requested-With: XMLHttpRequest
//      → {status:200, result:"<html>"} with <a data-ids=... data-slug=... data-sub=... data-dub=...>
//   4. Server list: GET /ajax/server/list?servers={data-ids}
//      Headers: X-Requested-With: XMLHttpRequest
//      → {status:200, result:"<html>"} with .server-type[data-type=sub|dub] .server[data-link-id=...]
//   5. Embed URL: GET /ajax/server?get={data-link-id}
//      Headers: X-Requested-With: XMLHttpRequest
//      → {status:200, result:{url:"https://megaplay.buzz/stream/s-1/{token}"}}
//
// The Megaplay extractor handles resolving to direct m3u8 via getSourcesNew.
// Both SUB and DUB streams are returned when available (data-sub/data-dub flags).

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://all-wish.me';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Normalize for fuzzy title matching
const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function fetchPage(url, referer) {
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(referer && { Referer: referer }),
    },
    timeout: { request: 15000 },
    throwHttpErrors: false,
    followRedirect: true,
  });
  return res.statusCode === 200 ? res.body : null;
}

async function fetchJson(url, referer) {
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      ...(referer && { Referer: referer }),
    },
    timeout: { request: 15000 },
    throwHttpErrors: false,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

export class AllWish extends Source {
  constructor(fetcher) {
    super();
    this.id = 'allwish';
    this.label = 'AllWish';
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
    const watchSlug = await this.findAnime(name);
    if (!watchSlug) return [];

    // Step 2: Fetch detail page to get the numeric anime ID
    const detailUrl = new URL(watchSlug, BASE_URL);
    const detailHtml = await fetchPage(detailUrl.href, `${BASE_URL}/`);
    if (!detailHtml) return [];

    const $detail = cheerio.load(detailHtml);
    const animeId = $detail('.favourite[data-id]').attr('data-id') ||
      $detail('[data-id]').first().attr('data-id');
    if (!animeId) return [];

    // Step 3: Fetch episode list via AJAX (no vrf needed — all-wish doesn't validate it)
    const epListUrl = `${BASE_URL}/ajax/episode/list/${animeId}`;
    const epData = await fetchJson(epListUrl, detailUrl.href);
    if (!epData || epData.status !== 200 || !epData.result) return [];

    // Step 4: Find the right episode's data-ids + sub/dub availability
    const targetEp = tmdbId.season ? (tmdbId.episode || 1) : 1;
    const episode = this.findEpisodeInHtml(epData.result, targetEp);
    if (!episode) return [];

    // Step 5: Fetch server list for this episode
    // Send data-ids RAW (not URL-encoded) — all-wish's jQuery sends it raw
    const serverListUrl = `${BASE_URL}/ajax/server/list?servers=${episode.ids}`;
    const slData = await fetchJson(serverListUrl, `${detailUrl.href}/ep-${targetEp}`);
    if (!slData || slData.status !== 200 || !slData.result) return [];

    // Step 6: Parse server groups (sub/dub) and resolve each link-id
    const servers = this.parseServers(slData.result);
    if (servers.length === 0) return [];

    // Step 7: Resolve embed URLs — prefer sub then dub, dedupe by server name
    const results = [];
    const seenUrls = new Set();
    const seenLabels = new Set();

    // Group by type and dedupe by server name within each type
    const dedupedServers = [];
    for (const type of ['sub', 'dub']) {
      // Only include if the episode has this language (data-sub/data-dub flags)
      const hasLang = type === 'sub' ? episode.hasSub : episode.hasDub;
      if (!hasLang && !servers.some(s => s.type === type)) continue;

      const byType = servers.filter(s => s.type === type);
      const seenNames = new Set();
      for (const s of byType) {
        if (seenNames.has(s.name)) continue;
        seenNames.add(s.name);
        dedupedServers.push(s);
        if (dedupedServers.filter(x => x.type === type).length >= 2) break;
      }
    }

    for (const server of dedupedServers) {
      const embedUrl = await this.resolveEmbedUrl(server.linkId, `${detailUrl.href}/ep-${targetEp}`);
      if (!embedUrl) continue;
      if (seenUrls.has(embedUrl)) continue;
      seenUrls.add(embedUrl);

      const audioLabel = server.type === 'dub' ? 'Dub' : 'Sub';
      const countryCodes = server.type === 'dub'
        ? [CountryCode.multi, CountryCode.en]
        : [CountryCode.multi, CountryCode.ja];

      const labelKey = `${audioLabel}_${server.name}`;
      if (seenLabels.has(labelKey)) continue;
      seenLabels.add(labelKey);

      results.push({
        url: new URL(embedUrl),
        meta: {
          countryCodes,
          title: `${title} (${audioLabel} · ${server.name})`,
          sourceId: this.id,
          sourceLabel: this.label,
        },
      });
    }

    return results;
  }

  // Search all-wish by name and return the best matching /watch/{slug} URL
  async findAnime(name) {
    const queries = [
      name,
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    const nameNorm = normalize(name);

    for (const query of queries) {
      const searchUrl = `${BASE_URL}/filter?keyword=${encodeURIComponent(query)}`;
      const html = await fetchPage(searchUrl, `${BASE_URL}/`);
      if (!html) continue;

      const $ = cheerio.load(html);

      let bestMatch = null;
      let bestScore = 0;

      $('div.item').each((_i, el) => {
        if (bestScore >= 100) return;
        const $a = $(el).find('a.poster').first();
        const $name = $(el).find('.name a').first();
        const href = $a.attr('href') || $name.attr('href');
        if (!href) return;

        const titleText = ($name.text() || '').trim();
        const jpText = $name.attr('data-jp') || '';
        const tNorm = normalize(titleText);
        const jpNorm = normalize(jpText);

        if (!tNorm && !jpNorm) return;

        let score = 0;
        if (tNorm === nameNorm || jpNorm === nameNorm) score = 100;
        else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
          score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
        } else if (jpNorm && (jpNorm.includes(nameNorm) || nameNorm.includes(jpNorm))) {
          score = Math.min(jpNorm.length, nameNorm.length) / Math.max(jpNorm.length, nameNorm.length) * 90;
        }

        if (score > bestScore) {
          bestScore = score;
          // Strip /ep-N suffix → detail page URL
          bestMatch = href.replace(/\/ep-\d+\/?$/, '');
        }
      });

      if (bestMatch && bestScore >= 60) return bestMatch;
    }

    return null;
  }

  // Find episode data-ids + sub/dub flags in the AJAX-returned HTML
  findEpisodeInHtml(html, episodeNum) {
    const $ = cheerio.load(html);
    let result = null;

    $('a[data-ids]').each((_i, el) => {
      if (result) return;
      const num = parseInt($(el).attr('data-slug') || '0', 10);
      const textNum = parseInt($(el).text().trim(), 10);
      if (num === episodeNum || textNum === episodeNum) {
        result = {
          num: num || textNum,
          slug: $(el).attr('data-slug') || String(episodeNum),
          ids: $(el).attr('data-ids'),
          hasSub: $(el).attr('data-sub') === '1',
          hasDub: $(el).attr('data-dub') === '1',
        };
      }
    });

    // Fallback: first episode (for movies)
    if (!result) {
      const first = $('a[data-ids]').first();
      if (first.length) {
        result = {
          num: parseInt(first.attr('data-slug') || '1', 10),
          slug: first.attr('data-slug') || '1',
          ids: first.attr('data-ids'),
          hasSub: first.attr('data-sub') === '1',
          hasDub: first.attr('data-dub') === '1',
        };
      }
    }

    return result;
  }

  // Parse server groups from the AJAX-returned HTML
  parseServers(html) {
    const $ = cheerio.load(html);
    const servers = [];

    $('.server-type, .type').each((_i, typeEl) => {
      const type = $(typeEl).attr('data-type') || 'sub';
      $(typeEl).find('.server, li').each((_j, li) => {
        const linkId = $(li).attr('data-link-id');
        const name = $(li).text().trim();
        if (linkId && name) {
          servers.push({ type, name, linkId });
        }
      });
    });

    return servers;
  }

  // Resolve a link-id to an embed URL via the ajax/server endpoint
  async resolveEmbedUrl(linkId, referer) {
    const url = `${BASE_URL}/ajax/server?get=${encodeURIComponent(linkId)}`;
    const data = await fetchJson(url, referer);
    if (!data || data.status !== 200 || !data.result?.url) return null;
    return data.result.url;
  }
}
