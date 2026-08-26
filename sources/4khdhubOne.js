/**
 * Source: 4KHDHub (4khdhub.one)
 *
 * 4K/UHD movie blog. Searches by title, finds matching post pages,
 * extracts direct video URLs via multi-step link unwrapping.
 *
 * Flow:
 *   1. Search /?s=title
 *   2. Find post URL matching the title
 *   3. Fetch post page
 *   4. Extract locker links (HubCloud, GDToot, GDrive, etc.)
 *   5. Resolve each locker URL to a direct .mp4/.m3u8 via linkExtractor
 *   6. Return playable streams with proxyHeaders
 */

const smartScraper = require('../smartScraper');
const linkExtractor = require('../linkExtractor');
const utils = require('../utils');
const logger = require('../logger');
const cheerio = require('cheerio');

/** Wrapper that mimics http.get but uses smartScraper internally. */
const smartGet = async (url, opts = {}) => {
  const result = await smartScraper.smartFetch(url, opts);
  if (result && result.status === 200 && result.body) {
    return { status: 200, data: result.body };
  }
  return { status: 0, data: '' };
};

const SOURCE_TAG = '4KHDHub.one';
const BASE = 'https://4khdhub.one';

/** Normalize input to a context object. */
function normalizeContext(input) {
  if (typeof input === 'string') {
    const parsed = utils.parseId(input);
    if (!parsed) return null;
    return {
      imdb: parsed.imdb,
      raw: input,
      title: null,
      year: null,
      type: parsed.isSeries ? 'series' : 'movie',
      season: parsed.season,
      episode: parsed.episode,
      isSeries: parsed.isSeries,
    };
  }
  return input;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "'");
}

/**
 * Search 4KHDHub for posts matching a title.
 * Returns array of {url, title}.
 */
async function searchPosts(query) {
  if (!query) return [];
  const searchUrl = `${BASE}/?s=${encodeURIComponent(query)}`;
  try {
    const res = await smartGet(searchUrl, { timeout: 15000 });
    const html = String(res.data || '');

    const posts = [];
    const seen = new Set();

    // 4KHDHub uses <a> wrapping a <div class="movie-card" aria-label="Title">
    // Pattern: <a href="URL">...<div class="movie-card" aria-label="TITLE">...
    const cardRegex = /<a[^>]+href="(https?:\/\/(?:www\.)?4khdhub\.one\/[^"]+)"[^>]*>[\s\S]{0,500}?<div[^>]*class="[^"]*movie-card[^"]*"[^>]*aria-label="([^"]+)"/gi;
    let m;
    while ((m = cardRegex.exec(html)) !== null) {
      const url = m[1];
      const title = decodeEntities(m[2]);
      if (isValidPostUrl(url) && !seen.has(url)) {
        seen.add(url);
        posts.push({ url, title });
      }
    }

    // Fallback: just look for aria-label links with valid post URLs
    if (posts.length === 0) {
      const ariaRegex = /<a[^>]+href="(https?:\/\/(?:www\.)?4khdhub\.one\/[^"]+)"[^>]*>[\s\S]{0,300}?aria-label="([^"]+)"/gi;
      while ((m = ariaRegex.exec(html)) !== null) {
        const url = m[1];
        const title = decodeEntities(m[2]);
        if (isValidPostUrl(url) && !seen.has(url)) {
          seen.add(url);
          posts.push({ url, title });
        }
      }
    }

    return posts;
  } catch (err) {
    logger.debug(`[${SOURCE_TAG}] search failed: ${err.message}`);
    return [];
  }
}

