// MoviesDrive (new3.moviesdrive.christmas) — Standalone Scraper
// =========================================================================
// Returns direct playable download links (MKV/GDrive) up to 4K.
//
// FLOW:
//   1. Search: WP REST API /wp-json/wp/v2/posts?search={title}
//   2. Movie page → find hubcloud.foo/drive/search-recover.php?from_ac=...&q=...
//   3. Decode base64 q param → get quality (e.g. "Inception 2010 1080p")
//   4. HubCloud API: ?api=search&q={query}&from_ac={token} → file list
//   5. Resolve each hubcloud.cx/drive/{id} → gamerxyt → GDrive
//
// USAGE:
//   const md = require('./moviesdrive_all_in_one.js');
//   const streams = await md.getStreams('27205', 'movie');
//
// CLI:
//   node moviesdrive_all_in_one.js 27205 movie

'use strict';

const PROVIDER_NAME = 'MoviesDrive';
const ORIGIN = 'https://new3.moviesdrive.christmas';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchText(url, referer, timeout) {
  const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*' };
  if (referer) headers['Referer'] = referer;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeout || 15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function getTMDBInfo(tmdbId, type) {
  const url = 'https://api.themoviedb.org/3/' + (type === 'tv' ? 'tv' : 'movie') + '/' + tmdbId + '?api_key=' + TMDB_API_KEY;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('TMDB HTTP ' + res.status);
  const j = await res.json();
  return { title: j.name || j.title || 'Unknown', year: (j.first_air_date || j.release_date || '').slice(0, 4), type, tmdbId: String(tmdbId) };
}

// ---------------------------------------------------------------------------
// Search via WP REST API
// ---------------------------------------------------------------------------
async function searchSite(title) {
  try {
    const body = await fetchText(ORIGIN + '/wp-json/wp/v2/posts?search=' + encodeURIComponent(title) + '&_fields=link,title,slug&per_page=10');
    const posts = JSON.parse(body);
    return posts.map(p => ({ url: p.link, slug: p.slug, title: p.title?.rendered || '' }));
  } catch (e) { return []; }
}

// ---------------------------------------------------------------------------
// Parse movie page for hubcloud search-recover links
// Returns: [{ quality, fromAc, qB64, url }]
// ---------------------------------------------------------------------------
function parseDownloadLinks(html) {
  const links = [];
  // Match both &amp; and & in the URL
  const matches = [...html.matchAll(/href="(https:\/\/hubcloud\.[a-z]+\/drive\/search-recover\.php\?from_ac=([^&"'<]+)&(?:amp;)?q=([^"'<\s]+))"/g)];
  const seen = new Set();
  for (const m of matches) {
    const fromAc = m[2];
    const qB64 = m[3];
    if (seen.has(fromAc + qB64)) continue;
    seen.add(fromAc + qB64);
    let quality = '?';
    try {
      const decoded = Buffer.from(qB64 + '==', 'base64').toString('utf8');
      const qMatch = decoded.match(/(2160p|1080p|720p|480p|4K)/i);
      if (qMatch) quality = qMatch[0].toLowerCase();
    } catch (e) {}
    links.push({ quality, fromAc, qB64, url: m[1] });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Call HubCloud search API → get file list
// ---------------------------------------------------------------------------
async function resolveHubcloudSearch(fromAc, qB64) {
  try {
    const query = Buffer.from(qB64 + '==', 'base64').toString('utf8');
    const apiUrl = 'https://hubcloud.cx/drive/search-recover.php?api=search&q=' + encodeURIComponent(query) + '&page=1&from_ac=' + fromAc;
    const res = await fetch(apiUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.hits || []).map(h => ({ fileName: h.file_name, size: h.size, url: h.url, fileId: h.url.split('/').pop() }));
  } catch (e) { return []; }
}

// ---------------------------------------------------------------------------
// Resolve hubcloud.cx/drive/{id} → gamerxyt → GDrive URL
// ---------------------------------------------------------------------------
async function resolveHubcloudDrive(driveUrl) {
  try {
    const html = await fetchText(driveUrl, 'https://hubcloud.cx/');
    const gxMatch = html.match(/https:\/\/gamerxyt\.com\/hubcloud\.php\?[^"'\s]+/);
    if (!gxMatch) return null;
    const gxHtml = await fetchText(gxMatch[0], driveUrl);
    const gdMatch = gxHtml.match(/https:\/\/lh3\.googleusercontent\.com\/[^\s"'<>]+/);
    if (gdMatch) {
      let url = gdMatch[0].split('#')[0].split('=m')[0];
      return url + '=d';
    }
    const pdMatch = gxHtml.match(/https:\/\/pixeldrain\.[a-z]+\/u\/([A-Za-z0-9]+)/);
    if (pdMatch) return 'https://pixeldrain.com/api/file/' + pdMatch[1] + '?download';
    return null;
  } catch (e) { return null; }
}

function buildStream(opts) {
  const s = {
    name: PROVIDER_NAME + ' - ' + opts.quality.toUpperCase(),
    title: opts.title,
    url: opts.url,
    quality: opts.quality === '4k' ? '2160p' : opts.quality,
    type: 'video/x-matroska',
    behaviorHints: { bingeGroup: opts.bingeGroup || ('moviesdrive-' + opts.quality) },
  };
  if (opts.filename) s.behaviorHints.filename = opts.filename;
  if (opts.url.includes('googleusercontent')) {
    s.behaviorHints.proxyHeaders = { request: { 'User-Agent': UA } };
  }
  return s;
}

async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  console.log('[MoviesDrive] Request: tmdb=' + tmdbId + ' type=' + type);

  let info;
  try {
    info = await Promise.race([
      getTMDBInfo(tmdbId, type),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TMDB timeout')), 10000)),
    ]);
  } catch (e) { console.log('[MoviesDrive] TMDB error: ' + e.message); return []; }
  console.log('[MoviesDrive] TMDB: ' + info.title + (info.year ? ' (' + info.year + ')' : ''));

  const results = await searchSite(info.title);
  if (results.length === 0) { console.log('[MoviesDrive] No results'); return []; }

  // Pick best match — prefer exact title in slug
  let best = null;
  const titleLower = info.title.toLowerCase();
  const titleWords = titleLower.split(' ').filter(w => w.length > 2);
  for (const r of results) {
    const slugLower = (r.slug || '').toLowerCase();
    // Check if ALL significant words from the title are in the slug
    const allWordsMatch = titleWords.every(w => slugLower.includes(w));
    if (allWordsMatch) { best = r; break; }
  }
  // Fallback: first word match
  if (!best) {
    for (const r of results) {
      if ((r.slug || '').toLowerCase().includes(titleLower.split(' ')[0])) { best = r; break; }
    }
  }
  if (!best) best = results[0];
  console.log('[MoviesDrive] Match: ' + best.slug);

  let movieHtml;
  try { movieHtml = await fetchText(best.url); }
  catch (e) { console.log('[MoviesDrive] Movie page fetch failed: ' + e.message); return []; }

  const links = parseDownloadLinks(movieHtml);
  console.log('[MoviesDrive] Found ' + links.length + ' download links');

  const allStreams = [];
  const seenFileIds = new Set();

  for (const link of links) {
    try {
      const files = await resolveHubcloudSearch(link.fromAc, link.qB64);
      for (const file of files) {
        if (seenFileIds.has(file.fileId)) continue;
        const resolved = await resolveHubcloudDrive(file.url);
        if (resolved) {
          seenFileIds.add(file.fileId);
          const quality = (file.fileName.match(/(2160p|1080p|720p|480p|4K)/i)?.[0]?.toLowerCase()) || link.quality || '?';
          allStreams.push(buildStream({
            quality, title: info.title + ' [MoviesDrive ' + quality.toUpperCase() + '] ' + (file.size || ''),
            url: resolved, filename: file.fileName, bingeGroup: 'moviesdrive-' + quality + '-' + file.fileId,
          }));
          console.log('[MoviesDrive] + ' + quality + ' ' + (file.size || '') + ': ' + resolved.slice(0, 80));
        }
      }
    } catch (e) { /* skip */ }
  }

  const qOrder = { '2160p': 0, '4k': 0, '1080p': 1, '720p': 2, '480p': 3 };
  allStreams.sort((a, b) => (qOrder[a.quality] || 99) - (qOrder[b.quality] || 99));

  console.log('[MoviesDrive] ' + allStreams.length + ' streams total');
  return allStreams;
}

module.exports = {
  getStreams, getTMDBInfo, searchSite, parseDownloadLinks,
  resolveHubcloudSearch, resolveHubcloudDrive,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) { console.log('Usage: node moviesdrive_all_in_one.js <tmdbId> <movie|tv> [season] [episode]'); process.exit(1); }
  getStreams(args[0], args[1], args[2] ? parseInt(args[2]) : null, args[3] ? parseInt(args[3]) : null)
    .then(s => { console.log('\n=== Final streams ==='); s.forEach((x, i) => console.log((i+1) + '. ' + x.name + ' | ' + x.quality + ' | ' + x.url.slice(0,100))); console.log('\nTotal: ' + s.length); })
    .catch(e => console.error('FATAL: ' + e.stack));
}
