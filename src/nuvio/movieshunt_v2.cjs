// MoviesHunt (movieshunt.casa) — Standalone Scraper
// =========================================================================
// Returns direct playable download links (MKV/GDrive) up to 4K.
//
// FLOW:
//   1. Search: https://movieshunt.casa/?s={title}
//   2. Movie page → find abhilinks.site/archives/{id} links with quality labels
//   3. Resolve abhilinks → hubcloud.cx/drive/{id} + gdflix.dev/file/{id}
//   4. Resolve hubcloud → gamerxyt.com → GDrive (lh3.googleusercontent.com)
//   5. Resolve gdflix → max.indexserver.site (direct ZIP download)
//
// USAGE:
//   const mh = require('./movieshunt_all_in_one.js');
//   const streams = await mh.getStreams('27205', 'movie');
//
// CLI:
//   node movieshunt_all_in_one.js 27205 movie

'use strict';

const PROVIDER_NAME = 'MoviesHunt';
const ORIGIN = 'https://movieshunt.casa';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// got-scraping helper for Cloudflare bypass (Chrome TLS fingerprint)
let _gotScraping = null;
async function loadGotScraping() {
  if (_gotScraping !== null) return _gotScraping;
  try { const mod = await import('got-scraping'); _gotScraping = mod.gotScraping || mod.default || mod.got; }
  catch (e) { _gotScraping = false; }
  return _gotScraping;
}

