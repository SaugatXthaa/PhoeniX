// HDHub4u (new5.hdhub4u.cl + 4khdhub.one) — Standalone Scraper
// =========================================================================
// Returns direct playable download links (MKV/GDrive) up to 4K.
//
// FLOW:
//   1. Search: new5.hdhub4u.cl/?s={title} + 4khdhub.one/?s={title}
//   2. Movie page → find hubcloud.cx/drive/{id} + hubcdn.sbs/file/{id} links
//   3. Resolve hubcloud → gamerxyt.com → GDrive (lh3.googleusercontent.com)
//   4. Resolve hubcdn → base64 decode → GDrive URL
//
// USAGE:
//   const hh = require('./hdhub4u_all_in_one.js');
//   const streams = await hh.getStreams('27205', 'movie');
//
// CLI:
//   node hdhub4u_all_in_one.js 27205 movie

'use strict';

const PROVIDER_NAME = 'HDHub4u';
const ORIGIN = 'https://new5.hdhub4u.cl';
const ORIGIN_4K = 'https://4khdhub.one';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// got-scraping helper for Cloudflare bypass
let _gotScraping = null;
async function loadGotScraping() {
  if (_gotScraping !== null) return _gotScraping;
  try { const mod = await import('got-scraping'); _gotScraping = mod.gotScraping || mod.default || mod.got; }
  catch (e) { _gotScraping = false; }
  return _gotScraping;
}

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

async function getTMDBInfo(tmdbId, type) {
  const url = 'https://api.themoviedb.org/3/' + (type === 'tv' ? 'tv' : 'movie') + '/' + tmdbId + '?api_key=' + TMDB_API_KEY;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('TMDB HTTP ' + res.status);
  const j = await res.json();
  return { title: j.name || j.title || 'Unknown', year: (j.first_air_date || j.release_date || '').slice(0, 4), type, tmdbId: String(tmdbId) };
}

// ---------------------------------------------------------------------------
// Search via sitemaps (the ?s= search redirects to homepage, so use sitemaps)
// ---------------------------------------------------------------------------
async function searchSite(title) {
  const results = [];
  const titleWords = title.toLowerCase().split(' ').filter(w => w.length > 2);
  const firstWord = title.toLowerCase().split(' ')[0];

  // Search HDHub4u sitemaps (post-sitemap1.xml through post-sitemap15.xml)
  for (let i = 1; i <= 15; i++) {
    try {
      const xml = await fetchText(ORIGIN + '/post-sitemap' + (i === 1 ? '' : i) + '.xml', null, 8000);
      // Find URLs containing the title
      const urls = [...xml.matchAll(/<loc>(https:\/\/new5\.hdhub4u\.cl\/([a-z0-9-]+)\/?)<\/loc>/g)];
      for (const m of urls) {
        const slug = m[2];
        if (slug.match(/^(category|tag|page|wp-|feed|comment|search|author|disclaimer|dmca|privacy|contact|about|how-to|join|request|xmlrpc)/)) continue;
        if (slug.toLowerCase().includes(firstWord)) {
          results.push({ url: m[1], slug, site: 'hdhub4u' });
        }
      }
      if (results.length > 0) break; // Found, stop searching
    } catch (e) { /* try next sitemap */ }
  }

  // Search 4K sister site sitemap
  try {
    const xml = await fetchText(ORIGIN_4K + '/sitemap.xml', null, 8000);
    const sitemaps = [...xml.matchAll(/<loc>(https:\/\/4khdhub\.one\/[^<]+)<\/loc>/g)];
    for (const sm of sitemaps.slice(0, 5)) {
      try {
        const subXml = await fetchText(sm[1], null, 8000);
        const urls = [...subXml.matchAll(/<loc>(https:\/\/4khdhub\.one\/([a-z0-9-]+)\/?)<\/loc>/g)];
        for (const m of urls) {
          const slug = m[2];
          if (slug.match(/^(category|tag|page|wp-|feed|comment|search|author|disclaimer|dmca|privacy|contact|about|how-to|join|request|xmlrpc)/)) continue;
          if (slug.toLowerCase().includes(firstWord)) {
            results.push({ url: m[1], slug, site: '4khdhub' });
          }
        }
        if (results.some(r => r.site === '4khdhub')) break;
      } catch (e) {}
    }
  } catch (e) {}

  return results;
}

