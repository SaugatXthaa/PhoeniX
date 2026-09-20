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
// Task 42: pixeldrain hosts ANY file type — a status-only HEAD ships 7GB
// season-pack ZIPs as "streams" (sweep-caught: Breaking.Bad.S05...zip).
// pdVideoOk demands video evidence (ct / Content-Disposition filename).
const { pdVideoOk } = require('../utils/streamGate.cjs');

// got-scraping helper for Cloudflare bypass (Chrome TLS fingerprint)
let _gotScraping = null;
async function loadGotScraping() {
  if (_gotScraping !== null) return _gotScraping;
  try { const mod = await import('got-scraping'); _gotScraping = mod.gotScraping || mod.default || mod.got; }
  catch (e) { _gotScraping = false; }
  return _gotScraping;
}

// Task 59: Fetcher transport injection (Task 57 hdhub4u_v2 pattern). The
// addon Fetcher is https.request family:4 with a built-in got-scraping
// fallback on 403/CF-challenge — plain pages skip got-scraping's browser-TLS
// CPU cost, which on Render 0.1 CPU made the abhilinks→hubcloud chain run
// 33-39s under true-cold contention (cut at the 35s cap → zero cards).
let _fetcher = null;
function setTransport(fetcher) { _fetcher = fetcher || null; }
const NEUTRAL_CTX = { config: {} };

async function fetchViaFetcher(url, headers, timeoutMs) {
  if (!_fetcher) return null;
  try {
    const t = await _fetcher.text(NEUTRAL_CTX, new URL(url), { timeout: timeoutMs || 15000, headers });
    return { kind: 'text', text: t };
  } catch (e) {
    const status = e?.statusCode || e?.status || 0;
    if (status >= 400) return { kind: 'error', status };
    return null; // network-level → caller fallback path
  }
}