// ---------------------------------------------------------------------------
async function fetchText(url, referer, timeout) {
  const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*' };
  if (referer) headers['Referer'] = referer;
  // Try got-scraping first (Chrome TLS fingerprint)
  const gs = await loadGotScraping();
  if (gs) {
    try {
      const res = await gs({ url, headers, timeout: { request: timeout || 15000 }, retry: { limit: 1 } });
      if (res.statusCode >= 200 && res.statusCode < 400) return typeof res.body === 'string' ? res.body : res.body.toString();
    } catch (e) { /* fall through */ }
  }
  // Fallback: plain fetch
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeout || 15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// ---------------------------------------------------------------------------
async function getTMDBInfo(tmdbId, type) {
  const url = 'https://api.themoviedb.org/3/' + (type === 'tv' ? 'tv' : 'movie') + '/' + tmdbId + '?api_key=' + TMDB_API_KEY;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('TMDB HTTP ' + res.status);
  const j = await res.json();
  return { title: j.name || j.title || 'Unknown', year: (j.first_air_date || j.release_date || '').slice(0, 4), type, tmdbId: String(tmdbId) };
}

// ---------------------------------------------------------------------------
// Search movieshunt.casa by title
// ---------------------------------------------------------------------------
async function searchSite(title) {
  try {
    const html = await fetchText(ORIGIN + '/?s=' + encodeURIComponent(title));
    const links = [...html.matchAll(/href="(https:\/\/movieshunt\.casa\/([a-z0-9-]+)\/)"/g)];
    const results = [];
    const seen = new Set();
    for (const m of links) {
      const slug = m[2];
      if (slug.match(/^(category|tag|page|wp-|feed|comment|search|author|disclaimer|dmca|privacy|contact|about)/)) continue;
      if (seen.has(slug)) continue;
      seen.add(slug);
      // Match first word of title (strip non-alphanumeric chars like colons,
      // apostrophes, etc. — e.g. "Dune: Part Two" → firstWord "dune:" → "dune")
      const firstWord = title.toLowerCase().split(' ')[0].replace(/[^a-z0-9]/g, '');
      if (firstWord && slug.toLowerCase().includes(firstWord)) {
        results.push({ url: m[1], slug });
      }
    }
    return results;
  } catch (e) { return []; }
}

// ---------------------------------------------------------------------------
// Parse movie page for download links (abhilinks + hubcloud + gdflix)
// Returns: [{ quality, url, type, archiveId?, fileId? }]
// ---------------------------------------------------------------------------
function parseDownloadLinks(html) {
  const links = [];

  // Find abhilinks.site links with quality from nearby text
  const abhiMatches = [...html.matchAll(/href="(https:\/\/abhilinks\.site\/archives\/(\d+)\/?)"/g)];
  for (const m of abhiMatches) {
    const idx = html.indexOf(m[1]);
    const context = html.slice(Math.max(0, idx - 500), idx + 200);
    const qMatch = context.match(/(2160p|1080p|720p|480p|4K)/i);
    const quality = qMatch ? qMatch[0].toLowerCase() : '?';
    links.push({ quality, url: m[1], archiveId: m[2], type: 'abhilinks' });
  }

  // Find direct hubcloud links (both /drive/ and /video/ paths)
  const hubMatches = [...html.matchAll(/href="(https:\/\/hubcloud\.[a-z]+\/(?:drive|video)\/([a-z0-9_]+))"/g)];
  for (const m of hubMatches) {
    const idx = html.indexOf(m[1]);
    const context = html.slice(Math.max(0, idx - 500), idx + 200);
    const qMatch = context.match(/(2160p|1080p|720p|480p|4K)/i);
    const quality = qMatch ? qMatch[0].toLowerCase() : '?';
    links.push({ quality, url: m[1], fileId: m[2], type: 'hubcloud' });
  }

  // Find gdflix links
  const gdMatches = [...html.matchAll(/href="(https:\/\/(?:new\d+\.)?gdflix\.[a-z]+\/file\/([A-Za-z0-9]+))"/g)];
  for (const m of gdMatches) {
    const idx = html.indexOf(m[1]);
    const context = html.slice(Math.max(0, idx - 500), idx + 200);
    const qMatch = context.match(/(2160p|1080p|720p|480p|4K)/i);
    const quality = qMatch ? qMatch[0].toLowerCase() : '?';
    links.push({ quality, url: m[1], fileId: m[2], type: 'gdflix' });
  }

  // Dedupe by URL
  const seen = new Set();
  return links.filter(l => { if (seen.has(l.url)) return false; seen.add(l.url); return true; });
}

// ---------------------------------------------------------------------------
// Resolve abhilinks.site → hubcloud + gdflix links
// ---------------------------------------------------------------------------
async function resolveAbhilinks(abhilinksUrl) {
  try {
    const html = await fetchText(abhilinksUrl, ORIGIN + '/');
    const links = [];
    const hub = [...html.matchAll(/href="(https:\/\/hubcloud\.[a-z]+\/(?:drive|video)\/([a-z0-9_]+))"/g)];
    for (const m of hub) links.push({ url: m[1], fileId: m[2], source: 'hubcloud' });
    const gd = [...html.matchAll(/href="(https:\/\/(?:new\d+\.)?gdflix\.[a-z]+\/file\/([A-Za-z0-9]+))"/g)];
    for (const m of gd) links.push({ url: m[1], fileId: m[2], source: 'gdflix' });
    return links;
  } catch (e) { return []; }
}

// ---------------------------------------------------------------------------
// Resolve hubcloud.cx/{drive|video}/{id} → gamerxyt/sportverse → GDrive URL
// ---------------------------------------------------------------------------
async function resolveHubcloudDrive(driveUrl) {
  try {
    const html = await fetchText(driveUrl, 'https://hubcloud.cx/');
    // Try gamerxyt.com (for /drive/ path)
    const gxMatch = html.match(/https:\/\/gamerxyt\.com\/hubcloud\.php\?[^"'\s]+/);
    if (gxMatch) {
      const gxHtml = await fetchText(gxMatch[0], driveUrl);
      const gdMatch = gxHtml.match(/https:\/\/lh3\.googleusercontent\.com\/[^\s"'<>]+/);
      if (gdMatch) { let url = gdMatch[0].split('#')[0].split('=m')[0]; return url + '=d'; }
      const pdMatch = gxHtml.match(/https:\/\/pixeldrain\.[a-z]+\/u\/([A-Za-z0-9]+)/);
      if (pdMatch) return 'https://pixeldrain.com/api/file/' + pdMatch[1] + '?download';
    }
    // Try sportverse.cc (for /video/ path)
    const svMatch = html.match(/https:\/\/sportverse\.cc\/hubcloud\.php\?[^"'\s]+/);
    if (svMatch) {
      const svHtml = await fetchText(svMatch[0], driveUrl);
      // Find GDrive URL
      const gdMatch = svHtml.match(/https:\/\/lh3\.googleusercontent\.com\/[^\s"'<>]+/);
      if (gdMatch) { let url = gdMatch[0].split('#')[0].split('=m')[0]; return url + '=d'; }
      // Find video-downloads URL
      const vdMatch = svHtml.match(/https:\/\/video-downloads\.googleusercontent\.com\/[^\s"'<>]+/);
      if (vdMatch) return vdMatch[0];
      // Find pixeldrain API download URL
      const pdMatch = svHtml.match(/https:\/\/pixeldrain\.[a-z]+\/api\/file\/[A-Za-z0-9]+\?download/);
      if (pdMatch) return pdMatch[0];
      // Find R2 Cloudflare direct MKV URL
      const r2Match = svHtml.match(/https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com\/[^\s"'<>]+\.mkv[^\s"'<>]*/);
      if (r2Match) return r2Match[0];
    }
    // Try pixel.hubcloud.cx
    const pixelMatch = html.match(/https:\/\/pixel\.hubcloud\.[a-z]+\/\?id=[^"'\s]+/);
    if (pixelMatch) return pixelMatch[0];
    return null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Resolve gdflix file → direct download URL
// ---------------------------------------------------------------------------
async function resolveGdflix(gdflixUrl) {
  try {
    const html = await fetchText(gdflixUrl);
    const indexMatch = html.match(/https:\/\/max\.indexserver\.site\/[^\s"'<>]+/);
    if (indexMatch) return { url: indexMatch[0], type: 'zip' };
    return null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
function buildStream(opts) {
  const s = {
    name: PROVIDER_NAME + ' - ' + opts.quality.toUpperCase(),
    title: opts.title,
    url: opts.url,
    quality: opts.quality === '4k' ? '2160p' : opts.quality,
    type: opts.mimeType || 'video/x-matroska',
    behaviorHints: { bingeGroup: opts.bingeGroup || ('movieshunt-' + opts.quality) },
  };
  if (opts.filename) s.behaviorHints.filename = opts.filename;
  if (opts.url.includes('googleusercontent')) {
    s.behaviorHints.proxyHeaders = { request: { 'User-Agent': UA } };
  }
  return s;
}

// ---------------------------------------------------------------------------
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  console.log('[MoviesHunt] Request: tmdb=' + tmdbId + ' type=' + type);

  let info;
  try {
    info = await Promise.race([
      getTMDBInfo(tmdbId, type),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TMDB timeout')), 10000)),
    ]);
  } catch (e) { console.log('[MoviesHunt] TMDB error: ' + e.message); return []; }
  console.log('[MoviesHunt] TMDB: ' + info.title + (info.year ? ' (' + info.year + ')' : ''));

  // Search
  const results = await searchSite(info.title);
  if (results.length === 0) { console.log('[MoviesHunt] No results'); return []; }
  console.log('[MoviesHunt] Found ' + results.length + ' results, using: ' + results[0].slug);

  // Fetch movie page
  let movieHtml;
  try { movieHtml = await fetchText(results[0].url); }
  catch (e) { console.log('[MoviesHunt] Movie page fetch failed: ' + e.message); return []; }

  // Parse download links
  const links = parseDownloadLinks(movieHtml);
  console.log('[MoviesHunt] Found ' + links.length + ' download links');

  const allStreams = [];
  const seenFileIds = new Set();

  for (const link of links) {
    try {
      if (link.type === 'abhilinks') {
        const subLinks = await resolveAbhilinks(link.url);
        for (const sub of subLinks) {
          if (seenFileIds.has(sub.fileId)) continue;
          if (sub.source === 'hubcloud') {
            const resolved = await resolveHubcloudDrive(sub.url);
            if (resolved) {
              seenFileIds.add(sub.fileId);
              allStreams.push(buildStream({
                quality: link.quality, title: info.title + ' [MoviesHunt ' + link.quality.toUpperCase() + ']',
                url: resolved, bingeGroup: 'movieshunt-' + link.quality + '-' + sub.fileId,
              }));
              console.log('[MoviesHunt] + ' + link.quality + ': ' + resolved.slice(0, 80));
            }
          } else if (sub.source === 'gdflix') {
            const resolved = await resolveGdflix(sub.url);
            if (resolved) {
              seenFileIds.add(sub.fileId);
              allStreams.push(buildStream({
                quality: link.quality, title: info.title + ' [MoviesHunt ' + link.quality.toUpperCase() + ' GDFlix]',
                url: resolved.url, bingeGroup: 'movieshunt-gdflix-' + sub.fileId,
                mimeType: resolved.type === 'zip' ? 'application/zip' : 'video/x-matroska',
              }));
              console.log('[MoviesHunt] + GDFlix ' + link.quality + ': ' + resolved.url.slice(0, 80));
            }
          }
        }
      } else if (link.type === 'hubcloud') {
        if (seenFileIds.has(link.fileId)) continue;
        const resolved = await resolveHubcloudDrive(link.url);
        if (resolved) {
          seenFileIds.add(link.fileId);
          allStreams.push(buildStream({
            quality: link.quality, title: info.title + ' [MoviesHunt ' + link.quality.toUpperCase() + ']',
            url: resolved, bingeGroup: 'movieshunt-' + link.quality + '-' + link.fileId,
          }));
          console.log('[MoviesHunt] + ' + link.quality + ': ' + resolved.slice(0, 80));
        }
      } else if (link.type === 'gdflix') {
        if (seenFileIds.has(link.fileId)) continue;
        const resolved = await resolveGdflix(link.url);
        if (resolved) {
          seenFileIds.add(link.fileId);
          allStreams.push(buildStream({
            quality: link.quality, title: info.title + ' [MoviesHunt ' + link.quality.toUpperCase() + ' GDFlix]',
            url: resolved.url, bingeGroup: 'movieshunt-gdflix-' + link.fileId,
            mimeType: resolved.type === 'zip' ? 'application/zip' : 'video/x-matroska',
          }));
          console.log('[MoviesHunt] + GDFlix ' + link.quality + ': ' + resolved.url.slice(0, 80));
        }
      }
    } catch (e) { /* skip */ }
  }

  // Sort by quality
  const qOrder = { '2160p': 0, '4k': 0, '1080p': 1, '720p': 2, '480p': 3 };
  allStreams.sort((a, b) => (qOrder[a.quality] || 99) - (qOrder[b.quality] || 99));

  console.log('[MoviesHunt] ' + allStreams.length + ' streams total');
  return allStreams;
}

module.exports = {
  getStreams, getTMDBInfo, searchSite, parseDownloadLinks,
  resolveAbhilinks, resolveHubcloudDrive, resolveGdflix,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) { console.log('Usage: node movieshunt_all_in_one.js <tmdbId> <movie|tv> [season] [episode]'); process.exit(1); }
  getStreams(args[0], args[1], args[2] ? parseInt(args[2]) : null, args[3] ? parseInt(args[3]) : null)
    .then(s => { console.log('\n=== Final streams ==='); s.forEach((x, i) => console.log((i+1) + '. ' + x.name + ' | ' + x.quality + ' | ' + x.url.slice(0,100))); console.log('\nTotal: ' + s.length); })
    .catch(e => console.error('FATAL: ' + e.stack));
}
