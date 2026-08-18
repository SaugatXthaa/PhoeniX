// src/nuvio/4khdhub_one.cjs
// 4khdhub.one — movies & TV series with HubCloud/HubDrive download links
//
// Flow:
//   1. Search via /?s={title} (HTML, no CF challenge)
//   2. Match by title + year (movies) or season (TV)
//   3. For movies: extract hubcloud/hubdrive links grouped by quality
//   4. For series: filter by season+episode, extract hubcloud/hubdrive links
//   5. HubExtractor handles hubcloud.ist and hubdrive.tips URLs
//
// Supports: movies, TV series, up to 4K/2160p when available.

'use strict';

const cheerio = require('cheerio');
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const BASE_URL = 'https://4khdhub.one';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', ...options.headers },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return await r.text();
  } finally { clearTimeout(timer); }
}

async function getTMDBInfo(tmdbId, mediaType) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  try {
    const r = await fetch('https://api.themoviedb.org/3/' + type + '/' + tmdbId + '?api_key=' + TMDB_API_KEY);
    const d = await r.json();
    return {
      title: type === 'tv' ? d.name : d.title,
      year: ((d.first_air_date || d.release_date || '') + '').split('-')[0],
    };
  } catch { return { title: '', year: '' }; }
}

function normalize(s) {
  return String(s || '').toLowerCase()
    .replace(/&#0*38;/g, '&').replace(/&amp;/g, '&')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Search 4khdhub.one via HTML search page
async function search(title) {
  const searchUrl = BASE_URL + '/?s=' + encodeURIComponent(title);
  console.log('[4KHDHubOne] Searching: ' + searchUrl);
  const html = await fetchText(searchUrl);
  const $ = cheerio.load(html);
  const results = [];
  const nameNorm = normalize(title);

  $('a[href^="/"]').each((_i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    // Match post URLs like /title-movie-123/ or /title-series-456/
    if (!href.match(/^\/[^/]+-(?:movie|series)-\d+\/?$/)) return;
    const fullUrl = BASE_URL + href;

    // Extract the slug (title part)
    const slug = href.replace(/^\//, '').replace(/\/$/, '');
    const slugNorm = normalize(slug.replace(/-(?:movie|series)-\d+$/, '').replace(/-/g, ' '));

    // Match if slug contains any word from the title
    const titleWords = nameNorm.split(' ').filter(w => w.length > 2);
    const matched = titleWords.some(w => slugNorm.includes(w));
    if (matched) {
      // Extract type (movie or series)
      const isMovie = href.includes('-movie-');
      results.push({ url: fullUrl, slug, isMovie, text });
    }
  });

  // Dedupe by URL
  const seen = {};
  const unique = results.filter(r => {
    if (seen[r.url]) return false;
    seen[r.url] = true;
    return true;
  });

  console.log('[4KHDHubOne] Found ' + unique.length + ' results');
  return unique;
}

// Find best match by title + year
function findBestMatch(results, tmdbTitle, tmdbYear, isMovie) {
  if (!results.length) return null;
  const nameNorm = normalize(tmdbTitle);
  const yearStr = tmdbYear ? String(tmdbYear) : '';

  // Filter by type (movie vs series)
  const filtered = results.filter(r => r.isMovie === isMovie);
  if (filtered.length === 0) return results[0]; // fallback to first result

  let best = null;
  let bestScore = 0;

  for (const r of filtered) {
    const slugNorm = normalize(r.slug.replace(/-(?:movie|series)-\d+$/, '').replace(/-/g, ' '));
    let score = 0;
    if (slugNorm === nameNorm) score = 100;
    else if (slugNorm.includes(nameNorm) || nameNorm.includes(slugNorm)) score = 80;
    else {
      const words = nameNorm.split(' ').filter(w => w.length > 2);
      const matched = words.filter(w => slugNorm.includes(w)).length;
      score = (matched / Math.max(words.length, 1)) * 60;
    }

    // Year matching for movies
    if (yearStr && isMovie && r.slug.includes(yearStr)) score += 20;

    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  if (best && bestScore >= 30) {
    console.log('[4KHDHubOne] Matched: ' + best.slug + ' (score=' + bestScore + ')');
    return best;
  }
  return filtered[0] || results[0];
}

// Extract download links from a movie post page
// Only returns hubdrive.tips URLs (skips hubcloud.ist) to avoid duplicate
// streams — HubExtractor resolves hubdrive.tips → hubcloud.cx → direct CDN.
function extractMovieLinks(html) {
  const $ = cheerio.load(html);
  const links = [];
  const seen = new Set();
  const seenQualities = new Set();

  $('a[href*="hubcloud"], a[href*="hubdrive"]').each((_i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (seen.has(href)) return;
    seen.add(href);

    // Skip hubcloud.ist — only use hubdrive.tips (resolves to direct CDN)
    // hubcloud.ist resolves to pixel.hubcloud.cx → workers.dev which has
    // 302 redirect + 403 issues that make streams unplayable.
    if (href.includes('hubcloud.ist')) return;

    // Walk up to find quality header
    let quality = '';
    let size = '';
    let parent = $(el).parent();
    for (let depth = 0; depth < 5; depth++) {
      parent.find('.badge, span').each((_j, badge) => {
        const badgeText = $(badge).text().trim();
        if (badgeText.match(/2160p|1080p|720p|480p|4K|HDR|UHD|IMAX|BluRay|WEB/i) && !quality) {
          quality = badgeText;
        }
        if (badgeText.match(/[\d.]+\s*(?:GB|MB)/i) && !size) {
          size = badgeText;
        }
      });
      if (quality) break;
      parent = parent.parent();
    }

    // Deduplicate by quality — only keep first link per quality
    const qualityKey = quality || 'default';
    if (seenQualities.has(qualityKey)) return;
    seenQualities.add(qualityKey);

    links.push({ url: href, quality, size, text, host: text.replace('Download ', '') });
  });

  return links;
}

function extractEpisodeLinks(html, targetSeason, targetEpisode) {
  const $ = cheerio.load(html);
  const links = [];
  const seen = new Set();
  const seenQualities = new Set();

  $('.season-content').each((_i, seasonEl) => {
    const seasonText = $(seasonEl).find('.episode-number').first().text().trim();
    const seasonNum = seasonText.match(/S(\d+)/)?.[1];
    if (!seasonNum || parseInt(seasonNum) !== targetSeason) return;

    // Find ALL hubdrive links in this season (skip hubcloud.ist — unplayable)
    $(seasonEl).find('a[href*="hubdrive"]').each((_k, dl) => {
      const href = $(dl).attr('href') || '';
      const text = $(dl).text().trim();
      if (seen.has(href)) return;
      seen.add(href);

      let quality = '';
      let size = '';
      let parent = $(dl).parent();
      for (let depth = 0; depth < 5; depth++) {
        parent.find('.badge, span').each((_l, badge) => {
          const badgeText = $(badge).text().trim();
          if (badgeText.match(/2160p|1080p|720p|480p|4K|HDR/i) && !quality) {
            quality = badgeText;
          }
          if (badgeText.match(/[\d.]+\s*(?:GB|MB)/i) && !size) {
            size = badgeText;
          }
        });
        const parentText = parent.text().trim();
        const qMatch = parentText.match(/(2160p|1080p|720p|480p|4K|HDR|UHD|BluRay|HEVC|AVC|WEB)/i);
        if (qMatch && !quality) quality = qMatch[1];
        if (quality) break;
        parent = parent.parent();
      }

      // Deduplicate by quality
      const qualityKey = quality || 'default';
      if (seenQualities.has(qualityKey)) return;
      seenQualities.add(qualityKey);

      links.push({ url: href, quality, size, text, host: text.replace('Download ', '') });
    });
  });

  return links;
}


// Parse quality to height
function parseHeight(quality) {
  if (!quality) return undefined;
  const s = String(quality).toLowerCase();
  if (s.includes('2160') || s.includes('4k') || s.includes('uhd')) return 2160;
  if (s.includes('1080')) return 1080;
  if (s.includes('720')) return 720;
  if (s.includes('480')) return 480;
  return undefined;
}

// Main: getStreams
async function getStreams(tmdbId, type, season, episode) {
  const isMovie = type !== 'tv';
  console.log('[4KHDHubOne] Request: tmdb=' + tmdbId + ' type=' + type);

  const info = await getTMDBInfo(tmdbId, type);
  if (!info.title) return [];
  console.log('[4KHDHubOne] TMDB: ' + info.title + ' (' + info.year + ')');

  const results = await search(info.title);
  if (!results.length) return [];

  const match = findBestMatch(results, info.title, info.year, isMovie);
  if (!match) return [];

  // Fetch post page
  const html = await fetchText(match.url);
  console.log('[4KHDHubOne] Post page: ' + match.url + ' (' + html.length + ' chars)');

  let links;
  if (isMovie) {
    links = extractMovieLinks(html);
  } else {
    const targetSeason = season || 1;
    const targetEpisode = episode || 1;
    links = extractEpisodeLinks(html, targetSeason, targetEpisode);
  }

  if (!links.length) {
    console.log('[4KHDHubOne] No download links found');
    return [];
  }

  console.log('[4KHDHubOne] Found ' + links.length + ' download links');

  // Deduplicate by URL and limit to reasonable number
  const seen = new Set();
  const unique = [];
  for (const l of links) {
    if (seen.has(l.url)) continue;
    seen.add(l.url);
    unique.push(l);
    if (unique.length >= 6) break; // Limit to 6 links
  }

  return unique.map(l => ({
    name: '4KHDHubOne - ' + (l.quality || 'Download') + ' - ' + l.host,
    title: info.title + (isMovie ? '' : ' S' + String(season || 1).padStart(2, '0') + 'E' + String(episode || 1).padStart(2, '0')) +
           ' ' + (l.quality || '') + (l.size ? ' [' + l.size + ']' : ''),
    url: l.url,
    quality: l.quality || '',
    size: l.size || '',
    type: 'video/mkv',
    headers: { 'User-Agent': UA },
    behaviorHints: { bingeGroup: '4khdhubone-' + (l.quality || 'default') },
  }));
}

module.exports = { getStreams };
