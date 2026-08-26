/**
 * Source: Pahe (pahe.ink)
 *
 * WordPress-based movie/series release blog.
 * Cloudflare-protected → uses smartScraper (ScrapingAnt) for all requests.
 *
 * Flow:
 *   1. Search pahe.ink/?s=title
 *   2. Find matching post page
 *   3. Extract direct video URLs + locker links from post
 *   4. Resolve locker links via linkExtractor
 */

const smartScraper = require('../smartScraper');
const linkExtractor = require('../linkExtractor');
const utils = require('../utils');
const logger = require('../logger');
const cheerio = require('cheerio');

const SOURCE_TAG = 'Pahe';
const BASE = 'https://pahe.ink';

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
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#8217;/g, "'");
}

/**
 * Search Pahe for posts matching a title.
 */
async function searchPosts(query) {
  if (!query) return [];
  const searchUrl = `${BASE}/?s=${encodeURIComponent(query)}`;

  const result = await smartScraper.smartFetch(searchUrl, { timeout: 45000 });
  if (!result || result.status !== 200 || !result.body) return [];

  const $ = cheerio.load(result.body);
  const posts = [];

  $('a').each((i, el) => {
    const href = $(el).attr('href');
    const title = $(el).attr('title');
    if (!href || !title) return;
    if (!href.startsWith('https://pahe.ink/') && !href.startsWith('http://pahe.ink/')) return;
    if (href.includes('/tag/') || href.includes('/category/') || href.includes('/page/') ||
        href.includes('/feed') || href.includes('wp-') || href.includes('/imdb-top') ||
        href.includes('/oscar')) return;
    posts.push({ url: href, title: decodeEntities(title) });
  });

  // Dedupe
  const seen = new Set();
  return posts.filter((p) => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });
}

/**
 * Extract video URLs + locker links from a Pahe post page.
 */
async function extractVideoUrls(postUrl) {
  const result = await smartScraper.smartFetch(postUrl, { timeout: 45000 });
  if (!result || result.status !== 200 || !result.body) return [];

  const html = result.body;
  const $ = cheerio.load(html);
  const results = [];

  // Direct .mp4/.mkv/.m3u8 URLs
  const urlRegex = /https?:\/\/[^\s"'<>()]+?\.(?:mp4|m3u8|mkv|webm)(?:\?[^\s"'<>()]*)?/gi;
  const direct = [...new Set(html.match(urlRegex) || [])];
  for (const url of direct) {
    results.push({ url, hint: 'direct' });
  }

  // Locker links (HubCloud, GDToot, GDrive, etc.)
  const lockerLinks = linkExtractor.extractLockerLinks(html);
  if (lockerLinks.length > 0) {
    logger.info(`[${SOURCE_TAG}] found ${lockerLinks.length} locker links, resolving...`);
    const resolved = await linkExtractor.resolveLockerUrls(lockerLinks, {}, 3);
    for (const r of resolved) {
      results.push({ url: r.url, hint: r.host || 'resolved' });
    }
  }

  // Quality-labeled links
  const qualityRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>[^<]*(480p|720p|1080p|2160p|4k)[^<]*<\/a>/gi;
  let m;
  while ((m = qualityRegex.exec(html)) !== null) {
    if (utils.isVideoStreamUrl(m[1])) {
      results.push({ url: m[1], hint: m[2] });
    }
  }

  return results;
}

/**
 * Pick the best matching post.
 */
function pickBestPost(posts, title, year) {
  if (!posts.length) return null;
  const titleLower = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matches = posts.filter((p) => {
    const pt = (p.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return pt.includes(titleLower);
  });
  if (!matches.length) return null;
  if (year) {
    const withYear = matches.find((p) => p.title.includes(String(year)));
    if (withYear) return withYear;
  }
  return matches[0];
}

async function resolve(ctxInput) {
  const ctx = normalizeContext(ctxInput);
  if (!ctx) return [];
  if (!ctx.title) return [];

  const streams = [];
  try {
    const query = ctx.type === 'series' ? ctx.title : `${ctx.title} ${ctx.year || ''}`.trim();
    const posts = await searchPosts(query);
    if (!posts.length) return [];

    const best = pickBestPost(posts, ctx.title, ctx.year);
    if (!best) return [];

    logger.info(`[${SOURCE_TAG}] picked: ${best.title.substring(0, 60)}`);

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
  } catch (err) {
    logger.warn(`[${SOURCE_TAG}] resolve failed: ${err.message}`);
  }

  logger.info(`[${SOURCE_TAG}] ${ctx.imdb} (${ctx.title}) -> ${streams.length} streams`);
  return streams;
}

module.exports = { resolve, SOURCE_TAG };
