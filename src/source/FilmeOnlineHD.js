// src/source/FilmeOnlineHD.js
// filmeonlinehd.digital — Hindi movies/series/anime via linksdrive → HubCloud/GDFlix
//
// Flow:
//   1. Search: GET /?s={title} → find movie/series detail page links
//   2. Detail page → find linksdrive.shop/d2d/{ID} download links
//   3. Linksdrive page → parse HubCloud (hubcloud.cx/drive/{code}) and
//      GDFlix (gdflix.dev/file/{code}) links grouped by quality
//   4. HubCloud links → HubExtractor → direct CDN URLs
//      GDFlix links → direct R2/busycdn CDN URLs (via GDFlix extractor)
//
// Same pattern as 4KHDHub/MoviesDrive — HubCloud links resolved by HubExtractor.

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://filmeonlinehd.digital';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function fetchPage(url) {
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
  });
  return res.statusCode === 200 ? res.body : null;
}

export class FilmeOnlineHD extends Source {
  constructor(fetcher) {
    super();
    this.id = 'filmeonlinehd';
    this.label = 'FilmeOnlineHD';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
    // Short TTL — don't cache negative results (0 streams) for 12h
    this.ttl = 5 * 60 * 1000; // 5min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search
    const detailUrl = await this.findDetailPage(name);
    if (!detailUrl) return [];

    // Step 2: Get linksdrive URL from detail page
    const linksdriveUrl = await this.findLinksdriveUrl(detailUrl);
    if (!linksdriveUrl) return [];

    // Step 3: Parse linksdrive page for HubCloud/GDFlix links
    const streamLinks = await this.parseLinksdrivePage(linksdriveUrl);
    if (streamLinks.length === 0) return [];

    // Step 4: Return stream URLs — HubExtractor claims hubcloud.cx URLs,
    // and GDFlix URLs are handled by the HubExtractor too (gdflix.dev links
    // contain hubcloud patterns that HubExtractor matches, or they get
    // claimed by DirectStream for r2.dev URLs)
    const results = [];
    const seenUrls = new Set();
    for (const link of streamLinks) {
      if (seenUrls.has(link.url)) continue;
      seenUrls.add(link.url);
      try {
        const parsed = new URL(link.url);
        results.push({
          url: parsed,
          meta: {
            countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
            title: `${title} (${link.quality})`,
            sourceId: this.id,
            sourceLabel: this.label,
          },
        });
      } catch { /* skip invalid URL */ }
    }

    return results;
  }

  async findDetailPage(name) {
    // Try shorter queries first — the site has limited catalog and long
    // search queries may return fewer results
    const nameClean = name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const queries = [
      nameClean,
      nameClean.split(' ').slice(0, 3).join(' '),  // first 3 words
      nameClean.split(' ').slice(0, 2).join(' '),  // first 2 words
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);
    const nameNorm = normalize(name);

    for (const query of queries) {
      const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
      const html = await fetchPage(searchUrl);
      if (!html) continue;

      const $ = cheerio.load(html);
      let bestMatch = null;
      let bestScore = 0;

      $('a[href*="filmeonlinehd.digital/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || href.includes('/category/') || href.includes('/wp-') ||
            href.includes('/feed') || href.includes('/page/') ||
            href === BASE_URL + '/') return;
        const text = normalize($(el).text());
        if (!text || text.length < 3) return;

        let score = 0;
        if (text === nameNorm) score = 100;
        else if (text.includes(nameNorm) || nameNorm.includes(text)) {
          score = Math.min(text.length, nameNorm.length) / Math.max(text.length, nameNorm.length) * 90;
        }
        // Also check if the URL slug contains the normalized name
        if (score < 35) {
          const slug = normalize(href.split('/').filter(Boolean).pop() || '');
          if (slug.includes(nameNorm.replace(/\s/g, '-')) || nameNorm.includes(slug.replace(/-/g, ' '))) {
            score = 50; // URL slug match = decent confidence
          }
        }
        if (score > bestScore) {
          bestScore = score;
          bestMatch = href;
        }
      });

      if (bestMatch && bestScore >= 35) return bestMatch;
    }
    return null;
  }

  async findLinksdriveUrl(detailUrl) {
    const html = await fetchPage(detailUrl);
    if (!html) return null;
    const $ = cheerio.load(html);
    const link = $('a[href*="linksdrive.shop"]').first().attr('href');
    return link || null;
  }

  async parseLinksdrivePage(linksdriveUrl) {
    const html = await fetchPage(linksdriveUrl);
    if (!html) return [];

    // Extract all external download links from the page
    // The page has links to various file hosts: fastdl.zip, vcloud.zip,
    // filebee.xyz, 1fichier.com, gofile.io, megaup.net, vikingfile.com, etc.
    const links = [];
    const seenUrls = new Set();

    // Find all <a> tags with external hrefs
    const hrefMatches = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
    for (const href of hrefMatches) {
      // Skip internal/wp links
      if (href.includes('linksdrive.shop') || href.includes('wp-') ||
          href.includes('gmpg.org') || href.includes('feed') ||
          href.includes('/json/') || href.includes('xmlrpc')) continue;

      // Include known file host links
      if (href.includes('hubcloud.cx') || href.includes('gdflix.dev') ||
          href.includes('gdflix.io') || href.includes('fastdl.zip') ||
          href.includes('vcloud.zip') || href.includes('filebee.xyz') ||
          href.includes('vikingfile.com')) {
        if (seenUrls.has(href)) continue;
        seenUrls.add(href);

        // Try to extract quality from nearby text
        let quality = 'HD';
        const qualityMatch = href.match(/(\d{3,4})p/i);
        if (qualityMatch) quality = `${qualityMatch[1]}p`;

        links.push({ quality, url: href });
      }
    }

    return links;
  }
}
