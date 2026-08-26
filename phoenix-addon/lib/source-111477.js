/**
 * lib/source-111477.js — Direct HTTPS streams from a.111477.xyz directory listings
 *
 * KEY INSIGHT (learned from sootio-stremio-addon):
 *   - a.111477.xyz is the directory listing host (Cloudflare-protected, for scraping only)
 *   - p.111477.xyz/bulk?u=<url> is the streaming CDN host (NOT CF-protected)
 *   - Nuvio app's player fetches p.111477.xyz/bulk directly and plays it
 *   - Browsers can't (CORS), but Nuvio/Stremio desktop CAN
 *
 * Directory layout:
 *   /movies/<Movie Title>/        — folder containing .mkv/.mp4
 *   /tvs/<Series Title>/          — folder containing Season NN/ folders
 *   /tvs/<Series Title>/Season 01/Episode.NN.mkv
 *
 * Search strategy: deterministic URL build, then index fallback
 */

const cheerio = require('cheerio');
const { fetch } = require('./fetcher');
const { getMeta } = require('./meta');

const BASE_URL = (process.env.HTTP_111477_BASE_URL || 'https://a.111477.xyz').replace(/\/+$/, '');
const BULK_BASE_URL = (process.env.HTTP_111477_BULK_BASE_URL || 'https://p.111477.xyz/bulk').replace(/\/+$/, '');

const DIRECTORY_CACHE_TTL = 10 * 60 * 1000;
const INDEX_CACHE_TTL = 30 * 60 * 1000;
const directoryCache = new Map();
const indexCache = new Map();

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|webm|ts|m2ts|m4v|mpg|mpeg)$/i;

function compact(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function normalizeUrl(href, base = BASE_URL) {
  if (!href) return null;
  try { return new URL(href, base).toString(); } catch { return null; }
}

function buildTitleVariants(title) {
  const base = compact(title).replace(/[\/\\]/g, ' ').replace(/\s+/g, ' ');
  if (!base) return [];
  const v = new Set([base]);
  if (base.includes(':')) {
    v.add(compact(base.replace(/\s*:\s*/g, ' - ')));
    v.add(compact(base.replace(/\s*:\s*/g, ' ')));
  }
  if (/[–—]/.test(base)) v.add(compact(base.replace(/[–—]/g, '-')));
  if (base.includes('&')) v.add(compact(base.replace(/&/g, 'and')));
  if (base.includes("'")) v.add(compact(base.replace(/'/g, '')));
  return Array.from(v).filter(Boolean);
}

function parseListingEntries(html, pageUrl) {
  const $ = cheerio.load(html);
  const entries = [];
  const seen = new Set();

  function addEntry(href, name, sizeBytes) {
    if (!href || !name) return;
    // Skip parent/back links
    if (href === '../' || href === '/' || href === './') return;
    if (/back\s*to\s*index/i.test(name)) return;
    if (/^\.\.?\/?$/.test(href)) return;
    const url = normalizeUrl(href, pageUrl);
    if (!url) return;
    if (!url.startsWith(BASE_URL)) return;
    if (seen.has(url)) return;
    seen.add(url);
    entries.push({
      title: name, name, url,
      isDirectory: href.endsWith('/'),
      sizeBytes: sizeBytes || null
    });
  }

  // Try table rows first (richer metadata)
  $('tr[data-entry="true"], tr').each((_, row) => {
    const $row = $(row);
    const anchor = $row.find('td a').first();
    if (!anchor.length) return;
    const href = $row.attr('data-url') || anchor.attr('href') || '';
    const name = compact(anchor.text()) || compact($row.attr('data-name') || '');
    if (!name) return;
    const sizeText = compact($row.find('td.size').text() || $row.find('td:nth-child(2)').text());
    let sizeBytes = null;
    const sm = sizeText.match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
    if (sm) {
      const n = parseFloat(sm[1]);
      const u = sm[2].toUpperCase();
      sizeBytes = u === 'TB' ? n * 1024 ** 4 : u === 'GB' ? n * 1024 ** 3 :
                  u === 'MB' ? n * 1024 ** 2 : n * 1024;
    }
    addEntry(href, name, sizeBytes);
  });

  // Fallback: plain <a href> list (111477 uses this style)
  if (entries.length === 0) {
    $('a').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!href || href.startsWith('?') || href.startsWith('#')) return;
      const name = compact($(a).text());
      addEntry(href, name, null);
    });
  }
  return entries;
}

async function fetchListing(url, { cacheTtl = DIRECTORY_CACHE_TTL, cacheStore = directoryCache } = {}) {
  const cached = cacheStore.get(url);
  if (cached && Date.now() - cached.ts < cacheTtl) return cached.data;

  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'text/html' },
      timeout: 12000
    });
    const statusCode = response.status || 0;
    const html = response.data || '';
    const data = {
      statusCode,
      title: '',
      url,
      entries: statusCode === 200 ? parseListingEntries(html, url) : []
    };
    cacheStore.set(url, { ts: Date.now(), data });
    return data;
  } catch (err) {
    const data = { statusCode: 0, title: '', url, entries: [] };
    cacheStore.set(url, { ts: Date.now(), data });
    return data;
  }
}

function buildBulkUrl(sourceUrl) {
  try {
    const u = new URL(BULK_BASE_URL);
    u.searchParams.set('u', sourceUrl);
    return u.toString();
  } catch {
    return `${BULK_BASE_URL}?u=${encodeURIComponent(sourceUrl)}`;
  }
}

