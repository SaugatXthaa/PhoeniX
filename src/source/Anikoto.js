// src/source/Anikoto.js
// anikoto.cz — anime-only streaming (TV, Movie, OVA, ONA, Special)
//
// Site is behind Cloudflare but serves HTTP 200 to a desktop User-Agent
// with no JS challenge. Sub/Dub streams available.
//
// Flow (verified live):
//   1. Search: GET /filter?keyword={title} → HTML cards with /watch/{slug}/ep-{N}
//   2. Detail page: GET /watch/{slug} → extract data-id (anime numeric ID)
//   3. Episode list: GET /ajax/episode/list/{animeId}?style=grid&vrf={vrf}
//      where vrf = base64(RC4("simple-hash", String(animeId)))
//      → JSON { status:200, result: "<html>" } with <a data-ids=... data-slug=... >
//   4. Server list: GET /ajax/server/list?servers={data-ids}
//      → JSON { status:200, result: "<html>" } with .type[data-type=sub|dub|hsub] li
//   5. Embed URL: GET /ajax/server?get={data-link-id}
//      → JSON { status:200, result: { url: "https://megaplay.buzz/stream/..." } }
//
// All embed URLs point to megaplay.buzz (or its mirror vidtube.site), which
// uses a heavily-obfuscated JWPlayer + HLS.js setup. The Megaplay extractor
// routes these through /proxy with the appropriate Referer so Stremio can
// attempt playback.
//
// Stremio passes kitsu:/mal: IDs for anime; we resolve to TMDB, then to a
// name, then search anikoto by name. Anime on anikoto is episode-based
// (flat numbering), so we map Stremio's season/episode to the absolute
// episode number.

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://anikoto.cz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// RC4 stream cipher — used by anikoto to generate the `vrf` query parameter
// for the episode list endpoint. Verified working live.
function rc4(key, plaintext) {
  const s = new Array(256);
  for (let n = 0; n < 256; n++) s[n] = n;
  let a = 0;
  for (let n = 0; n < 256; n++) {
    a = (a + s[n] + key.charCodeAt(n % key.length)) % 256;
    [s[n], s[a]] = [s[a], s[n]];
  }
  a = 0;
  let n = 0;
  let out = '';
  for (let r = 0; r < plaintext.length; r++) {
    n = (n + 1) % 256;
    const e = s[n];
    s[n] = s[a = (a + s[n]) % 256];
    s[a] = e;
    out += String.fromCharCode(plaintext.charCodeAt(r) ^ s[(s[n] + s[a]) % 256]);
  }
  return out;
}

const vrf = (animeId) =>
  Buffer.from(rc4('simple-hash', String(animeId)), 'binary').toString('base64');

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

