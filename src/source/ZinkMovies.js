// src/source/ZinkMovies.js
// new1.zinkmovies.mobi — movies and TV series via ZinkCloud → HubCloud
//
// Flow:
//   1. Search: /?s={title} → find /movies/{slug}/ post links
//   2. Movie page → find zinkcloud.net/file/{id} links with quality+size text
//   3. ZinkCloud: POST /ajax_generate_token.php?random_id={id} → get token
//   4. Fetch /dl/{token} → extract hubcloud.cx/drive/{id} links
//   5. HubCloud links resolved by HubExtractor → direct CDN URLs

import bytes from 'bytes';
import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId, findCountryCodes } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://new1.zinkmovies.mobi';
const ZINKCLOUD_BASE = 'https://new4.zinkcloud.net';

export class ZinkMovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'zinkmovies';
    this.label = 'ZinkMovies';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search for the movie
    const postUrl = await this.findPost(ctx, name, year);
    if (!postUrl) return [];

    // Step 2: Fetch movie page → find ZinkCloud links with quality/size
    const zinkLinks = await this.findZinkCloudLinks(ctx, postUrl, title, tmdbId);
    if (zinkLinks.length === 0) return [];

    // Step 3+4: For each ZinkCloud link, generate token and extract hubcloud links
    const results = [];
    for (const zinkLink of zinkLinks) {
      try {
        const hubcloudLinks = await this.resolveZinkCloud(ctx, zinkLink.fileId);
        for (const hubUrl of hubcloudLinks) {
          try {
            const url = new URL(hubUrl);
            results.push({
              url,
              meta: {
                countryCodes: [CountryCode.multi, ...findCountryCodes(zinkLink.text)],
                ...(zinkLink.height && { height: zinkLink.height }),
                ...(zinkLink.bytes && { bytes: zinkLink.bytes }),
                title: `${title} — ${zinkLink.quality || ''} ${zinkLink.sizeText || ''}`.trim(),
                sourceId: this.id,
                sourceLabel: this.label,
              },
            });
          } catch { /* skip invalid URL */ }
        }
      } catch { /* skip failed zinkcloud resolution */ }
    }

    return results;
  }

  async findPost(ctx, name, year) {
    const queries = [
      name,
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    for (const query of queries) {
      try {
        const searchUrl = new URL(`/?s=${encodeURIComponent(query)}`, BASE_URL);
        const html = await this.fetcher.text(ctx, searchUrl, {
          headers: { Accept: 'text/html' },
          timeout: 10000,
        });

        const $ = cheerio.load(html);
        // Normalize: remove punctuation and extra spaces for matching
        const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const nameNorm = normalize(name);

        // Find post links (exclude non-post URLs)
        let bestMatch = null;
        $('a[href*="/movies/"]').each((_i, el) => {
          if (bestMatch) return;
          const href = $(el).attr('href');
          if (!href || href.includes('category/') || href.includes('?s=') || href === BASE_URL + '/movies/' || href === '/movies/') return;

          const text = normalize($(el).text());
          const titleAttr = normalize($(el).attr('title') || '');
          const altAttr = normalize($(el).find('img').attr('alt') || '');

          if (text.includes(nameNorm) || titleAttr.includes(nameNorm) || altAttr.includes(nameNorm)) {
            bestMatch = href;
          }
        });

        // Try partial word match
        if (!bestMatch) {
          const nameWords = nameNorm.split(/\s+/).filter(w => w.length > 2);
          const firstWords = nameWords.slice(0, Math.min(3, nameWords.length)).join(' ');
          if (firstWords.length > 3) {
            $('a[href*="/movies/"]').each((_i, el) => {
              if (bestMatch) return;
              const href = $(el).attr('href');
              if (!href || href.includes('category/') || href.includes('?s=') || href === BASE_URL + '/movies/' || href === '/movies/') return;
              const text = normalize($(el).text());
              const altAttr = normalize($(el).find('img').attr('alt') || '');
              if (text.includes(firstWords) || altAttr.includes(firstWords)) {
                bestMatch = href;
              }
            });
          }
        }

        if (bestMatch) return bestMatch;
      } catch { /* continue to next query */ }
    }

    return null;
  }

  async findZinkCloudLinks(ctx, postUrl, title, tmdbId) {
    let html;
    try {
      html = await this.fetcher.text(ctx, new URL(postUrl));
    } catch { return []; }

    const $ = cheerio.load(html);
    const links = [];

    // Find all zinkcloud.net links
    $('a[href*="zinkcloud"]').each((_i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (!href) return;

      // Extract file ID from URL: https://new4.zinkcloud.net/file/{id}
      const fileIdMatch = href.match(/\/file\/(\w+)/);
      if (!fileIdMatch) return;

      const fileId = fileIdMatch[1];

      // Parse quality and size from link text
      // e.g. "720P Hindi-English BLURAY ESUB 1.99 GB"
      const qualityMatch = text.match(/(\d{3,4})p/i);
      const sizeMatch = text.match(/([\d.]+)\s*(GB|MB)/i);
      const height = qualityMatch ? parseInt(qualityMatch[1]) : undefined;
      const fileSize = sizeMatch ? bytes.parse(`${sizeMatch[1]} ${sizeMatch[2]}`) : undefined;

      links.push({
        fileId,
        text,
        quality: qualityMatch ? qualityMatch[0] : undefined,
        height,
        sizeText: sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2]}` : undefined,
        bytes: fileSize,
      });
    });

    return links;
  }

  async resolveZinkCloud(ctx, fileId) {
    // Step 1: Generate token
    const tokenUrl = new URL(`/ajax_generate_token.php?random_id=${encodeURIComponent(fileId)}`, ZINKCLOUD_BASE);
    let tokenData;
    try {
      const tokenResponse = await this.fetcher.textPost(ctx, tokenUrl, `random_id=${fileId}`, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `${ZINKCLOUD_BASE}/file/${fileId}`,
        },
        timeout: 10000,
      });
      tokenData = JSON.parse(tokenResponse);
    } catch { return []; }

    if (tokenData.status !== 'success' || !tokenData.token) return [];

    // Step 2: Fetch /dl/{token} page → extract hubcloud links
    const dlUrl = new URL(`/dl/${encodeURIComponent(tokenData.token)}`, ZINKCLOUD_BASE);
    let dlHtml;
    try {
      dlHtml = await this.fetcher.text(ctx, dlUrl, {
        headers: { Referer: `${ZINKCLOUD_BASE}/file/${fileId}` },
        timeout: 10000,
      });
    } catch { return []; }

    // Extract hubcloud links
    const hubcloudLinks = [];
    const matches = dlHtml.match(/https?:\/\/[^"'\s]*hubcloud[^"'\s]*/gi) || [];
    for (const match of matches) {
      if (!hubcloudLinks.includes(match)) hubcloudLinks.push(match);
    }

    return hubcloudLinks;
  }
}
