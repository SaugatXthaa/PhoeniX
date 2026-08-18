// src/source/MoviesHunt.js
// movieshunt.casa — movies, series, anime, K-drama with HubCloud + GDFlix links
// (Site moved from movieshunt.work → movieshunt.casa. The .work domain 301-redirects
// to .casa, but the redirect breaks the BASE_URL-based href matching below because
// the returned HTML contains movieshunt.casa links, not movieshunt.work links.)
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

const BASE_URL = 'https://movieshunt.casa';

// Check if a URL is a download link (hubcloud, gdflix, vcloud.fit, gdtot.dad).
// Also matches href.li/? redirects that wrap these hosts.
// The HUB_HOST_PATTERN covers hubcdn|hubcloud|hubdrive|gdflix, but MoviesHunt's
// abhilinks pages also use vcloud.fit and gdtot.dad (handled by DirectStream).
function isDownloadLink(href) {
  if (!href) return false;
  const lower = href.toLowerCase();
  // href.li wraps the real URL as a query param: https://href.li/?https://vcloud.fit/...
  if (lower.includes('href.li/?')) return true;
  // Direct hubcloud / gdflix / vcloud.fit / gdtot.dad links
  if (/hubcloud|hubdrive|hubcdn|gdflix/.test(lower)) return true;
  if (/vcloud\.fit|gdtot\.dad/.test(lower)) return true;
  return false;
}

