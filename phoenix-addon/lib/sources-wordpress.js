/**
 * lib/sources-wordpress.js — Generic WordPress-style DDL blog source
 *
 * Many user-listed sources (4KHDHub, HDHub4u, MKVBase, MkvDrama, Nima4K,
 * UHDMovies, DDLBase, Ernax, Aether, StreamEx, FluxTV, Tenies, KMMovies, etc.)
 * follow the same WordPress DDL blog pattern:
 *   1. Search via /?s=<query>
 *   2. Find post page link
 *   3. Parse post page for download redirect links (gadgetsweb.xyz, hubcloud.in, hblinks.dad, etc.)
 *   4. Resolve each redirector URL to direct stream via extractors.js
 *
 * This is a clean, simplified port inspired by:
 *   - sootio-stremio-addon/lib/http-streams/providers/{4khdhub,hdhub4u,moviesmod,moviesleech,mkvcinemas,mallumv,cinedoze}/
 *   - webstreamr/src/source/HDHub4u.ts
 *
 * It uses extractors.js (extractAny) to resolve the redirector URLs to direct
 * playable streams.
 */

const cheerio = require('cheerio');
const axios = require('axios');
const https = require('https');
const { getMeta } = require('./meta');
const { extractAny } = require('./extractors');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HTTP_TIMEOUT = 10000;
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|webm|ts|m2ts|m4v|mpg|mpeg)$/i;

// Known redirector/locker host patterns (case-insensitive substring match)
const REDIRECTOR_PATTERNS = [
  'gadgetsweb.xyz', 'hblinks.dad', 'hubcloud.in', 'hubcloud.one',
  'hubdrive', 'driveseed', 'driveleech', 'gdtoot', 'gdtot',
  'fastream', 'doodstream', 'dood.so', 'filelions', 'filemoon',
  'modpro.blog', 'leechpro.blog', 'linksbna', 'gdbot', 'gplinks',
  'dropload', 'mixdrop', 'supervideo', 'vidplay', 'streamtape',
  'voe.sx', 'uqload', 'streamvid', 'streamwish'
];

async function httpGet(url, referer = null) {
  return axios.get(url, {
    httpsAgent,
    timeout: HTTP_TIMEOUT,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      'User-Agent': DEFAULT_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(referer && { Referer: referer })
    }
  });
}

// ============================================
// Search a WordPress DDL site for a title
// ============================================
async function searchWpSite(baseUrl, query) {
  const searchUrl = `${baseUrl}/?s=${encodeURIComponent(query)}`;
  try {
    const r = await httpGet(searchUrl, baseUrl);
    if (r.status !== 200) return [];
    const $ = cheerio.load(r.data);
    const results = [];
    $('article, .post, .post-item, .result-item, .search-result-item').each((_, el) => {
      const $el = $(el);
      const link = $el.find('a[href]').first().attr('href') ||
                   $el.find('h2 a, h3 a, .entry-title a, .post-title a').first().attr('href');
      const title = ($el.find('h2 a, h3 a, .entry-title a, .post-title a').first().text() ||
                     $el.find('a').first().attr('title') ||
                     $el.find('a').first().text() || '').trim();
      if (link && title) {
        try {
          const u = new URL(link, baseUrl);
          if (u.origin === new URL(baseUrl).origin) {
            results.push({ url: u.toString(), title: title.replace(/\s+/g, ' ').trim() });
          }
        } catch {}
      }
    });
    return results;
  } catch (e) { return []; }
}

