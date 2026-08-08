// src/source/HDHub4uNew.js
// new4.hdhub4u.cl — movies/series/anime/k-drama with HubDrive + HubCDN links
//
// Flow:
//   1. Search via Typesense API (search.pingora.fyi) — needs got-scraping
//      for Cloudflare bypass
//   2. Fetch post page → find hubdrive.tips/file/{id} and hubcdn.sbs/file/{id} links
//   3. For hubdrive.tips URLs: resolve via Sootio resolver
//      (sootio.forthewizards.uk/resolve/httpstreaming/{encoded-url})
//      which returns a 302 redirect to the direct CDN URL
//   4. For hubcdn.sbs URLs: pass through to HubExtractor (already handles them)
//
// The Sootio resolver pattern is the key — it resolves hubdrive.tips URLs
// server-side without needing to parse the hubdrive page HTML.
//
// Movies: direct hubdrive/hubcdn links on the post page
// Series: episode links go through greenmountmotors.com (encoded, not
//   resolvable server-side) — we skip those and only use direct hub links

import * as cheerio from 'cheerio';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId, findCountryCodes, findHeight } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://new4.hdhub4u.cl';
const TYPESENSE_API = 'https://search.pingora.fyi/collections/post/documents/search';
const SOOTIO_RESOLVER = 'https://sootio.forthewizards.uk/resolve/httpstreaming';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Normalize a string for fuzzy matching (& → space, HTML entities decoded)
const normalize = (s) => {
  return (s || '')
    .toLowerCase()
    .replace(/&#0*38;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&/g, ' ')
    .replace(/\band\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

// Parse quality + size from link text (e.g. "480p⚡[540MB]", "4K [2160p SDR HEVC – 7GB]")
const parseQualityAndSize = (text) => {
  const t = text || '';
  let quality = null;
  let height = undefined;

  // Quality: 4K/2160p or 1080p/720p/480p
  const q4kMatch = t.match(/4k|2160p/i);
  const qMatch = t.match(/(\d{3,4})p/i);
  if (q4kMatch) {
    quality = '2160p';
    height = 2160;
  } else if (qMatch) {
    quality = qMatch[1] + 'p';
    height = parseInt(qMatch[1]);
  }

  // Size: [540MB], [7GB], [1.4GB]
  const sizeMatch = t.match(/([\d.]+)\s*(GB|MB)/i);
  let fileSize = undefined;
  if (sizeMatch) {
    const val = parseFloat(sizeMatch[1]);
    const unit = sizeMatch[2].toUpperCase();
    fileSize = unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
  }

  return { quality, height, fileSize };
};

export class HDHub4uNew extends Source {
  constructor(fetcher) {
    super();
    this.id = 'hdhub4unew';
    this.label = 'HDHub4uNew';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: search via Typesense API
    const postUrls = await this.searchPosts(ctx, name, year);
    if (postUrls.length === 0) return [];

    const results = [];

    // Step 2: fetch each post page and find hubdrive/hubcdn links
    for (const postUrl of postUrls.slice(0, 3)) {
      try {
        const postHtml = await this.fetchPage(ctx, postUrl);
        if (!postHtml) continue;
        const $post = cheerio.load(postHtml);

        // Find hubdrive.tips and hubcdn.sbs links
        const hubLinks = [];
        $post('a[href*="hubdrive.tips"], a[href*="hubcdn.sbs"]').each((_i, el) => {
          const href = $post(el).attr('href');
          const text = $post(el).text().trim();
          if (href && !hubLinks.find(l => l.url === href)) {
            hubLinks.push({ url: href, label: text });
          }
        });

        // Process each hub link
        for (const link of hubLinks) {
          const { quality, height, fileSize } = parseQualityAndSize(link.label);
          const countryCodes = [CountryCode.multi, ...findCountryCodes(link.label)];

          // For hubdrive.tips URLs: resolve via Sootio
          if (link.url.includes('hubdrive.tips')) {
            try {
              const encodedUrl = encodeURIComponent(link.url);
              const sootioUrl = `${SOOTIO_RESOLVER}/${encodedUrl}`;

              // Fetch with got-scraping (Sootio returns 302 redirect)
              const { gotScraping } = await import('got-scraping');
              const resp = await gotScraping.get(sootioUrl, {
                headers: { 'User-Agent': UA },
                timeout: { request: 10000 },
                throwHttpErrors: false,
                followRedirect: false,
              });

              // Sootio returns 302 with Location header pointing to direct CDN URL
              if (resp.statusCode === 302 && resp.headers.location) {
                const cdnUrl = new URL(resp.headers.location);
                results.push({
                  url: cdnUrl,
                  format: Format.mp4,
                  meta: {
                    countryCodes,
                    ...(height && { height }),
                    title: `${title} (${quality || link.label.slice(0, 20)})`,
                    ...(fileSize && { bytes: fileSize }),
                    sourceId: this.id,
                    sourceLabel: this.label,
                  },
                });
              } else if (resp.statusCode === 200) {
                // Some URLs return 200 with the CDN URL in the body
                const bodyUrl = resp.body.match(/https?:\/\/[^\s"'<>]+/);
                if (bodyUrl) {
                  const cdnUrl = new URL(bodyUrl[0]);
                  results.push({
                    url: cdnUrl,
                    format: Format.mp4,
                    meta: {
                      countryCodes,
                      ...(height && { height }),
                      title: `${title} (${quality || link.label.slice(0, 20)})`,
                      ...(fileSize && { bytes: fileSize }),
                      sourceId: this.id,
                      sourceLabel: this.label,
                    },
                  });
                }
              }
            } catch { /* Sootio resolve failed — skip */ }
          }
          // For hubcdn.sbs URLs: pass through to HubExtractor
          else if (link.url.includes('hubcdn.sbs')) {
            try {
              const parsed = new URL(link.url);
              results.push({
                url: parsed,
                format: Format.mp4,
                meta: {
                  countryCodes,
                  ...(height && { height }),
                  title: `${title} (${quality || link.label.slice(0, 20)})`,
                  ...(fileSize && { bytes: fileSize }),
                  sourceId: this.id,
                  sourceLabel: this.label,
                },
              });
            } catch { /* invalid URL */ }
          }
        }

        // For series: find episode links matching the requested season/episode
        if (tmdbId.season && results.length === 0) {
          // Series pages have episode links — but they go through
          // greenmountmotors.com which uses encoded IDs that don't resolve
          // server-side. Skip series for now unless we find direct hub links.
        }
      } catch { /* skip failed post page */ }
    }

    return results;
  }

  // Fetch a page using got-scraping (for Cloudflare bypass)
  async fetchPage(ctx, url) {
    try {
      const { gotScraping } = await import('got-scraping');
      const res = await gotScraping.get(url, {
        headers: {
          'User-Agent': UA,
          'Referer': BASE_URL + '/',
          'Accept': 'text/html,application/xhtml+xml',
        },
        timeout: { request: 10000 },
        throwHttpErrors: false,
      });
      return res.statusCode === 200 ? res.body : null;
    } catch {
      return null;
    }
  }

  // Search via Typesense API
  async searchPosts(ctx, name, year) {
    const nameNormalized = normalize(name);
    const postUrls = [];

    try {
      const { gotScraping } = await import('got-scraping');
      const apiUrl = new URL(TYPESENSE_API);
      apiUrl.searchParams.set('q', name);
      apiUrl.searchParams.set('query_by', 'post_title,category,stars,director,imdb_id');
      apiUrl.searchParams.set('query_by_weights', '4,2,2,2,4');
      apiUrl.searchParams.set('sort_by', 'sort_by_date:desc');
      apiUrl.searchParams.set('limit', '10');
      apiUrl.searchParams.set('highlight_fields', 'none');
      apiUrl.searchParams.set('use_cache', 'true');
      apiUrl.searchParams.set('page', '1');

      const res = await gotScraping.get(apiUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Referer': BASE_URL + '/',
        },
        timeout: { request: 10000 },
        throwHttpErrors: false,
      });

      if (res.statusCode !== 200) return [];

      const data = JSON.parse(res.body);
      if (!data.hits || !Array.isArray(data.hits)) return [];

      for (const hit of data.hits) {
        const doc = hit.document;
        if (!doc?.permalink) continue;

        // Normalize post title for matching
        const titleNormalized = normalize(doc.post_title);
        // Strict matching: post title must contain the movie/series name
        if (!titleNormalized.includes(nameNormalized)) continue;

        // Build full URL
        const fullUrl = doc.permalink.startsWith('http')
          ? doc.permalink
          : new URL(doc.permalink, BASE_URL).href;

        if (!postUrls.includes(fullUrl)) postUrls.push(fullUrl);
      }
    } catch { /* search failed */ }

    return postUrls;
  }
}
