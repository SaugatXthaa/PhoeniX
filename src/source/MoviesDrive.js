// src/source/MoviesDrive.js
// new1.moviesdrive.christmas — movies/series with HubCloud links
// Search: /?s={query} → post page → mdrive.lol/archive/{id} → hubcloud.cx/drive/{id}
// The HubCloud links are resolved by the HubExtractor to direct CDN URLs.

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId, findCountryCodes, findHeight } from '../utils/index.js';
import { HUB_HOST_PATTERN } from '../utils/hub.js';
import { Source } from './Source.js';

export class MoviesDrive extends Source {
  constructor(fetcher) {
    super();
    this.id = 'moviesdrive';
    this.label = 'MoviesDrive';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://new1.moviesdrive.christmas';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    // Search for the title
    const postUrls = await this.searchPosts(ctx, name, year);
    if (postUrls.length === 0) return [];

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);
    const results = [];

    // Fetch each post page and find mdrive.lol archive links
    for (const postUrl of postUrls.slice(0, 5)) {
      try {
        const postHtml = await this.fetcher.text(ctx, new URL(postUrl));
        const $post = cheerio.load(postHtml);

        // Find mdrive.lol archive links
        const archiveLinks = [];
        $post('a[href*="mdrive.lol/archive"]').each((_i, el) => {
          const href = $post(el).attr('href');
          const text = $post(el).text().trim();
          if (href && !archiveLinks.find(a => a.url === href)) {
            archiveLinks.push({ url: href, label: text });
          }
        });

        // For each archive link, fetch it and extract hubcloud links
        for (const archive of archiveLinks) {
          try {
            const archHtml = await this.fetcher.text(ctx, new URL(archive.url));
            const $arch = cheerio.load(archHtml);

            // Extract all h5 elements that contain EP{N} labels followed by hubcloud links
            const entries = [];
            const h5s = $arch('h5').toArray();

            for (let i = 0; i < h5s.length; i++) {
              const h5Text = $arch(h5s[i]).text().trim();
              
              // Check if this h5 has an EP label (e.g. "EP01 – 1080p [1.3GB]")
              const epMatch = h5Text.match(/EP\s*0*(\d+)/i);
              const qualityMatch = h5Text.match(/(\d{3,})p/i);
              const sizeMatch = h5Text.match(/([\d.]+)\s*(GB|MB)/i);
              
              // Check if next h5 has a hubcloud link
              const nextH5 = h5s[i + 1];
              if (nextH5) {
                const link = $arch(nextH5).find('a[href*="hubcloud"]').attr('href');
                if (link) {
                  entries.push({
                    episode: epMatch ? parseInt(epMatch[1]) : null,
                    quality: qualityMatch ? qualityMatch[1] + 'p' : null,
                    size: sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : null,
                    url: link,
                  });
                }
              }
            }

            // Also check for standalone hubcloud links (movies without episodes)
            if (entries.length === 0) {
              $arch('a[href*="hubcloud"]').each((_i, el) => {
                const href = $arch(el).attr('href');
                if (href && HUB_HOST_PATTERN.test(href)) {
                  // Walk up to find quality/size context
                  const parent = $arch(el).closest('h5, h4, p, div');
                  const context = parent.text().trim();
                  const qualityMatch = context.match(/(\d{3,})p/i);
                  const sizeMatch = context.match(/([\d.]+)\s*(GB|MB)/i);
                  entries.push({
                    episode: null,
                    quality: qualityMatch ? qualityMatch[1] + 'p' : null,
                    size: sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : null,
                    url: href,
                  });
                }
              });
            }

            // Filter by requested episode for series
            for (const entry of entries) {
              if (tmdbId.season) {
                const reqEp = tmdbId.episode || 1;
                if (entry.episode && entry.episode !== reqEp) continue;
              }

              // Build meta
              const entryTitle = archive.label || title;
              const countryCodes = [CountryCode.multi, ...findCountryCodes(entryTitle)];
              const height = entry.quality ? parseInt(entry.quality) : findHeight(entryTitle);

              let fileSize = undefined;
              if (entry.size) {
                const sm = entry.size.match(/([\d.]+)\s*(GB|MB)/i);
                if (sm) {
                  const val = parseFloat(sm[1]);
                  const unit = sm[2].toUpperCase();
                  fileSize = unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
                }
              }

              results.push({
                url: new URL(entry.url),
                meta: {
                  countryCodes,
                  ...(height && { height }),
                  title: entryTitle,
                  ...(fileSize && { bytes: fileSize }),
                },
              });
            }
          } catch { /* skip failed archive page */ }
        }
      } catch { /* skip failed post page */ }
    }

    return results;
  }

  async searchPosts(ctx, name, year) {
    // Use WordPress REST API (regular search form doesn't work on this site)
    const queries = [
      name,
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
      name.split(' ')[0], // first word only
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    const postUrls = [];
    for (const query of queries) {
      const apiUrl = new URL(`/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=10`, this.baseUrl);
      try {
        const posts = await this.fetcher.json(ctx, apiUrl, { timeout: 10000 });
        if (Array.isArray(posts)) {
          for (const post of posts) {
            const link = post.link;
            const title = (post.title?.rendered || '').toLowerCase();
            const nameLower = name.toLowerCase();
            // Match by title containing the search name
            if (link && (title.includes(nameLower) || nameLower.includes(title.split(' season')[0]) || title.length > 5)) {
              if (!postUrls.includes(link)) postUrls.push(link);
            }
          }
        }
        if (postUrls.length > 0) break;
      } catch { /* continue to next query */ }
    }

    return postUrls;
  }
}