// ---------------------------------------------------------------------------
async function fetchText(url, referer, timeout) {
  const headers = { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*' };
  if (referer) headers['Referer'] = referer;
  // Task 59: Fetcher first
  const fRes = await fetchViaFetcher(url, headers, timeout || 15000);
  if (fRes) {
    if (fRes.kind === 'text') return fRes.text;
    if (fRes.kind === 'error') throw new Error('HTTP ' + fRes.status);
  }
  // Try got-scraping first (Chrome TLS fingerprint)
  const gs = await loadGotScraping();
  if (gs) {
    try {
      // Task 53b: 10s/retry-0 → 15s/retry-1 — ALIGNED TO THE TRUE ORIGINAL
      // REPO (SaugatXthaa/PhoeniX fetchText). The tightened values zeroed
      // slow-but-alive fetches under Render contention.
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
  // Task 59: Fetcher first
  const fRes = await fetchViaFetcher(url, { 'User-Agent': UA }, 10000);
  if (fRes && fRes.kind === 'text') {
    const j = JSON.parse(fRes.text);
    return { title: j.name || j.title || 'Unknown', year: (j.first_air_date || j.release_date || '').slice(0, 4), type, tmdbId: String(tmdbId) };
  }
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('TMDB HTTP ' + res.status);
  const j = await res.json();
  return { title: j.name || j.title || 'Unknown', year: (j.first_air_date || j.release_date || '').slice(0, 4), type, tmdbId: String(tmdbId) };
}

// ---------------------------------------------------------------------------
// Search movieshunt.casa by title
// ---------------------------------------------------------------------------
async function searchSite(title) {
  // movieshunt.casa restructured its search: /?s={q} now 301s to a JS-rendered
  // /search.html?q={q} page backed by a JSON endpoint /lookup.php?q={q}&page=N
  // (verified live: { ok, hits: [{ id, post_title, permalink, ... }] }).
  // Post pages reached via hits[].permalink still carry abhilinks.site archives,
  // so only this search entry point needs to change. Legacy HTML parse kept as
  // a fallback in case the site reverts.
  try {
    const raw = await fetchText(ORIGIN + '/lookup.php?q=' + encodeURIComponent(title) + '&page=1', undefined, 14000);
    const j = JSON.parse(raw);
    const hits = Array.isArray(j && j.hits) ? j.hits : [];
    const results = [];
    const seen = new Set();
    // Match first word of title (strip non-alphanumeric chars like colons,
    // apostrophes, etc. — e.g. "Dune: Part Two" → firstWord "dune:" → "dune")
    const firstWord = title.toLowerCase().split(' ')[0].replace(/[^a-z0-9]/g, '');
    for (const hit of hits) {
      const permalink = typeof (hit && hit.permalink) === 'string' ? hit.permalink : '';
      if (!permalink) continue;
      const slug = permalink.replace(/^\/+|\/+$/g, '');
      if (!slug || seen.has(slug)) continue;
      if (slug.match(/^(category|tag|page|wp-|feed|comment|search|author|disclaimer|dmca|privacy|contact|about)/)) continue;
      if (firstWord && !slug.toLowerCase().includes(firstWord)) continue;
      seen.add(slug);
      results.push({ url: ORIGIN + '/' + slug + '/', slug });
    }
    if (results.length) return results;
  } catch (e) { /* fall through to legacy search */ }
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
// Size/codec/bit-depth from a quality label like "1080p [3.3GB]" / "1080p 10Bit HEVC [2.1GB]"
// (shared by the post-page context windows and the abhilinks archive headers)
// ---------------------------------------------------------------------------
function parseSizeToken(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?\s*(?:GB|MB))(?![a-z])/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}
function parseCodecToken(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('hevc') || t.includes('x265') || t.includes('h265') || t.includes('h.265')) return 'HEVC';
  if (t.includes('x264') || t.includes('h264') || t.includes('h.264') || t.includes('avc')) return 'x264';
  return null;
}
function parseBitDepthToken(text) {
  return /10\s*-?\s*bit/i.test(String(text || '')) ? '10-bit' : null;
}
function parseSourceTypeToken(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('remux')) return 'BluRay Remux';
  if (t.includes('bluray') || t.includes('bdrip') || t.includes('brrip')) return 'BluRay';
  if (t.includes('web-dl') || t.includes('webdl')) return 'WebDL';
  if (t.includes('webrip') || /\bweb\b/.test(t)) return 'WebRip';
  if (t.includes('hdrip')) return 'HDRip';
  if (t.includes('hdtv')) return 'HDTV';
  return null;
}
// Audio from the post title — real patterns: "{Hindi-English}",
// "Dual Audio [Hindi DD5.1 + English]", "Hindi ORG DD5.1", "[Hindi (ORG 2.0) + English]"
function parseAudioToken(postTitle) {
  const t = String(postTitle || '');
  const langs = [];
  const add = (name) => { if (name && !langs.includes(name)) langs.push(name); };
  if (/\bhindi\b|\bhin\b|\borg\b/i.test(t)) add('Hindi');
  if (/\benglish\b|\beng\b/i.test(t)) add('English');
  if (/\btamil\b/i.test(t)) add('Tamil');
  if (/\btelugu\b/i.test(t)) add('Telugu');
  if (/\bmalayalam\b/i.test(t)) add('Malayalam');
  if (/\bjapanese\b/i.test(t)) add('Japanese');
  if (/\bkorean\b/i.test(t)) add('Korean');
  return langs.length ? langs.join(' + ') : null;
}

// ---------------------------------------------------------------------------
// Parse movie page for download links (abhilinks + hubcloud + gdflix)
// Returns: [{ quality, url, type, archiveId?, fileId? }]
// ---------------------------------------------------------------------------
function parseDownloadLinks(html) {
  const links = [];

  // Task 53: season hint from the text around a link ("Season 2", "S02",
  // "S2 1080p"). Season-pack pages (e.g. "Season 1-8 Complete") list EVERY
  // season's archives; without this hint the resolver burned its whole
  // deadline resolving other seasons' 8-hop chains only for the episode
  // filter to discard them afterwards (measured: Game of Thrones S1E1 →
  // 0 streams forever on production). null = no explicit season in context.
  const seasonHintOf = (context) => {
    const m = context.match(/\bseason[ .:_\-]?(\d{1,2})\b/i) || context.match(/\bs(\d{1,2})\b(?=[ .:_)\-]|$)/i);
    return m ? m[1] : null;
  };

  // Post H1/title — site's own audio/source text for the whole post
  const h1Match = html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i);
  const postTitle = h1Match ? h1Match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';

  // Find abhilinks.site links with quality from nearby text
  const abhiMatches = [...html.matchAll(/href="(https:\/\/abhilinks\.site\/archives\/(\d+)\/?)"/g)];
  for (const m of abhiMatches) {
    const idx = html.indexOf(m[1]);
    const context = html.slice(Math.max(0, idx - 500), idx + 200);
    const qMatch = context.match(/(2160p|1080p|720p|480p|4K)/i);
    const quality = qMatch ? qMatch[0].toLowerCase() : '?';
    const size = parseSizeToken(context);
    links.push({ quality, url: m[1], archiveId: m[2], type: 'abhilinks', size, seasonHint: seasonHintOf(context) });
  }

  // Find direct hubcloud links (both /drive/ and /video/ paths)
  const hubMatches = [...html.matchAll(/href="(https:\/\/hubcloud\.[a-z]+\/(?:drive|video)\/([a-z0-9_]+))"/g)];
  for (const m of hubMatches) {
    const idx = html.indexOf(m[1]);
    const context = html.slice(Math.max(0, idx - 500), idx + 200);
    const qMatch = context.match(/(2160p|1080p|720p|480p|4K)/i);
    const quality = qMatch ? qMatch[0].toLowerCase() : '?';
    const size = parseSizeToken(context);
    links.push({ quality, url: m[1], fileId: m[2], type: 'hubcloud', size, seasonHint: seasonHintOf(context) });
  }

  // Find gdflix links
  const gdMatches = [...html.matchAll(/href="(https:\/\/(?:new\d+\.)?gdflix\.[a-z]+\/file\/([A-Za-z0-9]+))"/g)];
  for (const m of gdMatches) {
    const idx = html.indexOf(m[1]);
    const context = html.slice(Math.max(0, idx - 500), idx + 200);
    const qMatch = context.match(/(2160p|1080p|720p|480p|4K)/i);
    const quality = qMatch ? qMatch[0].toLowerCase() : '?';
    const size = parseSizeToken(context);
    links.push({ quality, url: m[1], fileId: m[2], type: 'gdflix', size, seasonHint: seasonHintOf(context) });
  }

  // Dedupe by URL
  const seen = new Set();
  return { links: links.filter(l => { if (seen.has(l.url)) return false; seen.add(l.url); return true; }), postTitle };
}