/** Check if a URL is a valid post URL (not a category/page/asset). */
function isValidPostUrl(url) {
  if (!url) return false;
  if (
    url.includes('/category/') ||
    url.includes('/page/') ||
    url.includes('/feed') ||
    url.includes('wp-') ||
    url.includes('/tag/') ||
    url.includes('/images/') ||
    url.includes('/?') ||
    url.endsWith('.css') ||
    url.endsWith('.js') ||
    url.endsWith('.png') ||
    url.endsWith('.jpg') ||
    url.endsWith('.webp')
  ) return false;
  // Must have a subpath beyond just the domain
  const parts = url.replace(/^https?:\/\/[^/]+\//, '').split('/');
  return parts.length >= 1 && parts[0].length > 0;
}

/**
 * Extract direct video URLs from a 4KHDHub post page.
 */
async function extractVideoUrls(postUrl) {
  try {
    const res = await smartGet(postUrl, { timeout: 15000 });
    const html = String(res.data || '');

    // Step 1: Look for direct .mp4/.mkv/.m3u8 URLs in the page
    const urlRegex = /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm)(?:\?[^\s"'<>()]*)?/gi;
    const direct = [...new Set(html.match(urlRegex) || [])];

    const results = [];
    for (const url of direct) {
      results.push({ url, hint: 'direct' });
    }

    // Step 2: Extract locker links (HubCloud, GDToot, GDrive, etc.)
    const lockerLinks = linkExtractor.extractLockerLinks(html);

    if (lockerLinks.length > 0) {
      logger.info(
        `[${SOURCE_TAG}] found ${lockerLinks.length} locker links, resolving...`
      );

      // Resolve each locker URL to a direct stream URL
      const resolved = await linkExtractor.resolveLockerUrls(lockerLinks, {}, 3);

      for (const r of resolved) {
        results.push({ url: r.url, hint: r.host || 'resolved' });
      }
    }

    // Step 3: Also look for quality-labeled links as fallback
    const qualityRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>[^<]*(480p|720p|1080p|2160p|4k)[^<]*<\/a>/gi;
    let m;
    while ((m = qualityRegex.exec(html)) !== null) {
      if (utils.isVideoStreamUrl(m[1])) {
        results.push({ url: m[1], hint: m[2] });
      }
    }

    return results;
  } catch (err) {
    logger.debug(`[${SOURCE_TAG}] extractVideoUrls failed: ${err.message}`);
    return [];
  }
}

function pickBestPost(posts, title, year) {
  if (!posts.length) return null;
  const titleLower = title.toLowerCase();
  const titleDots = title.toLowerCase().replace(/\s+/g, '-');

  if (year) {
    const withYear = posts.find(
      (p) =>
        (p.title || '').toLowerCase().includes(titleLower) &&
        (p.title || '').includes(String(year))
    );
    if (withYear) return withYear;
  }

  const withTitle = posts.find((p) =>
    (p.title || '').toLowerCase().includes(titleLower) ||
    (p.url || '').toLowerCase().includes(titleDots)
  );
  if (withTitle) return withTitle;

  return posts[0];
}

async function resolve(ctxInput) {
  const ctx = normalizeContext(ctxInput);
  if (!ctx) return [];

  if (!ctx.title) {
    logger.debug(`[${SOURCE_TAG}] no title for ${ctx.imdb} - skipping`);
    return [];
  }

  const streams = [];

  try {
    const query = ctx.type === 'series' ? ctx.title : `${ctx.title} ${ctx.year || ''}`.trim();
    const posts = await searchPosts(query);

    if (!posts.length) {
      logger.info(`[${SOURCE_TAG}] no posts for "${query}"`);
      return [];
    }

    logger.info(`[${SOURCE_TAG}] "${query}" -> ${posts.length} posts`);

    const best = pickBestPost(posts, ctx.title, ctx.year);
    if (!best) return [];

    logger.info(`[${SOURCE_TAG}] picked: ${best.title || best.url}`);

    const candidates = await extractVideoUrls(best.url);

    for (const { url, hint } of candidates.slice(0, 5)) {
      if (!utils.isVideoStreamUrl(url)) continue;
      const s = utils.buildStream({
        sourceTag: SOURCE_TAG,
        title: `${SOURCE_TAG} • ${ctx.title}${ctx.season ? ` S${String(ctx.season).padStart(2, '0')}` : ''}${ctx.episode ? `E${String(ctx.episode).padStart(2, '0')}` : ''} • ${hint || utils.detectQuality(url)} • ${utils.detectContainer(url)}`,
        url,
      });
      if (s) streams.push(s);
    }

    if (streams.length === 0) {
      logger.info(`[${SOURCE_TAG}] found post but no direct video URLs: ${best.url}`);
    }
  } catch (err) {
    logger.warn(`[${SOURCE_TAG}] resolve failed: ${err.message}`);
  }

  logger.info(`[${SOURCE_TAG}] ${ctx.imdb} (${ctx.title}) -> ${streams.length} streams`);
  return streams;
}

module.exports = { resolve, SOURCE_TAG };