// ============================================
// Find best matching post URL from search results
// ============================================
function findBestMatch(results, title, year = null, type = 'movie', season = null, episode = null) {
  if (!results || results.length === 0) return null;
  const titleLower = title.toLowerCase();
  const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);

  const scored = results.map(r => {
    const rLower = r.title.toLowerCase();
    let score = titleWords.reduce((s, w) => s + (rLower.includes(w) ? 1 : 0), 0);

    if (year && rLower.includes(String(year))) score += 3;
    if (type === 'series') {
      if (season && new RegExp(`\\b(?:season\\s*0*${season}|s0*${season})\\b`, 'i').test(r.title)) score += 5;
      if (episode && new RegExp(`\\b(?:ep(?:isode)?\\.?\\s*0*${episode}|e0*${episode})\\b`, 'i').test(r.title)) score += 3;
    } else {
      // Movies: avoid results that mention "season" or "episode"
      if (/\bseason\b|\bepisode\b|\bS\d{2}E\d{2}\b/i.test(r.title)) score -= 10;
    }
    return { ...r, score };
  }).filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.url || null;
}

// ============================================
// Parse post page for download redirector links
// ============================================
async function parsePostForLinks(postUrl, type, season, episode) {
  try {
    const r = await httpGet(postUrl);
    if (r.status !== 200) return [];
    const $ = cheerio.load(r.data);
    const links = [];

    // Find all links matching redirector patterns
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const text = $(el).text().trim();

      // Check if href matches any redirector pattern
      const isRedirector = REDIRECTOR_PATTERNS.some(p => href.toLowerCase().includes(p));
      if (!isRedirector) return;

      // For series: filter by episode
      if (type === 'series' && episode != null) {
        const parent = $(el).closest('p, div, li, h4, h3, h2, tr, td').first().text() || text;
        if (parent) {
          const epPat = new RegExp(`\\b(?:EP?\\.?|Episode)\\s*0*${episode}\\b`, 'i');
          const sPat = new RegExp(`\\bS0*${season}\\b`, 'i');
          if (!epPat.test(parent)) return;
          if (season != null && !sPat.test(parent)) return;
        }
      }

      links.push({ href, text, parent: $(el).closest('p, div, li, h4, h3, h2, tr, td').first().text() || '' });
    });

    return links;
  } catch (e) { return []; }
}

// ============================================
// Resolve a redirector URL through extractors
// ============================================
async function resolveRedirector(url, referer) {
  try {
    // Some redirectors (gadgetsweb, modpro.blog) do a JS redirect to a hubcloud URL
    // We need to fetch the page first to find the actual hubcloud link
    if (/gadgetsweb\.xyz/.test(url)) {
      const r = await httpGet(url, referer);
      if (r.status === 200) {
        // Try JS redirect pattern
        const m = r.data.match(/(?:window\.location|location\.href|var\s+url)\s*=\s*['"]([^'"]+)['"]/);
        if (m?.[1] && /hubcloud|hubdrive/i.test(m[1])) {
          url = m[1];
        }
        // Or look for an <a> tag with hubcloud href
        if (!/hubcloud|hubdrive/i.test(url)) {
          const $ = cheerio.load(r.data);
          const a = $('a[href*="hubcloud"], a[href*="hubdrive"]').first().attr('href');
          if (a) url = a;
        }
      }
    } else if (/hblinks\.dad/.test(url)) {
      // hblinks.dad shows a list of hubcloud/gdrive links
      const r = await httpGet(url, referer);
      if (r.status === 200) {
        const $ = cheerio.load(r.data);
        const a = $('a[href*="hubcloud"], a[href*="hubdrive"], a[href*="gdtot"], a[href*="fastream"]').first().attr('href');
        if (a) url = a;
      }
    }

    // Now extract direct streams via extractors
    const extracted = await extractAny(url, { referer });
    return extracted;
  } catch (e) { return []; }
}

