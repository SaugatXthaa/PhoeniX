// src/nuvio/pahe.cjs
// Pahe (pahe.ink) — movies & TV with multi-quality download links
//
// Flow:
//   1. TMDB → get title + year
//   2. Build slug (title-year) and fetch pahe.ink/{slug}/
//   3. Extract download links from HTML (teknoasian.com redirector URLs)
//   4. Each link has quality, size, host name (Google Drive, MegaGo, etc.)
//
// The teknoasian.com URLs are encrypted redirectors that require browser JS
// execution to resolve to actual file host URLs. They CANNOT be resolved
// server-side. The PaheExtractor marks them as externalUrl so Stremio opens
// them in the user's browser where the JS can execute.
//
// Hosts: GD (Google Drive), MG (MegaGo), 1D/1F (1Fichier), PD (PixelDrain),
//        GDF (GDFlix), SL (SolidFiles)

'use strict';

const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const PAHE_BASE = 'https://pahe.ink';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Fetch with timeout — uses native fetch (no curl/execSync)
async function fetchText(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers,
      },
    });
    return await r.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeout = 15000) {
  try {
    const text = await fetchText(url, { ...options, headers: { Accept: 'application/json', ...options.headers } }, timeout);
    return JSON.parse(text);
  } catch { return null; }
}

async function getTmdbInfo(tmdbId, type) {
  try {
    const d = await fetchJson(`${TMDB_BASE}/${type}/${tmdbId}?api_key=${TMDB_API_KEY}`);
    if (!d) return { title: '', year: '' };
    return {
      title: type === 'tv' ? d.name : d.title,
      year: (d.release_date || d.first_air_date || '').slice(0, 4),
    };
  } catch { return { title: '', year: '' }; }
}

function buildSlug(title, year) {
  let slug = title.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (year) slug += '-' + year;
  return slug;
}

// Host name mapping for display
const HOST_NAMES = {
  GD: 'Google Drive', MG: 'MegaGo', '1D': '1Fichier', PD: 'PixelDrain',
  '1F': '1Fichier', GDF: 'GDFlix', SL: 'SolidFiles',
};

// Extract download links from pahe.ink HTML
function extractDownloadLinks(html) {
  const streams = [];
  const boxStart = html.indexOf('class="box download');
  if (boxStart < 0) return streams;

  const boxHtml = html.substring(boxStart, boxStart + 30000);
  const parts = boxHtml.split(/<br\s*\/?>/i);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Match quality + optional size: "720p" or "1080p | 1.5GB"
    const qMatch = part.match(/(\d{3,4}p[^<|]*?)(?:\|\s*([0-9.]+\s*(?:GB|MB|gb|mb)))?/i);
    if (!qMatch) continue;

    const qualityText = qMatch[1].trim();
    const size = qMatch[2] ? qMatch[2].trim().toUpperCase() : '';
    const searchParts = part + ' ' + (parts[i + 1] || '');

    // Match teknoasian.com links with host label (GD, MG, 1D, PD, 1F, GDF, SL)
    const bRegex = /<a[^>]*href="(https:\/\/teknoasian\.com\/[^"]+)"[^>]*>\s*(GD|MG|1D|PD|1F|GDF|SL)\s*<\/a>/gi;
    let bMatch;
    while ((bMatch = bRegex.exec(searchParts)) !== null) {
      const hostCode = bMatch[2];
      const hostName = HOST_NAMES[hostCode] || hostCode;
      streams.push({
        name: `Pahe | ${qualityText} | ${hostName}${size ? ' [' + size + ']' : ''}`,
        title: qualityText,
        quality: qualityText.split(' ')[0].toLowerCase(),
        size: size,
        url: bMatch[1],
        source: 'pahe',
        headers: { 'Referer': 'https://pahe.ink/' },
      });
    }
  }
  return streams;
}

// Main: getStreams
async function getStreams(tmdbId, type, season, episode) {
  const isTV = type === 'tv' || type === 'series';
  const mediaType = isTV ? 'tv' : 'movie';
  const info = await getTmdbInfo(tmdbId, mediaType);
  if (!info.title) return [];

  const displayTitle = info.title + (isTV && season ? ` S${season}E${episode || 1}` : '');

  // Strategy 1: Try direct URL with slug (title-year)
  const slug = buildSlug(info.title, info.year);
  const html = await fetchText(`${PAHE_BASE}/${slug}/`);
  if (html && html.includes('box download')) {
    const links = extractDownloadLinks(html);
    for (const l of links) {
      l.title = displayTitle;
      l.description = `${l.quality} ${l.size}`;
    }
    if (links.length > 0) return links;
  }

  // Strategy 2: Try without year
  if (info.year) {
    const slug2 = buildSlug(info.title, '');
    const html2 = await fetchText(`${PAHE_BASE}/${slug2}/`);
    if (html2 && html2.includes('box download')) {
      const links = extractDownloadLinks(html2);
      for (const l of links) {
        l.title = displayTitle;
        l.description = `${l.quality} ${l.size}`;
      }
      if (links.length > 0) return links;
    }
  }

  // Strategy 3: Try WP REST API search
  try {
    const searchUrl = `${PAHE_BASE}/wp-json/wp/v2/posts?search=${encodeURIComponent(info.title)}&per_page=5`;
    const posts = await fetchJson(searchUrl);
    if (Array.isArray(posts)) {
      for (const post of posts) {
        if (post.title?.rendered?.toLowerCase().includes(info.title.toLowerCase())) {
          const postHtml = await fetchText(post.link);
          if (postHtml && postHtml.includes('box download')) {
            const links = extractDownloadLinks(postHtml);
            for (const l of links) {
              l.title = displayTitle;
              l.description = `${l.quality} ${l.size}`;
            }
            if (links.length > 0) return links;
          }
        }
      }
    }
  } catch {}

  return [];
}

module.exports = { getStreams };
