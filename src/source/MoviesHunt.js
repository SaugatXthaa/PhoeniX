// src/source/MoviesHunt.js
// movieshunt.work — movies, series, anime, K-drama with HubCloud + GDFlix links
//
// Flow:
//   1. Search via WP REST API: /wp-json/wp/v2/posts?search={title}
//   2. Fetch post page → find abhilinks.site redirect link
//   3. Fetch abhilinks page → parse headings (quality/size) + hubcloud links
//   4. HubCloud links resolved by HubExtractor → direct CDN URLs
//
// Structure on abhilinks page:
//   <h3>720p [1.5GB]</h3> → <a href="hubcloud.cx/drive/...">HUBCLOUD [DD]</a>
//   <h3>1080p [4GB]</h3> → <a href="hubcloud.cx/drive/...">HUBCLOUD [DD]</a>
//   Section headers like "BluRay Multi Audio [Hindi + English + Tamil + Telugu]"

import bytes from 'bytes';
import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId, findCountryCodes, findHeight } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://movieshunt.work';

export class MoviesHunt extends Source {
  constructor(fetcher) {
    super();
    this.id = 'movieshunt';
    this.label = 'MoviesHunt';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Search via WP REST API
    const postUrl = await this.findPost(ctx, name, year, tmdbId);
    if (!postUrl) return [];

    // Fetch the post page to find abhilinks redirect
    const abhilinksUrl = await this.findAbhilinksUrl(ctx, postUrl);
    if (!abhilinksUrl) return [];

    // Fetch abhilinks page and extract hubcloud links with quality/size metadata
    const results = await this.extractDownloadLinks(ctx, abhilinksUrl, title, tmdbId);
    return results;
  }

  async findPost(ctx, name, year, tmdbId) {
    // Try multiple search queries
    const queries = [
      name,
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
      name.split(' ')[0],
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    for (const query of queries) {
      try {
        const apiUrl = new URL(`/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=10`, BASE_URL);
        const posts = await this.fetcher.json(ctx, apiUrl, {
          headers: { Accept: 'application/json' },
          timeout: 10000,
        });

        if (Array.isArray(posts) && posts.length > 0) {
          // Find the best match by title
          const nameLower = name.toLowerCase();
          const yearStr = String(year);

          // Try exact year match first
          const yearMatch = posts.find(p => {
            const title = (p.title?.rendered || '').toLowerCase();
            return title.includes(nameLower) && title.includes(yearStr);
          });
          if (yearMatch) return yearMatch.link;

          // Fallback: title contains the name
          const titleMatch = posts.find(p => {
            const title = (p.title?.rendered || '').toLowerCase();
            return title.includes(nameLower);
          });
          if (titleMatch) return titleMatch.link;

          // No fallback to first result — prevents wrong content mismatch
          // (e.g. "Jujutsu Kaisen 0" showing for "House of the Dragon")
        }
      } catch { /* continue to next query */ }
    }

    return null;
  }

  async findAbhilinksUrl(ctx, postUrl) {
    let html;
    try {
      html = await this.fetcher.text(ctx, new URL(postUrl));
    } catch { return null; }

    const $ = cheerio.load(html);
    // Find abhilinks.site redirect link
    let abhilinksUrl = null;
    $('a[href*="abhilinks"]').each((_i, el) => {
      if (abhilinksUrl) return;
      const href = $(el).attr('href');
      if (href) abhilinksUrl = href;
    });

    return abhilinksUrl;
  }

  async extractDownloadLinks(ctx, abhilinksUrl, title, tmdbId) {
    let html;
    try {
      html = await this.fetcher.text(ctx, new URL(abhilinksUrl), {
        headers: { Referer: BASE_URL + '/' },
      });
    } catch { return []; }

    const $ = cheerio.load(html);
    const results = [];

    // Parse the structure: headings (quality/size) followed by download links
    // Headings like: "720p [1.5GB]", "1080p [4GB]", "480p [400MB]"
    // Links: <a href="hubcloud.cx/drive/...">HUBCLOUD [DD]</a>

    const headings = $('h1, h2, h3, h4, h5, h6').toArray();

    for (const heading of headings) {
      const headingText = $(heading).text().trim();
      if (!headingText) continue;

      // Extract quality and size from the heading
      const qualityMatch = headingText.match(/(\d{3,4})p/i);
      const sizeMatch = headingText.match(/([\d.]+)\s*(GB|MB)/i);
      const height = qualityMatch ? parseInt(qualityMatch[1]) : undefined;
      const fileSize = sizeMatch ? bytes.parse(`${sizeMatch[1]} ${sizeMatch[2]}`) : undefined;

      // Skip headings that don't have quality info (section headers like "BluRay Multi Audio")
      if (!height && !fileSize) continue;

      // Find hubcloud links after this heading (until the next heading)
      const links = [];
      $(heading).nextUntil('h1, h2, h3, h4, h5, h6').each((_j, sib) => {
        $(sib).find('a').each((_k, a) => {
          const href = $(a).attr('href');
          const linkText = $(a).text().trim();
          if (href && /hubcloud/i.test(href)) {
            if (!links.find(l => l.href === href)) {
              links.push({ href, text: linkText });
            }
          }
        });
      });

      // If no links found after heading, check if the heading itself contains a link
      if (links.length === 0) {
        $(heading).find('a').each((_j, a) => {
          const href = $(a).attr('href');
          if (href && /hubcloud/i.test(href)) {
            links.push({ href, text: $(a).text().trim() });
          }
        });
      }

      // Add each hubcloud link as a stream
      for (const link of links) {
        try {
          const url = new URL(link.href);
          const countryCodes = [CountryCode.multi, ...findCountryCodes(headingText)];

          // Build the stream title with quality and size
          const titleBits = [title];
          if (height) titleBits.push(`${height}p`);
          if (fileSize) titleBits.push(`[${bytes.format(fileSize)}]`);
          const streamTitle = titleBits.join(' — ');

          results.push({
            url,
            meta: {
              countryCodes,
              ...(height && { height }),
              ...(fileSize && { bytes: fileSize }),
              title: streamTitle,
              sourceId: this.id,
              sourceLabel: this.label,
            },
          });
        } catch { /* skip invalid URL */ }
      }
    }

    return results;
  }
}