// ---------------------------------------------------------------------------
// Parse movie page for download links with quality labels
// Returns: [{ quality, url, fileId, type }]
// ---------------------------------------------------------------------------
function parseDownloadLinks(html) {
  const links = [];

  // Find quality headings (h2/h3/h4) followed by download links
  // Pattern: <h3>1080p</h3> ... <a href="hubcloud...">
  const sections = html.split(/<h[234][^>]*>/i);
  for (const section of sections) {
    const qMatch = section.match(/(2160p|1080p|720p|480p|4K)/i);
    const quality = qMatch ? qMatch[0].toLowerCase() : null;

    // Find hubcloud links in this section
    const hubMatches = [...section.matchAll(/href="(https:\/\/hubcloud\.[a-z]+\/drive\/([a-z0-9]+))"/g)];
    for (const m of hubMatches) {
      links.push({ quality: quality || '?', url: m[1], fileId: m[2], type: 'hubcloud' });
    }

    // Find hubcdn.sbs links
    const hubcdnMatches = [...section.matchAll(/href="(https:\/\/hubcdn\.sbs\/file\/([A-Za-z0-9]+))"/g)];
    for (const m of hubcdnMatches) {
      links.push({ quality: quality || '?', url: m[1], fileId: m[2], type: 'hubcdn' });
    }

    // Find gdflix links
    const gdMatches = [...section.matchAll(/href="(https:\/\/(?:new\d+\.)?gdflix\.[a-z]+\/file\/([A-Za-z0-9]+))"/g)];
    for (const m of gdMatches) {
      links.push({ quality: quality || '?', url: m[1], fileId: m[2], type: 'gdflix' });
    }
    // Find hdstream4u.com links (HLS streams)
    const hdsMatches = [...section.matchAll(/href="(https:\/\/hdstream4u\.com\/file\/([A-Za-z0-9]+))"/g)];
    for (const m of hdsMatches) {
      links.push({ quality: quality || '?', url: m[1], fileId: m[2], type: 'hdstream4u' });
    }

    // Find hubstream.art links
    const hsMatches = [...section.matchAll(/href="(https:\/\/hubstream\.art\/#([A-Za-z0-9]+))"/g)];
    for (const m of hsMatches) {
      links.push({ quality: quality || '?', url: m[1], fileId: m[2], type: 'hubstream' });
    }
  }

  // If no sections found, try finding all links with quality from context
  if (links.length === 0) {
    const allHub = [...html.matchAll(/href="(https:\/\/hubcloud\.[a-z]+\/(?:drive|video)\/([a-z0-9_]+))"/g)];
    for (const m of allHub) {
      const idx = html.indexOf(m[1]);
      const context = html.slice(Math.max(0, idx - 500), idx + 200);
      const qMatch = context.match(/(2160p|1080p|720p|480p|4K)/i);
      links.push({ quality: qMatch ? qMatch[0].toLowerCase() : '?', url: m[1], fileId: m[2], type: 'hubcloud' });
    }
    const allHubcdn = [...html.matchAll(/href="(https:\/\/hubcdn\.sbs\/file\/([A-Za-z0-9]+))"/g)];
    for (const m of allHubcdn) {
      const idx = html.indexOf(m[1]);
      const context = html.slice(Math.max(0, idx - 500), idx + 200);
      const qMatch = context.match(/(2160p|1080p|720p|480p|4K)/i);
      links.push({ quality: qMatch ? qMatch[0].toLowerCase() : '?', url: m[1], fileId: m[2], type: 'hubcdn' });
    }
    const allHds = [...html.matchAll(/href="(https:\/\/hdstream4u\.com\/file\/([A-Za-z0-9]+))"/g)];
    for (const m of allHds) {
      const idx = html.indexOf(m[1]);
      const context = html.slice(Math.max(0, idx - 500), idx + 200);
      const qMatch = context.match(/(2160p|1080p|720p|480p|4K)/i);
      links.push({ quality: qMatch ? qMatch[0].toLowerCase() : '?', url: m[1], fileId: m[2], type: 'hdstream4u' });
    }
  }

  // Dedupe by URL
  const seen = new Set();
  return links.filter(l => { if (seen.has(l.url)) return false; seen.add(l.url); return true; });
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

// ---------------------------------------------------------------------------
// Resolve hubcdn.sbs/file/{id} → inventoryidea.com → base64 decode → GDrive URL
// ---------------------------------------------------------------------------
async function resolveHubcdn(hubcdnUrl) {
  try {
    const html = await fetchText(hubcdnUrl, 'https://hubcdn.sbs/');
    // Find inventoryidea.com URL with base64-encoded redirect
    const invMatches = [...html.matchAll(/inventoryidea\.com\/\?r=([A-Za-z0-9+/=]+)/g)];
    for (const m of invMatches) {
      try {
        const decoded = Buffer.from(m[1], 'base64').toString('utf8');
        // The decoded URL contains hubcdn.sbs/dl/?link=<GDrive URL>
        const gdMatch = decoded.match(/link=(https:\/\/video-downloads\.googleusercontent\.com\/[^&\s]+)/);
        if (gdMatch) return gdMatch[1];
        const lh3Match = decoded.match(/(https:\/\/lh3\.googleusercontent\.com\/[^\s&]+)/);
        if (lh3Match) return lh3Match[1].split('=m')[0] + '=d';
      } catch (e) {}
    }
    // Fallback: find atob() calls
    const atobMatch = html.match(/atob\(["']([A-Za-z0-9+/=]+)["']\)/);
    if (atobMatch) {
      const decoded = Buffer.from(atobMatch[1], 'base64').toString('utf8');
      if (decoded.includes('googleusercontent')) return decoded;
    }
    return null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Resolve hdstream4u.com/file/{id} → unpack Dean-Edwards JS → HLS m3u8 URL
// ---------------------------------------------------------------------------
async function resolveHdstream4u(hdstreamUrl) {
  try {
    const html = await fetchText(hdstreamUrl, 'https://hdstream4u.com/');
    // Find Dean-Edwards packed JS
    const match = html.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)\)\)/);
    if (!match) return null;

    const p = match[1], a = parseInt(match[2]), c = parseInt(match[3]), keys = match[4].split('|');

    function baseN(num, base) {
      if (num === 0) return '0';
      const chars = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
      let out = '';
      while (num > 0) { out = chars[num % base] + out; num = Math.floor(num / base); }
      return out;
    }

    // Unpack
    let result = p;
    for (let i = 0; i < c; i++) {
      const token = baseN(i, a);
      if (keys[i]) {
        result = result.replace(new RegExp('\\b' + token + '\\b', 'g'), keys[i]);
      }
    }

    // Find m3u8 URL
    const m3u8Match = result.match(/https:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
    if (m3u8Match) return m3u8Match[0];

    // Find links.hls2
    const hlsMatch = result.match(/links\.hls[0-9]?\s*=\s*["']([^"']+)/);
    if (hlsMatch) return hlsMatch[1];

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

function buildStream(opts) {
  const s = {
    name: PROVIDER_NAME + ' - ' + opts.quality.toUpperCase() + (opts.is4K ? ' 4K' : ''),
    title: opts.title,
    url: opts.url,
    quality: opts.quality === '4k' ? '2160p' : opts.quality,
    type: opts.mimeType || 'video/x-matroska',
    behaviorHints: { bingeGroup: opts.bingeGroup || ('hdhub4u-' + opts.quality) },
  };
  if (opts.filename) s.behaviorHints.filename = opts.filename;
  if (opts.url.includes('googleusercontent')) {
    s.behaviorHints.proxyHeaders = { request: { 'User-Agent': UA } };
  }
  return s;
}

async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  console.log('[HDHub4u] Request: tmdb=' + tmdbId + ' type=' + type);

  let info;
  try {
    info = await Promise.race([
      getTMDBInfo(tmdbId, type),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TMDB timeout')), 10000)),
    ]);
  } catch (e) { console.log('[HDHub4u] TMDB error: ' + e.message); return []; }
  console.log('[HDHub4u] TMDB: ' + info.title + (info.year ? ' (' + info.year + ')' : ''));

  const results = await searchSite(info.title);
  if (results.length === 0) { console.log('[HDHub4u] No results'); return []; }
  console.log('[HDHub4u] Found ' + results.length + ' results');

  const allStreams = [];
  const seen = new Set();

  for (const result of results.slice(0, 3)) {
    console.log('[HDHub4u] Checking: ' + result.slug + ' (' + result.site + ')');
    let movieHtml;
    try { movieHtml = await fetchText(result.url); }
    catch (e) { console.log('[HDHub4u] Fetch failed: ' + e.message); continue; }

    const links = parseDownloadLinks(movieHtml);
    console.log('[HDHub4u] Found ' + links.length + ' download links on ' + result.site);

    for (const link of links) {
      try {
        let resolved = null;
        let mimeType = 'video/x-matroska';

        if (link.type === 'hubcloud') {
          resolved = await resolveHubcloudDrive(link.url);
        } else if (link.type === 'hubcdn') {
          resolved = await resolveHubcdn(link.url);
        } else if (link.type === 'gdflix') {
          const r = await resolveGdflix(link.url);
          if (r) { resolved = r.url; mimeType = r.type === 'zip' ? 'application/zip' : 'video/x-matroska'; }
        } else if (link.type === 'hdstream4u') {
          // HLS stream via Dean-Edwards packed JS
          resolved = await resolveHdstream4u(link.url);
          if (resolved) mimeType = 'application/vnd.apple.mpegurl'; // HLS
        }

        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          const is4K = link.quality === '2160p' || link.quality === '4k';
          allStreams.push(buildStream({
            quality: link.quality,
            title: info.title + ' [HDHub4u ' + link.quality.toUpperCase() + (result.site === '4khdhub' ? ' 4K' : '') + ']',
            url: resolved, mimeType, is4K,
            bingeGroup: 'hdhub4u-' + link.quality + '-' + link.fileId,
          }));
          console.log('[HDHub4u] + ' + link.quality + ': ' + resolved.slice(0, 80));
        }
      } catch (e) { /* skip */ }
    }
  }

  const qOrder = { '2160p': 0, '4k': 0, '1080p': 1, '720p': 2, '480p': 3 };
  allStreams.sort((a, b) => (qOrder[a.quality] || 99) - (qOrder[b.quality] || 99));

  console.log('[HDHub4u] ' + allStreams.length + ' streams total');
  return allStreams;
}

module.exports = {
  getStreams, getTMDBInfo, searchSite, parseDownloadLinks,
  resolveHubcloudDrive, resolveHubcdn, resolveHdstream4u, resolveGdflix,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) { console.log('Usage: node hdhub4u_all_in_one.js <tmdbId> <movie|tv> [season] [episode]'); process.exit(1); }
  getStreams(args[0], args[1], args[2] ? parseInt(args[2]) : null, args[3] ? parseInt(args[3]) : null)
    .then(s => { console.log('\n=== Final streams ==='); s.forEach((x, i) => console.log((i+1) + '. ' + x.name + ' | ' + x.quality + ' | ' + x.url.slice(0,100))); console.log('\nTotal: ' + s.length); })
    .catch(e => console.error('FATAL: ' + e.stack));
}
