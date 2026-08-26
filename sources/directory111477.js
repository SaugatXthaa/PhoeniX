/**
 * Source: Directory 111477 (open video CDN)
 * URL: https://a.111477.xyz/
 *
 * Uses smartScraper for ALL requests (ScrapingAnt bypasses Cloudflare).
 * Returns direct .mkv/.mp4 stream URLs for movies, series, anime, K-dramas.
 */

const smartScraper = require('../smartScraper');
const utils = require('../utils');
const logger = require('../logger');
const cheerio = require('cheerio');

const SOURCE_TAG = 'Directory111477';
const BASE = 'https://a.111477.xyz';
const DL_BASE = 'https://a.111477.xyz/d'; // AList /d/ prefix for direct downloads

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

/** Decode HTML entities. */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#8217;/g, "'");
}

/**
 * Parse season/episode from a filename.
 */
function parseSeasonEpisode(filename) {
  const m = filename.match(/S(\d{1,2})E(\d{1,3})/i);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  const m2 = filename.match(/s(\d{1,2})e(\d{1,3})/i);
  if (m2) return { season: parseInt(m2[1], 10), episode: parseInt(m2[2], 10) };
  return null;
}

/**
 * Fetch a URL via smartScraper and parse links with Cheerio.
 * Returns array of href strings.
 */
async function fetchAndParseLinks(url) {
  const result = await smartScraper.smartFetch(url, { timeout: 45000 });
  if (!result || result.status !== 200 || !result.body) return [];

  const $ = cheerio.load(result.body);
  const links = [];
  $('a').each((i, el) => {
    const href = $(el).attr('href');
    if (href) links.push(href);
  });
  return links;
}

/**
 * Try direct folder URL: /movies/Title (Year)/
 * If it contains video files, return the folder path.
 */
async function tryDirectFolder(category, title, year) {
  if (!year || category !== 'movies') return null;

  const folderPath = `/${category}/${encodeURIComponent(title + ' (' + year + ')')}/`;
  const directUrl = `${BASE}${folderPath}`;

  const result = await smartScraper.smartFetch(directUrl, { timeout: 45000 });
  if (!result || result.status !== 200 || !result.body) return null;

  // Check for 404 page (AList returns a small "404 - Not Found" HTML)
  if (result.body.length < 5000 && result.body.includes('404')) {
    logger.debug(`[${SOURCE_TAG}] direct URL 404: ${directUrl}`);
    return null;
  }

  const $ = cheerio.load(result.body);
  const files = [];
  $('a').each((i, el) => {
    const href = $(el).attr('href');
    if (href && /\.(mp4|mkv|m3u8|webm)$/i.test(href)) {
      files.push(href);
    }
  });

  if (files.length > 0) {
    logger.info(`[${SOURCE_TAG}] direct URL hit: ${files.length} files`);
    return { folderPath, videoFiles: files };
  }
  return null;
}

/**
 * Search for folders matching a title.
 */
async function searchFolders(category, title, year) {
  if (!title) return [];

  const cleanTitle = utils.formatQueryTitle(title);
  const queries = [
    year ? `${cleanTitle} ${year}` : cleanTitle,
    year ? `${cleanTitle}.${year}` : cleanTitle,
    cleanTitle,
  ];

  const titleLower = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const query of queries) {
    const searchUrl = `${BASE}/${category}/?q=${encodeURIComponent(query)}`;
    const links = await fetchAndParseLinks(searchUrl);

    const folderLinks = links.filter((l) =>
      l.startsWith(`/${category}/`) && (l.endsWith('/') || /\.(mp4|mkv)$/i.test(l))
    );

    const decoded = folderLinks.map((l) => ({
      raw: l,
      decoded: decodeEntities(decodeURIComponent(l)),
    }));

    const matches = decoded.filter((d) => {
      const dl = d.decoded.toLowerCase().replace(/[^a-z0-9]/g, '');
      return dl.includes(titleLower);
    });

    const withYear = year ? matches.filter((d) => d.decoded.includes(String(year))) : [];
    const final = (withYear.length ? withYear : matches).slice(0, 5);
    if (final.length) return final.map((f) => f.raw);
  }
  return [];
}

