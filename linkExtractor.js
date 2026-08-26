/**
 * PhoeniX - Link Extractor (Host Resolver)
 * linkExtractor.js
 *
 * Resolves hidden direct stream URLs from intermediary file-host pages
 * (HubCloud, GDToot, GDrive.xyz, Fastream, DoodStream, etc.).
 *
 * These hosts embed the actual video URL inside obfuscated JavaScript
 * variables. This module fetches the host page and extracts the real
 * playable URL using regex patterns.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('./logger');
const utils = require('./utils');

/**
 * Known file-host patterns and their extraction regexes.
 * Each entry defines how to find the direct URL in the host page HTML.
 */
const HOST_EXTRACTORS = [
  {
    name: 'HubCloud',
    match: /hubcloud\.|hubdrive/i,
    patterns: [
      /var\s+url\s*=\s*['"](https?:\/\/[^'"]+)/i,
      /['"](https?:\/\/[^'"]*\.(?:mp4|m3u8|mkv)[^'"]*)['"]/i,
      /file\s*:\s*['"](https?:\/\/[^'"]+)/i,
      /source\s*:\s*['"](https?:\/\/[^'"]+)/i,
    ],
  },
  {
    name: 'GDTot',
    match: /gdtoot|gdtot/i,
    patterns: [
      /var\s+url\s*=\s*['"](https?:\/\/[^'"]+)/i,
      /['"](https?:\/\/drive\.google\.com\/[^'"]+)['"]/i,
      /['"](https?:\/\/[^'"]*\.googleusercontent\.com\/[^'"]+)['"]/i,
    ],
  },
  {
    name: 'GDrive',
    match: /gdrive\.xyz|gdtot|gdbot/i,
    patterns: [
      /['"](https?:\/\/drive\.google\.com\/uc\?[^'"]+)['"]/i,
      /['"](https?:\/\/[^'"]*\.googleusercontent\.com\/[^'"]+)['"]/i,
      /var\s+url\s*=\s*['"](https?:\/\/[^'"]+)/i,
    ],
  },
  {
    name: 'Fastream',
    match: /fastream/i,
    patterns: [
      /['"](https?:\/\/[^'"]*fastream[^'"]*\.(?:mp4|m3u8)[^'"]*)['"]/i,
      /file\s*:\s*['"](https?:\/\/[^'"]+)/i,
      /source\s*:\s*['"](https?:\/\/[^'"]+)/i,
    ],
  },
  {
    name: 'DoodStream',
    match: /doodstream|dood\.so|dood\.ws/i,
    patterns: [
      /['"](https?:\/\/[^'"]*dood[^'"]*\.mp4[^'"]*)['"]/i,
      /pass_md5\s*=\s*['"]([^'"]+)['"]/i,
    ],
  },
  {
    name: 'Generic',
    match: /.*/, // fallback for unknown hosts
    patterns: [
      /var\s+url\s*=\s*['"](https?:\/\/[^'"]+)/i,
      /file\s*:\s*['"](https?:\/\/[^'"]+)['"]/i,
      /source\s*:\s*['"](https?:\/\/[^'"]+)['"]/i,
      /['"](https?:\/\/[^'"]*\.(?:mp4|m3u8|mkv|webm)[^'"]*)['"]/i,
    ],
  },
];

/**
 * Resolve a locker/host URL to a direct playable stream URL.
 *
 * @param {string} lockerUrl - URL from a DDL blog (HubCloud, GDToot, etc.)
 * @param {Object} opts - { headers, httpsAgent, timeout }
 * @returns {Promise<{url, host, quality}|null>}
 */
async function resolveLockerUrl(lockerUrl, opts = {}) {
  if (!lockerUrl) return null;

  const headers = opts.headers || utils.buildBrowserHeaders(
    lockerUrl.match(/https?:\/\/([^/]+)/)?.[1] || 'example.com'
  );

  try {
    const res = await axios.get(lockerUrl, {
      timeout: opts.timeout || 10000,
      headers,
      httpsAgent: opts.httpsAgent,
      proxy: false,
      maxRedirects: 5,
      validateStatus: (s) => s < 500,
    });

    if (res.status !== 200) return null;

    const html = typeof res.data === 'string' ? res.data : String(res.data);

    // Find the matching extractor for this host
    const extractor = HOST_EXTRACTORS.find(
      (e) => e.match && e.match.test(lockerUrl)
    ) || HOST_EXTRACTORS[HOST_EXTRACTORS.length - 1]; // Generic fallback

    // Try each regex pattern
    for (const pattern of extractor.patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const directUrl = match[1];
        if (utils.isPlayableUrl(directUrl)) {
          logger.info(
            `[LinkExtractor] ${extractor.name}: ${lockerUrl.substring(0, 60)} -> ${directUrl.substring(0, 80)}`
          );
          return {
            url: directUrl,
            host: extractor.name,
            quality: utils.detectQuality(html) || utils.detectQuality(directUrl),
          };
        }
      }
    }

    // Fallback: look for any direct video URL in the page
    const urlRegex = /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm)(?:\?[^\s"'<>()]*)?/gi;
    const directUrls = [...new Set(html.match(urlRegex) || [])];
    if (directUrls.length > 0) {
      const url = directUrls[0];
      logger.info(
        `[LinkExtractor] Generic: ${lockerUrl.substring(0, 60)} -> ${url.substring(0, 80)}`
      );
      return {
        url,
        host: 'Generic',
        quality: utils.detectQuality(html) || utils.detectQuality(url),
      };
    }

    return null;
  } catch (err) {
    logger.debug(`[LinkExtractor] failed for ${lockerUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Resolve multiple locker URLs in parallel (with concurrency limit).
 *
 * @param {Array<string>} lockerUrls
 * @param {Object} opts
 * @param {number} concurrency - max parallel (default: 3)
 * @returns {Promise<Array<{url, host, quality}>>}
 */
async function resolveLockerUrls(lockerUrls, opts = {}, concurrency = 3) {
  if (!lockerUrls || !lockerUrls.length) return [];

  const pLimit = require('p-limit').default || require('p-limit');
  const limit = pLimit(concurrency);

  const results = await Promise.all(
    lockerUrls.map((url) =>
      limit(async () => {
        const result = await resolveLockerUrl(url, opts);
        return result;
      })
    )
  );

  return results.filter(Boolean);
}

/**
 * Extract locker links from a DDL blog post page.
 * Looks for links pointing to known file hosts (HubCloud, GDToot, etc.).
 *
 * @param {string} html - post page HTML
 * @returns {Array<string>} - array of locker URLs
 */
function extractLockerLinks(html) {
  if (!html) return [];

  const $ = cheerio.load(html);
  const links = [];

  $('a').each((i, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    // Check if this link points to a known file host
    const isLocker =
      /hubcloud|hubdrive/i.test(href) ||
      /gdtoot|gdtot/i.test(href) ||
      /gdrive\.xyz|gdbot/i.test(href) ||
      /fastream/i.test(href) ||
      /doodstream|dood\.so|dood\.ws/i.test(href) ||
      /drive\.google\.com/i.test(href) ||
      /moviespie|earnlearn|extrafox|katlinks/i.test(href) ||
      /bifrost|linksad|filepress/i.test(href);

    if (isLocker) {
      links.push(href);
    }
  });

  // Also look for URLs in the raw HTML (not just <a> tags)
  const urlRegex = /https?:\/\/[^\s"'<>()]*(?:hubcloud|gdtoot|gdrive\.xyz|fastream|doodstream|drive\.google\.com)[^\s"'<>()]*/gi;
  const rawUrls = html.match(urlRegex) || [];
  links.push(...rawUrls);

  return [...new Set(links)];
}

/**
 * Check if a URL supports HTTP Range requests (seekable).
 * Makes a HEAD request and checks for Accept-Ranges: bytes.
 *
 * @param {string} url
 * @param {Object} opts
 * @returns {Promise<{seekable: boolean, contentType: string, contentLength: number}>}
 */
async function checkSeekability(url, opts = {}) {
  const headers = opts.headers || utils.buildBrowserHeaders(
    url.match(/https?:\/\/([^/]+)/)?.[1] || 'example.com'
  );

  try {
    const res = await axios.head(url, {
      timeout: 5000,
      headers,
      httpsAgent: opts.httpsAgent,
      proxy: false,
      maxRedirects: 5,
      validateStatus: (s) => s < 500,
    });

    const respHeaders = res.headers || {};
    const acceptRanges = (respHeaders['accept-ranges'] || '').toLowerCase();
    const contentType = (respHeaders['content-type'] || '').toLowerCase();
    const contentLength = parseInt(respHeaders['content-length'] || '0', 10) || 0;

    return {
      seekable: acceptRanges === 'bytes' || !!respHeaders['content-range'],
      contentType,
      contentLength,
    };
  } catch (err) {
    return { seekable: false, contentType: '', contentLength: 0 };
  }
}

module.exports = {
  resolveLockerUrl,
  resolveLockerUrls,
  extractLockerLinks,
  checkSeekability,
  HOST_EXTRACTORS,
};
