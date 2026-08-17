// src/nuvio/1desiremovies.cjs
// 1desiremovies.wales — movies & TV series with download links (1080p/720p/480p)
//
// Flow:
//   1. Search via WP REST API: /wp-json/wp/v2/posts?search={title}
//   2. Match by title + year (movies) or season (TV)
//   3. Fetch post page → find <p><strong>QUALITY</strong></p> + <h3><a>GD & DOWNLOAD</a></h3>
//   4. Each download link is gyanigurus.online/view/{id}
//   5. Resolve gyanigurus.online → hubdrive.tips/file/{id} (handled by HubExtractor)
//
// The hubdrive.tips URLs are claimed by the HubExtractor which resolves them
// to direct CDN URLs.

'use strict';

const cheerio = require('cheerio');
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const BASE_URL = 'https://1desiremovies.wales';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let _gotScraping = null;
async function getGotScraping() {
  if (_gotScraping) return _gotScraping;
  try {
    const mod = await import('got-scraping');
    _gotScraping = mod.gotScraping;
  } catch (e) {
    console.error('[1desiremovies] Failed to load got-scraping:', e.message);
  }
  return _gotScraping;
}

async function fetchText(url, options = {}) {
  const gotScraping = await getGotScraping();
  if (!gotScraping) {
    const r = await fetch(url, { ...options, headers: { 'User-Agent': UA, ...options.headers } });
    return await r.text();
  }
  const res = await gotScraping(url, {
    timeout: { request: 15000 },
    throwHttpErrors: false,
    headers: { 'User-Agent': UA, ...options.headers },
    followRedirect: true,
  });
  return res.body;
}

async function fetchJson(url) {
  const body = await fetchText(url, { headers: { Accept: 'application/json' } });
  try { return JSON.parse(body); } catch { return null; }
}

async function getTmdbInfo(tmdbId, mediaType) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  const data = await fetchJson(url);
  if (!data) return { title: '', year: '' };
  return {
    title: type === 'tv' ? data.name : data.title,
    year: (type === 'tv' ? data.first_air_date : data.release_date || '').slice(0, 4),
  };
}

// Normalize title for matching
function normalize(s) {
  return String(s || '').toLowerCase()
    .replace(/&#0*38;/g, '&').replace(/&amp;/g, '&')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Search 1desiremovies via WP REST API
async function searchPosts(query, year, targetSeason) {
  const apiUrl = `${BASE_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=10`;
  const posts = await fetchJson(apiUrl);
  if (!Array.isArray(posts)) return [];

  const queryNorm = normalize(query);
  const yearStr = year ? String(year) : '';

  return posts.filter(post => {
    const title = post.title?.rendered || '';
    const titleNorm = normalize(title);

    // Title must contain the query
    if (!titleNorm.includes(queryNorm)) return false;

    // Year matching (for movies only — TV shows use season matching instead
    // because the year in the post title is the season's air year, not the
    // show's first air year)
    if (yearStr && targetSeason === null) {
      const link = post.link || '';
      if (!titleNorm.includes(yearStr) && !link.includes(yearStr)) return false;
    }

    // Season matching (for TV)
    if (targetSeason !== null) {
      const seasonMatch = title.match(/Season\s*(\d+)/i);
      if (seasonMatch) {
        if (parseInt(seasonMatch[1]) !== targetSeason) return false;
      } else {
        // No season in title — skip (we can't verify it's the right season)
        return false;
      }
    }

    return true;
  });
}

// Extract download links from post page.
// Movies: <p><strong>1080p</strong></p> <h3><a href="gyanigurus.online/...">GD & DOWNLOAD</a></h3>
// Series: <strong><a href="gyanigurus.online/...">1080p</a> | <a href="...">720p</a> | ...</strong>
//          (each link text IS the quality, no separate heading)
async function extractDownloadLinks(postUrl, title, year) {
  const html = await fetchText(postUrl, { headers: { Referer: BASE_URL + '/' } });
  if (!html || html.length < 500) return [];

  const $ = cheerio.load(html);
  const results = [];

  // Find ALL gyanigurus links on the page
  $('a').each((_i, el) => {
    const href = $(el).attr('href') || '';
    if (!href.includes('gyanigurus')) return;

    const linkText = $(el).text().trim();
    let quality = null;
    let height = 1080;

    // Pattern 1: Link text IS the quality (series)
    // e.g. "1080p", "720p", "480p", "HEVC"
    if (/^(2160p|1080p|720p|480p|HEVC)$/i.test(linkText)) {
      quality = linkText.toLowerCase();
      if (quality.includes('2160')) height = 2160;
      else if (quality.includes('1080')) height = 1080;
      else if (quality.includes('720')) height = 720;
      else if (quality.includes('480')) height = 480;
      else if (quality.includes('hevc')) { height = 1080; quality = '1080p'; }
    }
    // Pattern 2: Link text is "GD & DOWNLOAD" (movies)
    // Quality comes from preceding <p><strong>QUALITY</strong></p>
    else if (/GD|DOWNLOAD/i.test(linkText)) {
      // Walk backwards to find quality
      let prev = $(el).closest('h3, h4').prev();
      while (prev.length) {
        const prevText = prev.text().trim();
        const qMatch = prevText.match(/(2160p|1080p|720p|480p|4k)/i);
        if (qMatch && prevText.length < 50) {
          quality = qMatch[1].toLowerCase();
          if (quality.includes('2160') || quality.includes('4k')) height = 2160;
          else if (quality.includes('1080')) height = 1080;
          else if (quality.includes('720')) height = 720;
          else if (quality.includes('480')) height = 480;
          break;
        }
        prev = prev.prev();
      }
    }

    if (quality) {
      results.push({
        url: href,
        quality,
        height,
        title: `${title} ${year ? '(' + year + ')' : ''} ${quality}`,
      });
    }
  });

  // Deduplicate by URL
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

// Main: getStreams
async function getStreams(tmdbId, mediaType, season, episode) {
  const info = await getTmdbInfo(tmdbId, mediaType);
  if (!info.title) return [];

  const targetSeason = mediaType === 'tv' ? (season || 1) : null;
  const posts = await searchPosts(info.title, info.year, targetSeason);
  if (posts.length === 0) return [];

  // Use the first matching post
  const post = posts[0];
  const links = await extractDownloadLinks(post.link, info.title, info.year);

  return links.map(l => ({
    name: `1DesireMovies | ${l.quality} | GDrive`,
    title: l.title,
    url: l.url,
    quality: l.quality,
    headers: { Referer: BASE_URL + '/' },
    source: '1desiremovies',
  }));
}

module.exports = { getStreams };