// ---------------------------------------------------------------------------
// Resolve abhilinks.site → hubcloud + gdflix links
// Each archive page lists SEVERAL quality files (e.g. 480p→2160p), each under
// its own header (<h4>1080p [3.3GB]</h4> before the button). Label every
// resolved link with the nearest preceding header quality, falling back to
// the quality the movieshunt page assigned to the abhilinks button.
// Season-pack archives list per-episode files behind "-:Episodes: N:-" style
// markers — capture that too so series requests can filter to the requested
// episode instead of flooding the player with every episode of the pack.
// Returns: [{ url, fileId, source, quality?, episode? }]
// ---------------------------------------------------------------------------
async function resolveAbhilinks(abhilinksUrl, fallbackQuality) {
  try {
    const html = await fetchText(abhilinksUrl, ORIGIN + '/');
    const links = [];
    const hub = [...html.matchAll(/href="(https:\/\/hubcloud\.[a-z]+\/(?:drive|video)\/([a-z0-9_]+))"/g)];
    for (const m of hub) {
      const before = html.slice(Math.max(0, m.index - 600), m.index);
      const qAll = [...before.matchAll(/(2160p|1080p|720p|480p|360p|4K)/gi)];
      let quality = fallbackQuality || null;
      if (qAll.length > 0) {
        const tok = qAll[qAll.length - 1][1].toLowerCase();
        quality = tok === '4k' ? '2160p' : tok;
      }
      // Episode marker: "-:Episodes: 1:-", "Episode 1", "Ep01", "E01" …
      const epAll = [...before.matchAll(/-:\s*Episodes?\s*:?\s*(\d+)\s*:-|(?:Episode|Ep?)\s*\.?\s*(\d{1,3})\b/gi)];
      let episode = null;
      for (const em of epAll) {
        const num = parseInt(em[1] || em[2], 10);
        if (num >= 1 && num <= 999) episode = num; // keep the LAST marker before the link
      }
      // Task 39: real per-file metadata from the archive header window
      // ("<h4>1080p [3.3GB]</h4>" / "1080p 10Bit HEVC [2.1GB]")
      links.push({
        url: m[1], fileId: m[2], source: 'hubcloud', quality, episode,
        size: parseSizeToken(before),
        codec: parseCodecToken(before),
        bitDepth: parseBitDepthToken(before),
      });
    }
    const gd = [...html.matchAll(/href="(https:\/\/(?:new\d+\.)?gdflix\.[a-z]+\/file\/([A-Za-z0-9]+))"/g)];
    for (const m of gd) links.push({ url: m[1], fileId: m[2], source: 'gdflix' });
    return links;
  } catch (e) { return []; }
}