/**
 * List video files in a folder.
 */
async function listFolder(folderPath) {
  const url = `${BASE}${folderPath}`;
  const links = await fetchAndParseLinks(url);
  return links.filter((l) => /\.(mp4|mkv|m3u8|webm)$/i.test(l));
}

/**
 * Resolve streams for a given context.
 */
async function resolve(ctxInput) {
  const ctx = normalizeContext(ctxInput);
  if (!ctx) return [];
  if (!ctx.title) {
    logger.debug(`[${SOURCE_TAG}] no title for ${ctx.imdb} - skipping`);
    return [];
  }

  const streams = [];
  const categories = ctx.type === 'series'
    ? ['tvs', 'kdrama', 'asiandrama']
    : ['movies'];

  for (const category of categories) {
    // Step 1: Try direct folder URL (1 ScrapingAnt call, ~15s)
    const direct = await tryDirectFolder(category, ctx.title, ctx.year);
    if (direct) {
      for (const file of direct.videoFiles.slice(0, 5)) {
        const fullUrl = file.startsWith('http') ? file : `${DL_BASE}${file.startsWith('/') ? '' : direct.folderPath}${file}`;
        const s = utils.buildStream({
          sourceTag: SOURCE_TAG,
          title: `${SOURCE_TAG} • ${ctx.title} (${ctx.year || ''}) • ${utils.detectQuality(file)} • ${utils.detectContainer(file)}`,
          url: fullUrl,
        });
        if (s) streams.push(s);
      }
      if (streams.length > 0) break;
      continue;
    }

    // Step 2: Search for matching folders
    const folders = await searchFolders(category, ctx.title, ctx.year);
    if (!folders.length) continue;

    logger.info(`[${SOURCE_TAG}] ${ctx.title} in ${category}: ${folders.length} match(es)`);

    // Step 3: List files in each folder
    for (const folder of folders.slice(0, 3)) {
      const files = await listFolder(folder);
      if (!files.length) continue;

      if (ctx.type === 'series' && ctx.season && ctx.episode) {
        for (const file of files) {
          const se = parseSeasonEpisode(file);
          if (se && se.season === ctx.season && se.episode === ctx.episode) {
            const fullUrl = `${DL_BASE}${file}`;
            const s = utils.buildStream({
              sourceTag: SOURCE_TAG,
              title: `${SOURCE_TAG} • ${ctx.title} S${String(ctx.season).padStart(2, '0')}E${String(ctx.episode).padStart(2, '0')} • ${utils.detectQuality(file)} • ${utils.detectContainer(file)}`,
              url: fullUrl,
            });
            if (s) streams.push(s);
          }
        }
      } else if (ctx.type === 'series' && ctx.season) {
        for (const file of files) {
          const se = parseSeasonEpisode(file);
          if (se && se.season === ctx.season) {
            const fullUrl = `${DL_BASE}${file}`;
            const s = utils.buildStream({
              sourceTag: SOURCE_TAG,
              title: `${SOURCE_TAG} • ${ctx.title} S${String(se.season).padStart(2, '0')}E${String(se.episode).padStart(2, '0')} • ${utils.detectQuality(file)} • ${utils.detectContainer(file)}`,
              url: fullUrl,
            });
            if (s) streams.push(s);
          }
        }
      } else {
        for (const file of files.slice(0, 3)) {
          const fullUrl = `${DL_BASE}${file}`;
          const s = utils.buildStream({
            sourceTag: SOURCE_TAG,
            title: `${SOURCE_TAG} • ${ctx.title} (${ctx.year || ''}) • ${utils.detectQuality(file)} • ${utils.detectContainer(file)}`,
            url: fullUrl,
          });
          if (s) streams.push(s);
        }
      }
    }
    if (streams.length > 0) break;
  }

  logger.info(`[${SOURCE_TAG}] ${ctx.imdb} (${ctx.title}) -> ${streams.length} streams`);
  return streams;
}

module.exports = { resolve, SOURCE_TAG };