// ============================================
// Main entry: build streams for a DDL source
// config: { id, label, baseUrl, type: 'movie'|'series'|'both' }
// ============================================
async function getWpStreams(config, imdbId, type, season = null, episode = null) {
  // Skip if source doesn't support this content type
  if (config.type === 'movie' && type !== 'movie') return [];
  if (config.type === 'series' && type !== 'series') return [];

  const meta = await getMeta(imdbId, type);
  if (!meta?.name) return [];

  // Build search queries
  const queries = Array.from(new Set([
    `${meta.name} ${meta.year || ''}`.trim(),
    meta.name,
    meta.originalName,
    meta.originalName ? `${meta.originalName} ${meta.year || ''}`.trim() : null
  ].filter(Boolean)));

  // Search site for each query
  let postUrl = null;
  for (const q of queries) {
    const results = await searchWpSite(config.baseUrl, q);
    if (results.length > 0) {
      postUrl = findBestMatch(results, meta.name, meta.year, type, season, episode);
      if (postUrl) break;
    }
  }

  if (!postUrl) return [];

  // Parse post page for redirector links
  const links = await parsePostForLinks(postUrl, type, season, episode);
  if (links.length === 0) return [];

  // Limit to top 4 redirector links (avoid too many requests)
  const limited = links.slice(0, 4);
  const allStreams = [];

  for (const link of limited) {
    try {
      const extracted = await resolveRedirector(link.href, postUrl);
      for (const ext of extracted) {
        allStreams.push({
          url: ext.url,
          name: `PhoeniX\n${ext.height || 'auto'}`,
          title: buildTitle(ext, config, link.text),
          behaviorHints: {
            notWebReady: true,
            bingeGroup: `phoenix-${config.id}-${ext.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            ...(ext.sizeBytes && { videoSize: ext.sizeBytes }),
            ...(ext.requestHeaders && Object.keys(ext.requestHeaders).length > 0 && {
              proxyHeaders: { request: ext.requestHeaders }
            })
          }
        });
      }
    } catch (e) { /* skip */ }
  }

  return allStreams;
}

function buildTitle(ext, config, linkText) {
  const parts = [];
  if (ext.title) parts.push(ext.title);
  else if (linkText) parts.push(linkText);
  if (ext.sizeBytes) {
    const sizeStr = formatSize(ext.sizeBytes);
    parts.push(`💾 ${sizeStr} | ${config.label} (${ext.label})`);
  } else {
    parts.push(`🔗 ${config.label} (${ext.label})`);
  }
  return parts.join('\n');
}

function formatSize(b) {
  if (!b) return '';
  if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(2) + ' TB';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MB';
  return b + ' B';
}

// ============================================
// Source configurations for user's listed DDL blogs
// ============================================
const SOURCES = [
  { id: '4khdhub', label: '4KHDHub', baseUrl: 'https://4khdhub.dad', type: 'both' },
  { id: 'hdhub4u', label: 'HDHub4u', baseUrl: 'https://new5.hdhub4u.fo', type: 'both' },
  { id: 'mkvbase', label: 'MkvBase', baseUrl: 'https://mkvbase.site', type: 'both' },
  { id: 'uhdmovies', label: 'UHDMovies', baseUrl: 'https://uhdmovies.casa', type: 'both' },
  { id: 'nima4k', label: 'Nima4K', baseUrl: 'https://nima4k.org', type: 'both' },
  { id: 'mkvdrama', label: 'MkvDrama', baseUrl: 'https://mkvdrama.net', type: 'both' },
  { id: 'ddlbase', label: 'DDLBase', baseUrl: 'https://ddlbase.com', type: 'both' },
  { id: 'kmmovies', label: 'KMMovies', baseUrl: 'https://kmmovies.online', type: 'both' },
  { id: 'ernax', label: 'Ernax', baseUrl: 'https://ernax.pro', type: 'both' },
  { id: 'aether', label: 'Aether', baseUrl: 'https://aether.cx', type: 'both' },
  { id: 'streamex', label: 'StreamEx', baseUrl: 'https://streamex.sh', type: 'both' },
  { id: 'fluxtv', label: 'FluxTV', baseUrl: 'https://fluxtv.cc', type: 'both' },
  { id: 'tenies', label: 'Tenies', baseUrl: 'https://tenies.site', type: 'both' },
  { id: 'pahe', label: 'Pahe', baseUrl: 'https://pahe.ink', type: 'both' },
  { id: 'showbox', label: 'ShowBox', baseUrl: 'https://showbox.media', type: 'both' }
];

module.exports = { getWpStreams, SOURCES, searchWpSite, parsePostForLinks };