export class Anikoto extends Source {
  constructor(fetcher) {
    super();
    this.id = 'anikoto';
    this.label = 'Anikoto';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search anikoto by name
    const animeSlug = await this.findAnime(name);
    if (!animeSlug) return [];

    // Step 2: Fetch detail page to get the anime numeric ID
    const detailUrl = new URL(animeSlug, BASE_URL);
    const detailHtml = await fetchPage(detailUrl.href, `${BASE_URL}/`);
    if (!detailHtml) return [];

    const idMatch = detailHtml.match(/class="layout-page-watch[^"]*"[^>]*data-id="(\d+)"/);
    if (!idMatch) return [];
    const animeId = idMatch[1];

    // Step 3: Fetch episode list via AJAX endpoint (with vrf)
    const epListUrl = `${BASE_URL}/ajax/episode/list/${animeId}?style=grid&vrf=${encodeURIComponent(vrf(animeId))}`;
    const epData = await fetchJson(epListUrl, detailUrl.href);
    if (!epData || epData.status !== 200 || !epData.result) return [];

    // Step 4: Find the right episode's data-ids
    // For movies (no season), episode slug is "1"
    // For series, episode slug is the absolute episode number
    const targetEp = tmdbId.season ? (tmdbId.episode || 1) : 1;
    const episode = this.findEpisodeInHtml(epData.result, targetEp);
    if (!episode) return [];

    // Step 5: Fetch server list for this episode
    const serverListUrl = `${BASE_URL}/ajax/server/list?servers=${encodeURIComponent(episode.ids)}`;
    const slData = await fetchJson(serverListUrl, `${detailUrl.href}/ep-${targetEp}`);
    if (!slData || slData.status !== 200 || !slData.result) return [];

    // Step 6: Parse server groups (sub/dub/hsub) and resolve each link-id
    const servers = this.parseServers(slData.result);
    if (servers.length === 0) return [];

    // Step 7: Resolve embed URLs for each server (limit to first 3 per type
    // to avoid excessive API calls)
    const results = [];
    const seenUrls = new Set();
    const seenLabels = new Set();

    // Prioritize sub then dub — keep one server per (type, server-name) pair
    const dedupedServers = [];
    for (const type of ['sub', 'dub', 'hsub']) {
      const byType = servers.filter(s => s.type === type);
      const seenNames = new Set();
      for (const s of byType) {
        const key = `${type}_${s.name}`;
        if (seenNames.has(s.name)) continue;
        seenNames.add(s.name);
        dedupedServers.push(s);
        if (dedupedServers.filter(x => x.type === type).length >= 3) break;
      }
    }

    for (const server of dedupedServers) {
      const embedUrl = await this.resolveEmbedUrl(server.linkId, `${detailUrl.href}/ep-${targetEp}`);
      if (!embedUrl) continue;
      if (seenUrls.has(embedUrl)) continue;
      seenUrls.add(embedUrl);

      // Build display label
      let audioLabel = 'Sub';
      let countryCodes = [CountryCode.multi, CountryCode.ja];
      if (server.type === 'dub') {
        audioLabel = 'Dub';
        countryCodes = [CountryCode.multi, CountryCode.en];
      } else if (server.type === 'hsub') {
        audioLabel = 'Hard Sub';
      }

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

  // Search anikoto by name and return the best matching /watch/{slug} URL
  async findAnime(name) {
    const queries = [
      name,
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
      name.split(' ')[0],
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    const nameNorm = normalize(name);

    for (const query of queries) {
      const searchUrl = `${BASE_URL}/filter?keyword=${encodeURIComponent(query)}`;
      const html = await fetchPage(searchUrl, `${BASE_URL}/`);
      if (!html) continue;

      const $ = cheerio.load(html);

      let bestMatch = null;
      let bestScore = 0;

      $('.item').each((_i, el) => {
        if (bestScore >= 100) return;
        const $title = $(el).find('.name.d-title');
        const href = $title.attr('href');
        if (!href) return;

        const titleText = ($title.text() || '').trim();
        const jpText = $title.attr('data-jp') || '';
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

      if (bestMatch && bestScore >= 0.6) return bestMatch;
    }

    return null;
  }

  // Find episode data-ids in the AJAX-returned HTML
  findEpisodeInHtml(html, episodeNum) {
    const $ = cheerio.load(html);
    let result = null;

    $('a[data-ids]').each((_i, el) => {
      if (result) return;
      const num = parseInt($(el).attr('data-num') || '0', 10);
      const slug = $(el).attr('data-slug') || '';
      if (num === episodeNum || slug === String(episodeNum)) {
        result = {
          num,
          slug,
          ids: $(el).attr('data-ids'),
          mal: $(el).attr('data-mal'),
          timestamp: $(el).attr('data-timestamp'),
        };
      }
    });

    // Fallback: if exact match not found, take the first episode (for movies)
    if (!result) {
      const first = $('a[data-ids]').first();
      if (first.length) {
        result = {
          num: parseInt(first.attr('data-num') || '1', 10),
          slug: first.attr('data-slug') || '1',
          ids: first.attr('data-ids'),
          mal: first.attr('data-mal'),
          timestamp: first.attr('data-timestamp'),
        };
      }
    }

    return result;
  }

  // Parse server groups from the AJAX-returned HTML
  parseServers(html) {
    const $ = cheerio.load(html);
    const servers = [];

    $('.type').each((_i, typeEl) => {
      const type = $(typeEl).attr('data-type') || 'sub';
      $(typeEl).find('li[data-link-id]').each((_j, li) => {
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
