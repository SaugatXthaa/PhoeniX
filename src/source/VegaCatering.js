// src/source/VegaCatering.js
// vegamovies.catering — WordPress site with nexdrive.fit → file hosts
//
// Flow:
//   1. Search: GET /wp-json/wp/v2/posts?search={title} (WP REST API — not ?s= which is CF-blocked)
//   2. Parse post content for nexdrive.fit links
//   3. Fetch nexdrive page → extract fastdl.zip, vcloud.fit, gdtot links
//   4. Return file host URLs — DirectStream extractor claims them
//
// The WP REST API returns full post content (including download links) in JSON,
// so no second fetch is needed for the detail page.

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://vegamovies.catering';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function fetchJson(url) {
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

async function fetchPage(url) {
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
  });
  return res.statusCode === 200 ? res.body : null;
}

export class VegaCatering extends Source {
  constructor(fetcher) {
    super();
    this.id = 'vegacatering';
    this.label = 'VegaCatering';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search via WP REST API
    const nexdriveLinks = await this.findNexdriveLinks(name, year, tmdbId);
    if (nexdriveLinks.length === 0) return [];

    // Step 2: For each nexdrive link, fetch and extract file host URLs
    const results = [];
    const seenUrls = new Set();

    for (const nex of nexdriveLinks.slice(0, 6)) {
      try {
        const hostLinks = await this.parseNexdrivePage(nex.url, nex.quality);
        for (const link of hostLinks) {
          if (seenUrls.has(link.url)) continue;
          seenUrls.add(link.url);

          let parsed;
          try { parsed = new URL(link.url); } catch { continue; }

          results.push({
            url: parsed,
            meta: {
              countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
              title: `${title} (${nex.quality} · ${link.host})`,
              sourceId: this.id,
              sourceLabel: this.label,
            },
          });
        }
      } catch { /* skip failed nexdrive page */ }
    }

    return results;
  }

  async findNexdriveLinks(name, year, tmdbId) {
    const nameNorm = normalize(name);
    const queries = [
      name,
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
      name.split(' ').slice(0, 3).join(' '),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    for (const query of queries) {
      const apiUrl = `${BASE_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=10`;
      const posts = await fetchJson(apiUrl);
      if (!Array.isArray(posts) || posts.length === 0) continue;

      // Find the best matching post
      let bestPost = null;
      let bestScore = 0;
      for (const post of posts) {
        const postTitle = post.title?.rendered || '';
        const tNorm = normalize(postTitle);
        if (!tNorm) continue;

        let score = 0;
        if (tNorm === nameNorm) score = 100;
        else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
          score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
        }
        if (score > 0 && year && postTitle.includes(String(year))) score += 10;

        if (score > bestScore) {
          bestScore = score;
          bestPost = post;
        }
      }

      if (bestPost && bestScore >= 35) {
        // Parse post content for nexdrive links with quality info
        const $ = cheerio.load(bestPost.content?.rendered || '');
        const nexLinks = [];
        $('a[href*="nexdrive"]').each((_, el) => {
          const href = $(el).attr('href');
          if (!href) return;

          // Try to get quality from surrounding text
          let quality = 'HD';
          const parentText = $(el).parent().text() + ' ' + $(el).closest('p, div, h3, h4').text();
          const resMatch = parentText.match(/(\d{3,4})p/i);
          if (resMatch) quality = `${resMatch[1]}p`;

          nexLinks.push({ url: href, quality });
        });

        if (nexLinks.length > 0) return nexLinks;
      }
    }

    return [];
  }

  async parseNexdrivePage(nexdriveUrl, quality) {
    const html = await fetchPage(nexdriveUrl);
    if (!html) return [];

    const $ = cheerio.load(html);
    const links = [];

    // Find file host links — fastdl.zip, vcloud.fit, gdtot, filebee, vikingfile
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || !href.startsWith('http')) return;
      if (href.includes('nexdrive') || href.includes('vglist')) return;

      // Known file hosts
      let host = null;
      if (href.includes('fastdl.zip')) host = 'FastDL';
      else if (href.includes('vcloud.fit')) host = 'VCloud';
      else if (href.includes('vcloud.zip')) host = 'VCloud';
      else if (href.includes('gdtot')) host = 'GDrive';
      else if (href.includes('filebee.xyz')) host = 'FileBee';
      else if (href.includes('vikingfile.com')) host = 'VikingFile';
      else if (href.includes('megaup.net')) host = 'MegaUp';

      if (host) {
        links.push({ url: href, host });
      }
    });

    return links;
  }
}
