/**
 * Source: UHDMovies (uhdmovies.casa -> uhdmovies.autos)
 *
 * WordPress-based 4K/UHD movie blog. Searches by title, finds matching
 * posts, extracts direct video URLs or GDrive redirect links.
 *
 * Note: UHDMovies uses cloud.unblockedgames.world intermediary redirects
 * with encrypted sid params. We extract direct .mp4/.mkv URLs where
 * available; intermediate redirect URLs are not returned (Stremio can't
 * play them).
 */

const http = require('../http');
const smartScraper = require('../smartScraper');

/** Wrapper that mimics http.get but uses smartScraper internally. */
const smartGet = async (url, opts = {}) => {
  const result = await smartScraper.smartFetch(url, opts);
  if (result && result.status === 200 && result.body) {
    return { status: 200, data: result.body };
  }
  return { status: 0, data: '' };
};
const utils = require('../utils');
const logger = require('../logger');

const SOURCE_TAG = 'UHDMovies';
const BASE = 'https://uhdmovies.casa';
const ALT_BASE = 'https://uhdmovies.autos';

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
 * Search UHDMovies for posts matching a title.
 * Tries both .casa and .autos domains.
 */
async function searchPosts(query) {
  if (!query) return [];
  const bases = [BASE, ALT_BASE];
  for (const base of bases) {
    const searchUrl = `${base}/?s=${encodeURIComponent(query)}`;
    try {
      const res = await smartGet(searchUrl, { timeout: 15000 });
      const html = String(res.data || '');

      // Find <a> tags with title attributes
      const titledRegex = /<a[^>]+href="(https?:\/\/[^"]*uhdmovies\.[a-z]+\/[^"]+)"[^>]+title="([^"]+)"[^>]*>/gi;
      let m;
      const posts = [];
      while ((m = titledRegex.exec(html)) !== null) {
        const url = m[1];
        const title = decodeEntities(m[2]);
        if (
          url.includes('/category/') ||
          url.includes('/page/') ||
          url.includes('/feed') ||
          url.includes('wp-') ||
          url.includes('/tag/')
        ) continue;
        posts.push({ url, title });
      }

      if (posts.length) return posts;
    } catch (err) {
      logger.debug(`[${SOURCE_TAG}] search ${base} failed: ${err.message}`);
    }
  }
  return [];
}

/**
 * Extract direct video URLs from a UHDMovies post page.
 */
async function extractVideoUrls(postUrl) {
  try {
    const res = await smartGet(postUrl, { timeout: 15000 });
    const html = String(res.data || '');

    // Direct .mp4/.mkv/.m3u8 URLs
    const urlRegex = /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm)(?:\?[^\s"'<>()]*)?/gi;
    const direct = [...new Set(html.match(urlRegex) || [])];

    // Look for Google Drive direct download URLs
    const gdriveRegex = /https?:\/\/drive\.google\.com\/[^\s"'<>()]+/gi;
    const gdrive = [...new Set(html.match(gdriveRegex) || [])];

    // Look for quality-labeled links
    const qualityRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>[^<]*(480p|720p|1080p|2160p|4k)[^<]*<\/a>/gi;
    let m;
    const qualityLinks = [];
    while ((m = qualityRegex.exec(html)) !== null) {
      qualityLinks.push({ url: m[1], quality: m[2] });
    }

    const results = [];
    for (const url of direct) {
      results.push({ url, hint: 'direct' });
    }
    for (const q of qualityLinks) {
      if (utils.isVideoStreamUrl(q.url)) {
        results.push({ url: q.url, hint: q.quality });
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
  const titleDots = title.toLowerCase().replace(/\s+/g, '.');

  if (year) {
    const withYear = posts.find(
      (p) =>
        p.title.toLowerCase().includes(titleLower) &&
        p.title.includes(String(year))
    );
    if (withYear) return withYear;
  }

  const withTitle = posts.find(
    (p) =>
      p.title.toLowerCase().includes(titleLower) ||
      p.title.toLowerCase().includes(titleDots)
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
    // UHDMovies search works better with just the title (no year)
    const query = ctx.title;
    const posts = await searchPosts(query);

    if (!posts.length) {
      logger.info(`[${SOURCE_TAG}] no posts for "${query}"`);
      return [];
    }

    // Dedupe
    const seen = new Set();
    const unique = posts.filter((p) => {
      if (seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    });

    logger.info(`[${SOURCE_TAG}] "${query}" -> ${unique.length} posts`);

    const best = pickBestPost(unique, ctx.title, ctx.year);
    if (!best) return [];

    logger.info(`[${SOURCE_TAG}] picked: ${best.title.substring(0, 80)}`);

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