// ---------------------------------------------------------------------------
// HEAD-liveness check — pixeldrain mirrors on hubcloud pages are frequently
// dead DMCA decoys (static href is dead while the real file is another ID)
// ---------------------------------------------------------------------------
async function headOk(url) {
  try {
    const gs = await loadGotScraping();
    if (!gs) return false;
    const res = await gs(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      timeout: { request: 4000 },
      throwHttpErrors: false,
      followRedirect: true,
    });
    return res.statusCode >= 200 && res.statusCode < 400;
  } catch (e) { return false; }
}

// Task 65: lh3.googleusercontent.com/pw/ hotlink-block classifier. Google
// answers datacenter egress with 403 + image/png (818B identity pixel) for
// links that are REAL files for the user's device IP — the MoviesDrive/
// UHDMovies class (Task 62) ships them and plays via the google-family
// 302-to-direct path. Only a hard miss (404/410/net-error) means dead.
async function lh3Playable(url) {
  try {
    const gs = await loadGotScraping();
    if (!gs) return true; // no probe transport → don't kill the card
    const res = await gs(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      timeout: { request: 4000 },
      throwHttpErrors: false,
      followRedirect: true,
    });
    if (res.statusCode >= 200 && res.statusCode < 400) return true;
    if (res.statusCode === 403 && /image\//i.test(String(res.headers['content-type'] || ''))) return true;
    return false;
  } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Follow pixel.hubcloud.cx redirect chain to the direct video URL.
// Chain: pixel.hubcloud.cx → 302 → pixel.<name>.workers.dev → 302 →
//        gamerxyt.com/dl.php?link=<video-downloads.googleusercontent URL>
// The raw pixel URL is NOT player-playable (it lands on an HTML page), so
// the chain must be followed server-side and the ?link= param extracted.
// ---------------------------------------------------------------------------
async function resolvePixelChain(pixelUrl) {
  const gs = await loadGotScraping();
  if (!gs) return null;
  let current = pixelUrl;
  for (let i = 0; i < 5; i++) {
    let res;
    try {
      res = await gs(current, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Referer': 'https://hubcloud.cx/' },
        timeout: { request: 8000 }, throwHttpErrors: false, followRedirect: false,
      });
    } catch (e) { return null; }
    const loc = res.headers.location || '';
    if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
      try { current = loc.startsWith('http') ? loc : new URL(loc, current).toString(); } catch (e) { return null; }
      continue;
    }
    if (res.statusCode === 200) {
      try {
        const u = new URL(current);
        if (u.hostname.includes('gamerxyt') && u.pathname.includes('dl.php')) {
          const link = u.searchParams.get('link');
          if (link && link.startsWith('http')) return link;
        }
      } catch (e) { /* not a URL */ }
      const body = typeof res.body === 'string' ? res.body : (res.body ? res.body.toString() : '');
      const vd = body.match(/https:\/\/video-downloads\.googleusercontent\.com\/[A-Za-z0-9_-]+/i);
      if (vd) return vd[0];
    }
    if (/workers\.dev|googleusercontent\.com/.test(current)) return current;
    return null;
  }
  return null;
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
      if (gdMatch) {
        let url = gdMatch[0].split('#')[0].split('=m')[0];
        const lh3Url = url + '=d';
        // lh3.googleusercontent.com/pw/ links are Google-hotlink-blocked from
        // many IPs (403 image/png identity pixel) — Task 65: the 403-image
        // verdict now SHIPS the card (real file for device IPs, played via
        // google-family 302-to-direct); only 404/410/net-dead drops it.
        if (await lh3Playable(lh3Url)) return lh3Url;
      }
      const pdMatch = gxHtml.match(/https:\/\/pixeldrain\.[a-z]+\/u\/([A-Za-z0-9]+)/);
      if (pdMatch) {
        const candidates = [...new Set([...gxHtml.matchAll(/https:\/\/pixeldrain\.[a-z]+\/u\/([A-Za-z0-9]+)/gi)].map(m => m[1]))];
        // Task 39: cap liveness probing — under resolver concurrency each 4s
        // HEAD inflates 2-3x and the probe tail was eating the whole race
        // Task 42: content-aware — a candidate only wins if it is a VIDEO file
        for (const pdId of candidates.slice(0, 3)) {
          const pdUrl = 'https://pixeldrain.com/api/file/' + pdId + '?download';
          if (await pdVideoOk(pdUrl)) return pdUrl;
        }
      }
    }
    // Try sportverse.cc (for /video/ path)
    const svMatch = html.match(/https:\/\/sportverse\.cc\/hubcloud\.php\?[^"'\s]+/);
    if (svMatch) {
      const svHtml = await fetchText(svMatch[0], driveUrl);
      const gdMatch2 = svHtml.match(/https:\/\/lh3\.googleusercontent\.com\/[^\s"'<>]+/);
      if (gdMatch2) {
        let url = gdMatch2[0].split('#')[0].split('=m')[0];
        const lh3Url = url + '=d';
        if (await lh3Playable(lh3Url)) return lh3Url;
      }
      // Find video-downloads URL
      const vdMatch = svHtml.match(/https:\/\/video-downloads\.googleusercontent\.com\/[^\s"'<>]+/);
      if (vdMatch) return vdMatch[0];
      // Find pixeldrain API download URL — Task 42: only ship VERIFIED videos
      const pdMatch = svHtml.match(/https:\/\/pixeldrain\.[a-z]+\/api\/file\/[A-Za-z0-9]+\?download/);
      if (pdMatch && await pdVideoOk(pdMatch[0])) return pdMatch[0];
      // Find R2 Cloudflare direct MKV URL (bucket form — never IP-blocked)
      const r2Match = svHtml.match(/https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com\/[^\s"'<>]+\.mkv[^\s"'<>]*/);
      if (r2Match) return r2Match[0];
      // Pixeldrain /u/ buttons — content-verify every candidate (DMCA decoys
      // are common AND some "files" are zip packs, not videos). Server-verified
      // alive-beats-a-dead-mirror, but only when the file is real video.
      const svPd = [...new Set([...svHtml.matchAll(/https:\/\/pixeldrain\.[a-z]+\/u\/([A-Za-z0-9]+)/gi)].map(m => m[1]))];
      for (const pdId of svPd.slice(0, 3)) {
        const pdUrl = 'https://pixeldrain.com/api/file/' + pdId + '?download';
        if (await pdVideoOk(pdUrl)) return pdUrl;
      }
      // pub-*.r2.dev form LAST: direct + Range-native, but Cloudflare blocks
      // datacenter ASNs by default (server-side 403 ≠ dead for real users),
      // so it is only used when nothing verifiable exists
      const r2Dev = svHtml.match(/https:\/\/pub-[a-z0-9]+\.r2\.dev\/[^\s"'<>]+\.mkv[^\s"'<>]*/);
      if (r2Dev) return r2Dev[0];
    }
    // Try pixel.hubcloud.cx — follow the chain to the direct video URL
    const pixelMatch = html.match(/https:\/\/pixel\.hubcloud\.[a-z]+\/\?id=[^"'\s]+/);
    if (pixelMatch) {
      const direct = await resolvePixelChain(pixelMatch[0]);
      if (direct) return direct;
      return pixelMatch[0]; // last resort — old behavior
    }
    return null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Resolve gdflix file → direct download URL
// ---------------------------------------------------------------------------
async function resolveGdflix(gdflixUrl) {
  try {
    const html = await fetchText(gdflixUrl);
    // 2026-09: gdflix.dev now 302s to new3.gdflix.io and the indexserver
    // subdomain rotates (max. → light. → …) — match ANY subdomain, and
    // HEAD-verify the file (some listing entries 404) before shipping.
    const idxCandidates = [...new Set([...html.matchAll(/https:\/\/[a-z0-9-]+\.indexserver\.site\/[^\s"'<>]+/g)].map(m => m[0]))];
    for (const idxUrl of idxCandidates) {
      if (await headOk(idxUrl)) return { url: idxUrl, type: 'zip' };
    }
    // R2 token link fallback — direct MKV, Range-native. Verified 206
    // video/mkv live (pub-*.r2.dev + ?token= form). HEAD-check to avoid
    // shipping expired-token URLs.
    const r2Candidates = [...new Set([...html.matchAll(/https:\/\/pub-[a-z0-9]+\.r2\.dev\/[^\s"'<>]+/g)].map(m => m[0]))];
    for (const r2Url of r2Candidates) {
      if (await headOk(r2Url)) return { url: r2Url, type: 'mkv' };
    }
    // NB: instant.busycdn.xyz ("DIRECT SERVER [MGT]") returns 500 JSON —
    // verified dead upstream, deliberately NOT shipped.
    return null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
function buildStream(opts) {
  const s = {
    name: PROVIDER_NAME + ' - ' + (opts.quality || 'Download').toUpperCase(),
    title: opts.title,
    url: opts.url,
    quality: opts.quality === '4k' ? '2160p' : opts.quality,
    type: opts.mimeType || 'video/x-matroska',
    behaviorHints: { bingeGroup: opts.bingeGroup || ('movieshunt-' + opts.quality) },
  };
  // Task 39: real metadata fields consumed by the wrapper — nothing here is
  // synthesized; absent values stay absent.
  if (opts.size) s.size = opts.size;
  if (opts.codec) s.codec = opts.codec;
  if (opts.sourceType) s.sourceType = opts.sourceType;
  if (opts.bitDepth) s.bitDepth = opts.bitDepth;
  if (opts.audio) s.audio = opts.audio;
  if (opts.filename) s.behaviorHints.filename = opts.filename;
  if (opts.url.includes('googleusercontent')) {
    s.behaviorHints.proxyHeaders = { request: { 'User-Agent': UA } };
  }
  return s;
}

// ---------------------------------------------------------------------------
// Bounded-concurrency map — resolution is upstream-fetch-bound (each link
// needs 2-4 sequential fetches), so serially walking 20+ links regularly
// exceeded the caller's time budget and the addon shipped ZERO streams.
// ---------------------------------------------------------------------------
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = null; }
    }
  }));
  return out;
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
  try { movieHtml = await fetchText(results[0].url, undefined, 14000); }
  catch (e) { console.log('[MoviesHunt] Movie page fetch failed: ' + e.message); return []; }

  // Parse download links — also grabs the post H1 (site's own audio/source text)
  const { links, postTitle } = parseDownloadLinks(movieHtml);
  console.log('[MoviesHunt] Found ' + links.length + ' download links');

  // Task 39: post-level metadata from the site's own title (e.g.
  // "Obsession (2026) WEB-DL Dual Audio [Hindi ORG DD5.1 + English] 1080p …")
  const postSource = parseSourceTypeToken(postTitle || results[0].slug.replace(/-/g, ' '));
  const postCodec = parseCodecToken(postTitle);
  const postBit = parseBitDepthToken(postTitle);
  const postAudio = parseAudioToken(postTitle || results[0].slug.replace(/-/g, ' '));

  const allStreams = [];
  const seenFileIds = new Set();

  // Resolve links concurrently (pool of 6); each link's hubcloud/gdflix subs
  // resolve with pool of 3. Serial resolution of 20+ links took 40s+ and hit
  // the caller's race timeout → zero streams shipped even though every link
  // was perfectly resolvable.
  // Streams are pushed into allStreams AS THEY COMPLETE, and the whole pool
  // is raced against a ~30s internal deadline — Task 39: under full-resolver
  // contention (Render 0.1-CPU) the chain inflates 2-3x (isolated 7.4s →
  // ~25s contended), and the old 22s race expired BEFORE anything completed,
  // so the background continuation cached 0 instead of its results. 30s lets
  // the late-but-real completion reach the 5-min cache (next request gets it
  // at ~0ms per the Task 36 warm-up contract); the client budget is untouched.
  // Task 53: TV — order links by season relevance BEFORE the 14-link slice.
  // Requested-season links first, unknown-season next, different-season last
  // (and sliced away). For "Season 1-8 Complete" pages this cuts resolution
  // work from 14 mostly-irrelevant chains to the few that carry S1 files.
  if (type === 'tv' && season != null) {
    const want = parseInt(season, 10);
    const rankOf = (l) => {
      if (l.seasonHint == null) return 1;
      return parseInt(l.seasonHint, 10) === want ? 0 : 2;
    };
    links.sort((a, b) => rankOf(a) - rankOf(b));
    if (links.some(l => rankOf(l) === 0)) {
      // keep only requested-season + unknown-hint links (hint page knows best)
      const keep = links.filter(l => rankOf(l) <= 1);
      console.log('[MoviesHunt] Season filter: ' + keep.length + '/' + links.length + ' links for season ' + want);
      links.length = 0;
      links.push(...keep);
    }
  }
  const linksToProcess = links.slice(0, 14);
  const resolveOneLink = async (link) => {
    const push = (s) => { if (s) allStreams.push(s); };
    try {
      if (link.type === 'abhilinks') {
        const subLinks = await resolveAbhilinks(link.url, link.quality);
        const subResults = await mapPool(subLinks, 3, async (sub) => {
          if (seenFileIds.has(sub.fileId)) return null;
          // Series: season-pack archives hold EVERY episode — keep only the
          // requested one (subs without a marker stay, defensively)
          if (type === 'tv' && episode != null && sub.episode != null && sub.episode !== parseInt(episode, 10)) return null;
          if (sub.source === 'hubcloud') {
            const resolved = await resolveHubcloudDrive(sub.url);
            if (!resolved) return null;
            seenFileIds.add(sub.fileId);
            const q = sub.quality || link.quality;
            return buildStream({
              quality: q, title: info.title + ' [MoviesHunt ' + String(q).toUpperCase() + ']',
              url: resolved, bingeGroup: 'movieshunt-' + q + '-' + sub.fileId,
              size: sub.size || link.size, codec: sub.codec || postCodec,
              sourceType: postSource, bitDepth: sub.bitDepth || postBit, audio: postAudio,
            });
          } else if (sub.source === 'gdflix') {
            const resolved = await resolveGdflix(sub.url);
            if (!resolved) return null;
            seenFileIds.add(sub.fileId);
            const q = sub.quality || link.quality;
            return buildStream({
              quality: q, title: info.title + ' [MoviesHunt ' + String(q).toUpperCase() + ' GDFlix]',
              url: resolved.url, bingeGroup: 'movieshunt-gdflix-' + sub.fileId,
              mimeType: resolved.type === 'zip' ? 'application/zip' : 'video/x-matroska',
              size: sub.size || link.size, codec: postCodec,
              sourceType: postSource, bitDepth: postBit, audio: postAudio,
            });
          }
          return null;
        });
        for (const r of subResults) push(r);
      } else if (link.type === 'hubcloud') {
        if (seenFileIds.has(link.fileId)) return;
        const resolved = await resolveHubcloudDrive(link.url);
        if (resolved) {
          seenFileIds.add(link.fileId);
          push(buildStream({
            quality: link.quality, title: info.title + ' [MoviesHunt ' + link.quality.toUpperCase() + ']',
            url: resolved, bingeGroup: 'movieshunt-' + link.quality + '-' + link.fileId,
            size: link.size, codec: postCodec,
            sourceType: postSource, bitDepth: postBit, audio: postAudio,
          }));
        }
      } else if (link.type === 'gdflix') {
        if (seenFileIds.has(link.fileId)) return;
        const resolved = await resolveGdflix(link.url);
        if (resolved) {
          seenFileIds.add(link.fileId);
          push(buildStream({
            quality: link.quality, title: info.title + ' [MoviesHunt ' + link.quality.toUpperCase() + ' GDFlix]',
            url: resolved.url, bingeGroup: 'movieshunt-gdflix-' + link.fileId,
            mimeType: resolved.type === 'zip' ? 'application/zip' : 'video/x-matroska',
            size: link.size, codec: postCodec,
            sourceType: postSource, bitDepth: postBit, audio: postAudio,
          }));
        }
      }
    } catch (e) { /* skip */ }
  };

  // Task 65: early-exit poll instead of a fixed 30s race. On Render the
  // season-pack chains (abhilinks page → matching-episode sub → hubcloud
  // resolve) can run 25-35s for the LAST link while the FIRST lands at
  // 12-18s — the fixed race discarded everything at 30s whenever the pool
  // was still mid-flight on a slow egress (production honest-zero for
  // series despite working chains). Now: return as soon as ≥2 streams are
  // in, when the pool settles, or at a 36s hard cap. The pool keeps running
  // in the background and extra late streams simply miss this snapshot.
  await new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearInterval(iv); resolve(); } };
    const iv = setInterval(() => {
      if (allStreams.length >= 2 || Date.now() - t0 > 36000) done();
    }, 500);
    mapPool(linksToProcess, 6, resolveOneLink).then(done, done);
  });

  // Dedupe identical final URLs (season-pack pages list the same file behind
  // many buttons — one playable entry is what the player wants)
  const seenUrls = new Set();
  const uniqueStreams = [];
  for (const s of allStreams) {
    if (!s || !s.url || seenUrls.has(s.url)) continue;
    seenUrls.add(s.url);
    uniqueStreams.push(s);
  }

  // Sort by quality
  const qOrder = { '2160p': 0, '4k': 0, '1080p': 1, '720p': 2, '480p': 3 };
  // NB: use ?? not || — the 2160p/4k rank is 0 (falsy) and || would demote
  // 4K to the "unknown" bucket, sorting it LAST instead of first
  uniqueStreams.sort((a, b) => (qOrder[a.quality] ?? 99) - (qOrder[b.quality] ?? 99));

  console.log('[MoviesHunt] ' + uniqueStreams.length + ' streams total');
  return uniqueStreams;
}

module.exports = {
  getStreams, getTMDBInfo, searchSite, parseDownloadLinks, setTransport,
  parseSizeToken, parseCodecToken, parseSourceTypeToken, parseAudioToken,
  resolveAbhilinks, resolveHubcloudDrive, resolveGdflix,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) { console.log('Usage: node movieshunt_all_in_one.js <tmdbId> <movie|tv> [season] [episode]'); process.exit(1); }
  getStreams(args[0], args[1], args[2] ? parseInt(args[2]) : null, args[3] ? parseInt(args[3]) : null)
    .then(s => { console.log('\n=== Final streams ==='); s.forEach((x, i) => console.log((i+1) + '. ' + x.name + ' | ' + x.quality + ' | ' + x.url.slice(0,100))); console.log('\nTotal: ' + s.length); })
    .catch(e => console.error('FATAL: ' + e.stack));
}