// Unwrap href.li/? redirects to get the real download URL.
// href.li format: https://href.li/?https://vcloud.fit/abc123
// The real URL is everything after "href.li/?".
function unwrapHrefLi(url) {
  const lower = url.toLowerCase();
  if (!lower.includes('href.li/?')) return url;
  const idx = lower.indexOf('href.li/?');
  const realUrl = url.substring(idx + 'href.li/?'.length);
  return realUrl.startsWith('http') ? realUrl : url;
}

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
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    for (const query of queries) {
      try {
        // Use HTML search (?s=) — the WP REST API search is broken on this site
        // (returns the same post for every query)
        const searchUrl = new URL(`/?s=${encodeURIComponent(query)}`, BASE_URL);
        const html = await this.fetcher.text(ctx, searchUrl, {
          headers: { Accept: 'text/html' },
          timeout: 10000,
        });

        const $ = cheerio.load(html);
        const nameLower = name.toLowerCase();
        const yearStr = String(year);
        const nameWords = nameLower.split(/\s+/).filter(w => w.length > 2);
        const firstWords = nameWords.slice(0, Math.min(3, nameWords.length)).join(' ');

        // Find post links (exclude non-post URLs)
        const postLinks = [];
        $('a[href*="' + BASE_URL + '/"]').each((_i, el) => {
          const href = $(el).attr('href');
          if (!href) return;
          // Exclude non-post URLs
          if (href.includes('category/') || href.includes('page/') || href.includes('wp-') ||
              href.includes('?s=') || href.includes('how-to') || href.includes('about') ||
              href.includes('contact') || href.includes('dmca') || href.includes('privacy') ||
              href.includes('feed/') || href.includes('xmlrpc') || href.includes('/tag/') ||
              href.includes('/search/')) return;
          if (!postLinks.includes(href)) postLinks.push(href);
        });

        // Try to find a matching post by title + year
        for (const link of postLinks) {
          // Get the link text or nearby title
          const linkEl = $(`a[href="${link}"]`).first();
          const linkText = linkEl.text().toLowerCase().trim();
          const titleAttr = (linkEl.attr('title') || '').toLowerCase();
          const altAttr = (linkEl.find('img').attr('alt') || '').toLowerCase();
          const linkLower = link.toLowerCase();

          // Match by full name in link text, title attr, alt attr, OR the URL itself.
          // The URL often contains the title slug (e.g. /inception-2010-bluray-/)
          // even when the alt text is in Hindi or missing.
          if (linkText.includes(nameLower) || titleAttr.includes(nameLower) ||
              altAttr.includes(nameLower) || linkLower.includes(nameLower)) {
            // Year matching: the post URL must contain the release year.
            // Use the URL specifically (not alt text) because alt text doesn't
            // contain the year. This prevents matching sequel/spinoff posts
            // (e.g. "The Dark Knight" 2008 should NOT match "The Dark Knight
            // Returns" 2012 or "The Dark Knight Rises" 2012).
            if (yearStr && yearStr !== 'NaN' && yearStr !== 'undefined') {
              if (!linkLower.includes(yearStr)) continue;
            }
            return link;
          }
        }

        // Try partial word match
        if (firstWords.length > 3) {
          for (const link of postLinks) {
            const linkEl = $(`a[href="${link}"]`).first();
            const linkText = linkEl.text().toLowerCase().trim();
            const titleAttr = (linkEl.attr('title') || '').toLowerCase();
            if (linkText.includes(firstWords) || titleAttr.includes(firstWords)) {
              return link;
            }
          }
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
    // Find download redirect links — MoviesHunt uses multiple redirectors:
    //   - abhilinks.site (older posts)
    //   - links.modlinkz.xyz (newer posts)
    // Both redirect to the actual download page with quality/size headings.
    const redirectorPattern = /abhilinks\.site|links\.modlinkz\.xyz/i;
    let redirectorUrl = null;
    $('a[href*="abhilinks"], a[href*="modlinkz"]').each((_i, el) => {
      if (redirectorUrl) return;
      const href = $(el).attr('href');
      if (href && redirectorPattern.test(href)) {
        redirectorUrl = href;
      }
    });

    return redirectorUrl;
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

    // For TV series: the abhilinks page has episode headings like "-:Episodes: 1:-"
    // followed by quality+size headings like "1080p [1.5GB]" with hubcloud links.
    // We need to find the episode matching the requested episode number, then
    // extract all quality links under that episode heading.
    const targetEpisode = tmdbId.season ? (tmdbId.episode || 1) : null;

    // Parse all headings and their associated links
    const headings = $('h1, h2, h3, h4, h5, h6').toArray();

    // First pass: check if this is an episode-based page (has "Episodes: N" headings)
    const hasEpisodeHeadings = headings.some(h => {
      const text = $(h).text().trim();
      return /episodes?\s*[:\-]?\s*\d+/i.test(text);
    });

    let currentEpisode = null;

    for (const heading of headings) {
      const headingText = $(heading).text().trim();
      if (!headingText) continue;

      // Check if this is an episode heading (e.g. "-:Episodes: 1:-")
      const epMatch = headingText.match(/episodes?\s*[:\-]?\s*(\d+)/i);
      if (epMatch) {
        currentEpisode = parseInt(epMatch[1]);

        // If this is the target episode, collect links directly after this heading
        if (hasEpisodeHeadings && targetEpisode !== null && currentEpisode === targetEpisode) {
          const links = [];
          $(heading).nextUntil('h1, h2, h3, h4, h5, h6').each((_j, sib) => {
            $(sib).find('a').each((_k, a) => {
              const href = $(a).attr('href');
              const linkText = $(a).text().trim();
              if (href && isDownloadLink(href) && !links.find(l => l.href === href)) {
                links.push({ href, text: linkText });
              }
            });
          });

          for (const link of links) {
            try {
              const url = new URL(unwrapHrefLi(link.href));
              results.push({
                url,
                meta: {
                  countryCodes: [CountryCode.multi],
                  title: `${title} — EP${targetEpisode}`,
                  sourceId: this.id,
                  sourceLabel: this.label,
                },
              });
            } catch { /* skip invalid URL */ }
          }
        }
        continue;
      }

      // Extract quality and size from the heading
      const qualityMatch = headingText.match(/(\d{3,4})p/i);
      const sizeMatch = headingText.match(/([\d.]+)\s*(GB|MB)/i);
      const height = qualityMatch ? parseInt(qualityMatch[1]) : undefined;
      const fileSize = sizeMatch ? bytes.parse(`${sizeMatch[1]} ${sizeMatch[2]}`) : undefined;

      // Skip headings that don't have quality info
      if (!height && !fileSize) continue;

      // If this is an episode-based page, only include links for the requested episode
      if (hasEpisodeHeadings && targetEpisode !== null) {
        if (currentEpisode !== targetEpisode) continue;
      }

      // Find download links after this heading (until the next heading).
      // Links may be:
      //   - Direct hubcloud.cx/drive/{id} URLs
      //   - href.li/?https://vcloud.fit/... redirects (href.li wraps the real URL)
      //   - Direct vcloud.fit / gdtot.dad URLs (handled by DirectStream extractor)
      const links = [];
      $(heading).nextUntil('h1, h2, h3, h4, h5, h6').each((_j, sib) => {
        $(sib).find('a').each((_k, a) => {
          const href = $(a).attr('href');
          const linkText = $(a).text().trim();
          if (href && isDownloadLink(href)) {
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
          const linkText = $(a).text().trim();
          if (href && isDownloadLink(href)) {
            links.push({ href, text: linkText });
          }
        });
      }

      // Add each download link as a stream
      for (const link of links) {
        try {
          const url = new URL(unwrapHrefLi(link.href));
          const countryCodes = [CountryCode.multi, ...findCountryCodes(headingText)];

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