function getResolutionFromName(name) {
  if (/2160p|4k|uhd/i.test(name)) return '2160p';
  if (/1080p|fhd/i.test(name)) return '1080p';
  if (/720p|hd/i.test(name)) return '720p';
  if (/480p|sd/i.test(name)) return '480p';
  return null;
}

function parseSeasonNumber(name) {
  const m = String(name).match(/\bSeason\s*0*(\d{1,2})\b/i) || String(name).match(/\bS0*(\d{1,2})\b/i);
  return m ? parseInt(m[1], 10) : null;
}

function matchesEpisodeFile(name, season, episode) {
  const s = Number(season), e = Number(episode);
  const patterns = [
    new RegExp(`\\bS0*${s}E0*${e}\\b`, 'i'),
    new RegExp(`\\b${s}x0*${e}\\b`, 'i'),
    new RegExp(`\\bEpisode\\s*0*${e}\\b`, 'i'),
    new RegExp(`\\bEp(?:isode)?\\.?\\s*0*${e}\\b`, 'i')
  ];
  return patterns.some(p => p.test(String(name || '')));
}

function rankFileEntries(entries) {
  const order = { '2160p': 5, '1080p': 4, '720p': 3, '540p': 2, '480p': 1 };
  return [...entries].sort((a, b) => {
    const ra = order[getResolutionFromName(a.name)] || 0;
    const rb = order[getResolutionFromName(b.name)] || 0;
    if (ra !== rb) return rb - ra;
    return (b.sizeBytes || 0) - (a.sizeBytes || 0);
  });
}

function formatSize(bytes) {
  if (!bytes) return null;
  if (bytes >= 1024 ** 4) return (bytes / 1024 ** 4).toFixed(2) + ' TB';
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + ' MB';
  return bytes + ' B';
}

/**
 * Main entry: build stream list for a movie/series ID.
 * Returns array of Stremio stream objects.
 */
async function get111477Streams(imdbId, type, season = null, episode = null) {
  const meta = await getMeta(imdbId, type);
  if (!meta?.name) return [];

  const section = type === 'series' ? 'tvs' : 'movies';
  const queries = Array.from(new Set([
    meta.name,
    meta.originalName,
    ...buildTitleVariants(meta.name),
    ...buildTitleVariants(meta.originalName || '')
  ].filter(Boolean)));

  // Try deterministic URL build first — try without year first since 111477
  // typically uses bare title folder names (e.g. /tvs/Breaking Bad/)
  let selectedListing = null;
  for (const q of queries) {
    const variants = [];
    variants.push(q);  // without year first — most common pattern
    if (meta.year) variants.push(`${q} (${meta.year})`);
    for (const v of variants) {
      const tryUrl = `${BASE_URL}/${section}/${encodeURIComponent(v)}/`;
      const listing = await fetchListing(tryUrl);
      if (listing.statusCode === 200 && listing.entries.length > 0) {
        selectedListing = { url: tryUrl, entries: listing.entries };
        break;
      }
    }
    if (selectedListing) break;
  }

  // Fallback: index page crawl
  if (!selectedListing) {
    const indexUrl = `${BASE_URL}/${section}/`;
    const indexListing = await fetchListing(indexUrl, {
      cacheTtl: INDEX_CACHE_TTL, cacheStore: indexCache
    });
    if (indexListing.entries.length > 0) {
      const lowered = queries.map(q => q.toLowerCase());
      const matches = indexListing.entries.filter(e =>
        lowered.some(q => e.title.toLowerCase().includes(q))
      );
      if (matches.length > 0) {
        // Pick best match — load its listing
        for (const m of matches.slice(0, 3)) {
          if (!m.isDirectory) continue;
          const subListing = await fetchListing(m.url);
          if (subListing.entries.length > 0) {
            selectedListing = { url: m.url, entries: subListing.entries };
            break;
          }
        }
      }
    }
  }

  if (!selectedListing) return [];

  let fileEntries = selectedListing.entries.filter(e => !e.isDirectory && VIDEO_EXT.test(e.name));

  // For series: descend into Season NN folders
  if (type === 'series' && season != null) {
    const seasonDirs = selectedListing.entries.filter(e =>
      e.isDirectory && parseSeasonNumber(e.name) === Number(season)
    );
    if (seasonDirs.length > 0) {
      const subListings = await Promise.all(seasonDirs.map(d => fetchListing(d.url)));
      fileEntries = subListings.flatMap(l =>
        l.entries.filter(e => !e.isDirectory && VIDEO_EXT.test(e.name))
      );
    }
    if (episode != null) {
      fileEntries = fileEntries.filter(e => matchesEpisodeFile(e.name, season, episode));
    }
  }

  if (fileEntries.length === 0) return [];

  const ranked = rankFileEntries(fileEntries).slice(0, 15);

  return ranked.map(entry => {
    const res = getResolutionFromName(entry.name) || 'auto';
    const sizeStr = formatSize(entry.sizeBytes);
    const bulkUrl = buildBulkUrl(entry.url);
    const titleLines = [entry.name];
    if (sizeStr) titleLines.push(`💾 ${sizeStr} | 111477`);
    else titleLines.push('🔗 111477');
    return {
      name: `PhoeniX\n${res}`,
      title: titleLines.join('\n'),
      url: bulkUrl,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: 'phoenix-111477',
        ...(entry.sizeBytes && { videoSize: entry.sizeBytes }),
        fileName: entry.name,
        // Nuvio's player will fetch p.111477.xyz/bulk directly; no extra headers needed
        // because p.111477.xyz is the streaming CDN, not a CF-protected page.
      }
    };
  });
}

module.exports = { get111477Streams, buildBulkUrl, fetchListing, parseListingEntries };
