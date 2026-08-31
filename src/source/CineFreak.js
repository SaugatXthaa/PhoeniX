// src/source/CineFreak.js
// cinefreak.net — movies/series/anime/kdrama with direct r2.dev MKV streams
//
// Flow:
//   1. Search: GET /?s={title} → parse a.movie-card links
//   2. Detail page → find a.dlbtn[href*="generate.php?id={base64}"] links
//   3. Decode base64 → get cinecloud.site URL (e.g. /x/{fileid})
//   4. Fetch cinecloud page → extract iframe src (player.yagaverse.net/embed2/?id={url-encoded-r2-url})
//   5. Double URL-decode the id param → direct r2.dev MKV URL
//
// The r2.dev URLs are directly streamable (HTTP 200, Range 206, no auth needed).
// Quality info is in the h4 preceding each dlbtn-container.

import * as cheerio from 'cheerio';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://cinefreak.net';
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

export class CineFreak extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinefreak';
    this.label = 'CineFreak';
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

    // Step 1: Search
    const detailUrl = await this.findDetailPage(name, year, tmdbId);
    if (!detailUrl) return [];

    // Step 2: Get generate.php links from detail page
    const dlLinks = await this.findDownloadLinks(detailUrl);
    if (dlLinks.length === 0) return [];

    // Step 3+4+5: For each link, decode base64 → cinecloud → r2.dev URL
    const results = [];
    const seenUrls = new Set();

    for (const dl of dlLinks.slice(0, 8)) {
      try {
        const streamUrl = await this.resolveStreamUrl(dl.href);
        if (!streamUrl) continue;
        if (seenUrls.has(streamUrl)) continue;
        seenUrls.add(streamUrl);

        const parsed = new URL(streamUrl);
        results.push({
          url: parsed,
          format: Format.mp4, // MKV plays as MP4 in Stremio
          meta: {
            countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
            title: `${title} (${dl.quality})`,
            sourceId: this.id,
            sourceLabel: this.label,
            ...(dl.height && { height: dl.height }),
            ...(dl.bytes && { bytes: dl.bytes }),
            ...(dl.codec && { codec: dl.codec }),
          },
        });
      } catch { /* skip failed link */ }
    }

    return results;
  }

  async findDetailPage(name, year, tmdbId) {
    const nameNorm = normalize(name);
    const queries = [
      name,
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
      name.split(' ').slice(0, 3).join(' '),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    for (const query of queries) {
      const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
      const html = await fetchPage(searchUrl);
      if (!html) continue;

      const $ = cheerio.load(html);
      let bestMatch = null;
      let bestScore = 0;
      const nameWords = new Set(nameNorm.split(' ').filter(w => w.length > 2));

      $('a').each((_, el) => {
        const href = $(el).attr('href');
        if (!href || !href.includes('cinefreak.net/') || href.includes('?s=') || href.includes('/page/')) return;
        // Skip category/navigation links
        if (href.match(/\/(web-series|animation|bangla|chinese|dual|english|hindi|japanese|k-drama|korean|kannada|telugu|tamil|malayalam|indonesian|others|spanish|category|horror|action|comedy|romance|thriller|drama|sci-fi|adventure|crime|mystery|fantasy|family|war|history|music|sport|western|musical|documentary)\/?$/)) return;

        const cardTitle = ($(el).attr('aria-label') || $(el).find('.movie-card-title, .entry-title, h2, h3').text() || $(el).text() || '').trim().replace(/\s+/g, ' ');
        const tNorm = normalize(cardTitle);
        if (!tNorm || tNorm.length < 3) return;

        let score = 0;
        if (tNorm === nameNorm) score = 100;
        else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
          score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
        }

        // Word-overlap scoring
        if (score < 30 && nameWords.size >= 2) {
          const titleWords = new Set(tNorm.split(' ').filter(w => w.length > 2));
          const common = [...nameWords].filter(w => titleWords.has(w));
          const coverage = common.length / nameWords.size;
          if (coverage >= 0.6) {
            score = coverage * 80;
          }
        }

        // Year bonus
        if (score > 0 && year && cardTitle.includes(String(year))) score += 10;

        if (score > bestScore) {
          bestScore = score;
          bestMatch = href;
        }
      });

      if (bestMatch && bestScore >= 30) return bestMatch;
    }

    // Fallback: try direct URL pattern
    // cinefreak.net uses slug format: /title-year-full-movie-download/
    // or /title-year-full-movie-download-season-s/
    if (year) {
      const slug = name.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      const movieSlug = `${slug}-${year}-full-movie-download`;
      const directUrl = `${BASE_URL}/${movieSlug}/`;
      const html = await fetchPage(directUrl);
      if (html && html.includes('generate.php')) {
        console.log(`[CineFreak] Direct URL hit: ${directUrl}`);
        return directUrl;
      }
    }

    return null;
  }

  async findDownloadLinks(detailUrl) {
    const html = await fetchPage(detailUrl);
    if (!html) return [];

    const $ = cheerio.load(html);
    const links = [];

    $('a.dlbtn').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || !href.includes('generate.php')) return;

      // Skip "watch" duplicates — prefer "download" links
      const isDownload = $(el).hasClass('dlbtn-download');
      if (!isDownload) return;

      // Find quality + file size from nearby h4
      let quality = 'HD';
      let height = undefined;
      let bytes = undefined;
      let codec = undefined;
      const $container = $(el).closest('.dlbtn-container');
      if ($container.length) {
        const h4Text = $container.prev('h4.movie-title').text().trim() ||
                       $container.find('h4').text().trim();
        if (h4Text) {
          // Match resolution: 4K/2160p, 1080p, 720p, 480p, 360p
          if (/4k|2160p/i.test(h4Text)) { quality = '4K'; height = 2160; }
          else if (/1080p/i.test(h4Text)) { quality = '1080p'; height = 1080; }
          else if (/720p/i.test(h4Text)) { quality = '720p'; height = 720; }
          else if (/480p/i.test(h4Text)) { quality = '480p'; height = 480; }
          else if (/360p/i.test(h4Text)) { quality = '360p'; height = 360; }
          else {
            const resMatch = h4Text.match(/(\d{3,4})p/i);
            if (resMatch) { quality = `${resMatch[1]}p`; height = parseInt(resMatch[1]); }
          }

          // Extract codec info (HEVC, x265, x264, AVC)
          if (/hevc|x265/i.test(h4Text)) codec = 'HEVC';
          else if (/x264|avc/i.test(h4Text)) codec = 'AVC';

          // Extract file size: [6.7 GB], [900 MB], [410 MB]
          const sizeMatch = h4Text.match(/\[\s*([\d.]+)\s*(GB|MB)\s*\]/i);
          if (sizeMatch) {
            const val = parseFloat(sizeMatch[1]);
            bytes = sizeMatch[2].toUpperCase() === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
          }
        }
      }

      links.push({ quality, href, height, bytes, codec });
    });

    return links;
  }

  async resolveStreamUrl(generateUrl) {
    // Extract and decode the base64 id from generate.php?id={base64}
    const b64Match = generateUrl.match(/id=([^&]+)/);
    if (!b64Match) return null;

    let decoded;
    try {
      decoded = Buffer.from(b64Match[1], 'base64').toString('utf8');
    } catch { return null; }

    // decoded = https://new5.cinecloud.site/f/{fileid}newgo32
    // Convert to /x/{fileid} (embed page)
    const cinecloudUrl = decoded.replace('newgo32', '').replace('/f/', '/x/');
    if (!cinecloudUrl.includes('cinecloud.site')) return null;

    // Fetch cinecloud page
    const html = await fetchPage(cinecloudUrl);
    if (!html) return null;

    // Extract iframe src
    const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"/);
    if (!iframeMatch) return null;

    // Decode the id param (double URL-encoded r2.dev URL)
    const idMatch = iframeMatch[1].match(/id=([^&]+)/);
    if (!idMatch) return null;

    let streamUrl;
    try {
      streamUrl = decodeURIComponent(decodeURIComponent(idMatch[1]));
    } catch {
      try { streamUrl = decodeURIComponent(idMatch[1]); } catch { return null; }
    }

    // Verify it's a valid URL
    try {
      new URL(streamUrl);
      return streamUrl;
    } catch { return null; }
  }
}
