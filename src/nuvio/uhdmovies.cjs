// src/nuvio/uhdmovies.cjs — Task 84 full rewrite (clean, deobfuscated)
//
// WHY A REWRITE: uhdmovies.my was rebuilt (Task 83 recheck evidence — post pages
// lost the unblockedgames gateway links + [size] tags the old parser keyed on,
// "5 matching post(s) → 0 release(s)" on prod AND sandbox). Code search shows no
// public resolver handles the new chain, so it was RE'd live from this repo:
//   scripts/task84_uhd_dump.mjs / task84_uhd_fullchain.mjs / task84_uhd_e2e.mjs
//
// THE NEW CHAIN (verified end-to-end 2026-09-23, Dune 2021 2160p 20.74GB @5.5s):
//   1. post page      -> anchors to en.thenaukriadda.in/?sid=<long b64> labelled
//                        "[ Hindi...5.1 English] x265- UHDMovies [ 20.74GB ]"
//   2. sid landing    -> GET ?sid= sets lp_ck_test cookie; page auto-POSTs a
//                        form#lp-land (_lp_http=<sid>)
//   3. decoy hop      -> POST _lp_http2/_lp_token/_lp_chain/_lp_hop_index to a
//                        decoy blog path on thenaukriadda.in -> full article page
//                        whose INLINE JS (plain text, no obfuscation) does:
//                          sc("lp-<key>","<zlib-b64 payload>",60)   [cookie]
//                          <a id="lp-btn-go" href="?lp_go=lp-<key>"> [reveal]
//   4. lp_go          -> GET ?lp_go=lp-<key> WITH cookie lp-<key>=<payload> ->
//                        meta-refresh to driveseed.org/r?key=..&id=..
//   5. driveseed      -> r?key page JS-replaces to /file/<id>; file page has an
//                        "Instant Download" anchor of one of two families:
//                        a) cdn.video-gen.xyz/<hex>::<md5>   (no query)
//                        b) cdn.video-plex.xyz/?url=<hex>
//   6. instant CDN    -> a) fetch w/ full browser headers + Referer ->
//                           302 -> video-seed.dev/?url=<REAL direct URL>
//                        b) POST https://<host>/api  keys=<hex>  -> {"url": ...}
//                        (the plain landing page without ?url= is a decoy; the
//                        browser-header fetch is what triggers the redirect)
//   7. FINAL          -> video-downloads.googleusercontent.com/... direct file
//                        (video/mkv, Range-supported; NO Referer wanted — the
//                        wrapper's NO_REFERER_HOSTS already routes these direct)
//
// The old "Session expired" wall reported during earlier recon was simply the
// missing JS-set lp-<key> cookie — no rewarded ad is involved in this variant.
// No captcha is solved and no ad is interacted with anywhere in this chain.

const SITE_SECRETS = require('../utils/site-secrets.cjs');

const PROVIDER_NAME = 'UHDMovies';
const DOMAIN_LIST_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
const FALLBACK_DOMAINS = ['https://uhdmovies.my', 'https://uhdmovies.autos'];
const TMDB_URL = 'https://api.themoviedb.org/3';
const TMDB_API_KEY = SITE_SECRETS.TMDB_PRIMARY;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'max-age=0',
  'Upgrade-Insecure-Requests': '1',
};
const FETCH_TIMEOUT_MS = 15000;       // per-HTTP-request cap (prod measured chains 3-8s/hop; 12s aborted 3/5 chains)
const CHAIN_TIMEOUT_MS = 20000;       // per-release multi-hop cap
const SWEEP_SOFT_MS = 22000;          // stop launching new chains after this
const MAX_POSTS = 2;                  // top-scoring posts to mine
const MAX_RELEASES = 5;               // sid chains to resolve in parallel

function log(m) { console.log(`[${PROVIDER_NAME}] ${m}`); }
function err(m) { console.error(`[${PROVIDER_NAME}] ${m}`); }

// ── HTTP session (cookie jar per chain — the lp hops are session-bound) ──────
function createSession() {
  const jar = {};
  function absorb(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  }
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  async function fetchDoc(url, opts = {}) {
    const headers = { ...BROWSER_HEADERS, ...(opts.headers || {}) };
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const init = { method: opts.method || 'GET', headers, signal: AbortSignal.timeout(opts.timeoutMs || FETCH_TIMEOUT_MS), redirect: opts.redirect || 'manual' };
    if (opts.body) { init.body = opts.body; }
    const res = await fetch(url, init);
    absorb(res);
    const body = res.status >= 300 && res.status < 400 ? '' : await res.text();
    return { status: res.status, location: res.headers.get('location'), body, finalUrl: res.url };
  }
  return { jar, fetchDoc };
}

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&').replace(/&#0*39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── TMDB metadata ────────────────────────────────────────────────────────────
// Task 84d: merged resolves burst 40+ sources at TMDB simultaneously —
// single-shot metadata fetches failed under that burst and the empty result
// hit the 60s negative cache every round (isolated probes always worked).
// Retry ×3 with backoff + key rotation breaks the loop.
async function tmdbGet(path) {
  const keys = [TMDB_API_KEY, SITE_SECRETS.TMDB_SECONDARY, SITE_SECRETS.TMDB_TERTIARY].filter(Boolean);
  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const res = await fetch(`${TMDB_URL}${path}${path.includes('?') ? '&' : '?'}api_key=${keys[i]}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) return await res.json();
      lastErr = new Error(`TMDB HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 250 * (i + 1)));
  }
  throw lastErr || new Error('TMDB failed');
}
async function fetchMetadata(tmdbId) {
  const j = await tmdbGet(`/movie/${tmdbId}`);
  return {
    title: j.title || j.original_title || '',
    originalTitle: j.original_title || '',
    year: String(j.release_date || '').slice(0, 4),
  };
}

// ── Domains (phisher98 list, 1h cache) ───────────────────────────────────────
let _domainCache = null;
let _domainCacheAt = 0;
async function domainCandidates() {
  if (_domainCache && Date.now() - _domainCacheAt < 3600000) return _domainCache;
  let domains = FALLBACK_DOMAINS.slice();
  try {
    const res = await fetch(DOMAIN_LIST_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const j = await res.json();
      if (j && j.UHDMovies) domains = [String(j.UHDMovies), ...domains];
    }
  } catch (e) { /* keep fallbacks */ }
  _domainCache = [...new Set(domains.map(d => d.replace(/\/+$/, '')))];
  _domainCacheAt = Date.now();
  return _domainCache;
}

// ── Search → post URLs (title+year scoring, ported from the old parser) ──────
function normalizeTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function findMoviesInSearch(html, meta) {
  const nTitle = normalizeTitle(meta.title);
  const nOrig = normalizeTitle(meta.originalTitle);
  const posts = [];
  const articles = String(html || '').match(/<article\b[^>]*>[\s\S]*?<\/article>/gi) || [];
  for (const art of articles) {
    const aM = art.match(/<a\b[^>]*>[\s\S]*?<\/a>/i); // first anchor = post link
    if (!aM) continue;
    const tag = aM[0];
    const href = (tag.match(/\bhref\s*=\s*"([^"]*)"/i) || [])[1] || (tag.match(/\bhref\s*=\s*'([^']*)'/i) || [])[1];
    const titleAttr = (tag.match(/\btitle\s*=\s*"([^"]*)"/i) || [])[1] || (tag.match(/\btitle\s*=\s*'([^']*)'/i) || [])[1] || '';
    const text = stripTags(titleAttr + ' ' + tag);
    if (!href || !text) continue;
    const nText = normalizeTitle(text);
    const yearM = text.match(/\b(19|20)\d{2}\b/);
    const year = yearM ? Number(yearM[0]) : null;
    const wantYear = meta.year ? Number(meta.year) : null;
    if (wantYear && year && Math.abs(year - wantYear) > 1) continue;
    if (/\bseason\b|\bs\d{1,2}\b/i.test(text)) continue;
    let score = 0;
    if (nTitle && nText.includes(nTitle)) score += 4;
    if (nOrig && nText.includes(nOrig)) score += 3;
    if (meta.year && nText.includes(String(meta.year))) score += 2;
    if (score >= 4) posts.push({ href, score });
  }
  posts.sort((a, b) => b.score - a.score);
  return [...new Set(posts.map(p => p.href))];
}

async function findMoviePages(meta) {
  const domains = await domainCandidates();
  for (const base of domains) {
    try {
      const s = createSession();
      // NOTE: /?s= 301s to /search/<q> on the new WordPress layout — must follow
      const res = await s.fetchDoc(`${base}/?s=${encodeURIComponent(meta.title)}`, { headers: { Referer: base + '/' }, redirect: 'follow' });
      if (res.status !== 200) continue;
      const found = findMoviesInSearch(res.body, meta).map(h => { try { return new URL(h, base).toString(); } catch { return null; } }).filter(Boolean);
      if (found.length) return found;
    } catch (e) { /* next domain */ }
  }
  return [];
}

// ── Release extraction (NEW page structure) ──────────────────────────────────
function parseQuality(label) {
  if (/\b2160p\b|\b4k\b|\buhd\b/i.test(label)) return '2160p';
  const m = label.match(/\b(1080|720|480)p\b/i);
  return m ? m[1] + 'p' : 'Unknown';
}
function parseSize(label) {
  const m = label.match(/\[\s*([\d.]+)\s*(GB|MB)\s*\]/i) || label.match(/([\d.]+)\s*(GB|MB)\s*\]/i);
  return m ? `${m[1]}${m[2].toUpperCase()}` : '';
}
// Long sids = per-release G-Drive buttons; short sids = category links.
const NAUKRI_ANCHOR = /<a\b[^>]+href="(https:\/\/en\.thenaukriadda\.in\/\?sid=([A-Za-z0-9+/=]{200,}))"[^>]*>([\s\S]*?)<\/a>/gi;
function extractReleases(html) {
  const releases = [];
  const seen = {};
  const body = String(html || '');
  NAUKRI_ANCHOR.lastIndex = 0;
  let m;
  while ((m = NAUKRI_ANCHOR.exec(body)) !== null) {
    const sidUrl = m[1].replace(/&amp;/g, '&');
    if (seen[sidUrl]) continue;
    seen[sidUrl] = true;
    // release label lives in the text right before the anchor
    const before = stripTags(body.slice(Math.max(0, m.index - 1200), m.index));
    const label = before.slice(-160);
    releases.push({
      sidUrl,
      label,
      quality: parseQuality(label),
      size: parseSize(label),
    });
  }
  // prefer 4K first, then by parsed size desc
  const qRank = q => (q === '2160p' ? 0 : q === '1080p' ? 1 : q === '720p' ? 2 : 3);
  releases.sort((a, b) => qRank(a.quality) - qRank(b.quality));
  return releases;
}

// ── Stage 1: thenaukriadda sid chain → driveseed destination ────────────────
function parseLpForm(html) {
  const f = html.match(/<form id="lp[^"]*"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/);
  if (!f) return null;
  const fields = {};
  for (const mm of f[2].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) fields[mm[1]] = mm[2];
  return { action: f[1], fields };
}
async function resolveSidToDest(sidUrl) {
  const s = createSession();
  let res = await s.fetchDoc(sidUrl, { headers: { Referer: 'https://uhdmovies.my/' } });
  let form = parseLpForm(res.body);
  let hops = 0;
  while (form && hops < 6) {
    hops++;
    res = await s.fetchDoc(form.action, {
      method: 'POST',
      body: new URLSearchParams(form.fields).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: sidUrl },
    });
    if (res.status >= 300 && res.status < 400 && res.location) {
      res = await s.fetchDoc(res.location, { headers: { Referer: form.action } });
    }
    form = parseLpForm(res.body);
  }
  const scM = res.body.match(/sc\("([^"]+)","([^"]+)",\d+\)/);
  const goM = res.body.match(/\?lp_go=(lp-[a-z0-9]+)/i);
  if (!scM || !goM) return null;
  // the page's inline JS sets this cookie before navigating — mirror it
  s.jar[scM[1]] = scM[2];
  const g = await s.fetchDoc(`https://en.thenaukriadda.in/?lp_go=${goM[1]}`, { headers: { Referer: 'https://en.thenaukriadda.in/' } });
  const meta = g.body.match(/http-equiv="refresh"[^>]*url=([^">]+)/i)
    || g.body.match(/location(?:\.href|\.replace)?\s*[(=]\s*["']([^"']+)["']/i);
  return meta ? meta[1].replace(/\\\//g, '/') : g.location || null;
}

// ── Stage 2: driveseed r?key → /file/<id> → instant anchor ──────────────────
async function resolveDestToFile(destUrl) {
  const s = createSession();
  let res = await s.fetchDoc(destUrl, { headers: { Referer: 'https://uhdmovies.my/' } });
  const rep = res.body.match(/window\.location\.replace\(["']([^"']+)["']\)/)
    || res.body.match(/window\.location\.href\s*=\s*["']([^"']+)["']/);
  const fileUrl = rep ? new URL(rep[1], destUrl).href : destUrl;
  res = await s.fetchDoc(fileUrl, { headers: { Referer: destUrl } });
  if (res.status !== 200) return { fileUrl, instant: null, fileHtml: '' };
  return { fileUrl, instant: null, fileHtml: res.body };
}

// ── Stage 3: instant CDN → direct URL ────────────────────────────────────────
function isDirectVideo(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /workers\.dev$/.test(host) || /(^|\.)r2\.cloudflarestorage\.com$/.test(host) || /(^|\.)r2\.dev$/.test(host)
      || host === 'video-downloads.googleusercontent.com' || host.endsWith('.googleusercontent.com')
      || host.endsWith('.googlevideo.com');
  } catch { return false; }
}
async function resolveInstant(instantUrl) {
  // family (a): video-gen style — no query params; browser-header fetch 302s to
  // video-seed.dev/?url=<real>. The plain landing is a decoy without the param.
  // family (b): video-plex style — ?url=<hex> token; POST /api keys=<hex>.
  try {
    const u = new URL(instantUrl);
    if (u.searchParams.get('url')) {
      const token = u.searchParams.get('url');
      if (/^https?:/i.test(token)) return isDirectVideo(token) ? token : token;
      const apiRes = await fetch(`${u.origin}/api`, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'x-token': u.hostname, Referer: instantUrl },
        body: `keys=${encodeURIComponent(token)}`,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const data = await apiRes.json().catch(() => null);
      if (data && data.url) return String(data.url).replace(/\\\//g, '/');
      // token page fallback: follow the browser flow for a ?url=http redirect
      const r = await fetch(instantUrl, { headers: { ...BROWSER_HEADERS, Referer: 'https://driveseed.org/' }, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      await r.text();
      const idx = r.url.indexOf('url=http');
      return idx >= 0 ? decodeURIComponent(r.url.slice(idx + 4)) : null;
    }
    const r = await fetch(instantUrl, { headers: { ...BROWSER_HEADERS, Referer: 'https://driveseed.org/' }, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    await r.text();
    const idx = r.url.indexOf('url=http');
    if (idx >= 0) {
      const real = decodeURIComponent(r.url.slice(idx + 4));
      if (isDirectVideo(real)) return real;
    }
    return null;
  } catch (e) {
    err(`instant resolve failed: ${e.message}`);
    return null;
  }
}

// ── Per-release orchestration ────────────────────────────────────────────────
async function resolveRelease(release, meta) {
  const t0 = Date.now();
  const dest = await resolveSidToDest(release.sidUrl);
  if (!dest) { log(`sid chain returned no destination (${Date.now() - t0}ms)`); return null; }
  const { fileUrl, fileHtml } = await resolveDestToFile(dest);
  const instM = fileHtml.match(/href="(https:\/\/cdn\.video-(?:gen|plex|leech|seed)[^/]*\.xyz\/[^"]+)"/)
    || fileHtml.match(/href="(https:\/\/cdn\.video-gen\.xyz\/[^"]+)"/);
  const instant = instM && instM[1];
  if (!instant) {
    // legacy page layout: direct links already on the file page
    const dv = (fileHtml.match(/https?:\/\/[^\s"'<>]*(?:workers\.dev|r2\.dev|googleusercontent\.com)[^\s"'<>]*/g) || [])[0];
    if (dv) return { url: dv, fileUrl };
    log(`no instant anchor on ${fileUrl.slice(0, 80)}`);
    return null;
  }
  const direct = await resolveInstant(instant);
  if (!direct) { log(`instant yielded no direct (${Date.now() - t0}ms)`); return null; }
  return { url: direct, fileUrl };
}

// ── Card metadata (keeps the old emoji format the wrapper expects) ───────────
function buildDropdownMetadata(meta, release, fileUrl) {
  const q = release.quality || 'Unknown';
  let qIcon = '🎬 ' + q;
  if (q === '2160p') qIcon = '✨ 4K';
  else if (q === '1080p') qIcon = '🖥️ 1080p';
  else if (q === '720p') qIcon = '🛰️ 720p';
  const size = release.size ? `📦 ${release.size}` : '📦 Size unknown';
  const audio = '🗣️ Multi-Audio';
  const line1 = `🎬 ${meta.title}${meta.year ? ` (${meta.year})` : ''}`;
  const line2 = `${qIcon} | ${size} | ${audio}`;
  const line3 = '🎞️ MKV | ⚡ Direct DriveSeed | 📥 WEB-DL';
  const label = release.label ? `\n📝 ${release.label.slice(0, 120)}` : '';
  return `${line1}\n${line2}\n${line3}${label}`;
}

// ── Result cache (merged-route re-polls must not burn fresh sid chains) ─────
const _resultCache = new Map(); // tmdbId -> { ts, streams }
const RESULT_TTL_MS = 10 * 60 * 1000;

async function getStreams(tmdbId, type, _season, _episode) {
  if (!tmdbId || type !== 'movie') return [];
  const cached = _resultCache.get(tmdbId);
  if (cached && Date.now() - cached.ts < RESULT_TTL_MS) return cached.streams;
  const t0 = Date.now();
  try {
    log(`looking up movie ${tmdbId}`);
    const meta = await fetchMetadata(tmdbId);
    if (!meta.title) { log('TMDB returned no title'); return []; }
    const postPages = (await findMoviePages(meta)).slice(0, MAX_POSTS);
    if (!postPages.length) { log(`no result for ${meta.title}`); return []; }
    log(`found ${postPages.length} matching post(s)`);
    const postHtmls = await Promise.allSettled(postPages.map(async p => {
      const s = createSession();
      const res = await s.fetchDoc(p, { headers: { Referer: 'https://uhdmovies.my/' } });
      return res.status === 200 ? res.body : '';
    }));
    let releases = [];
    for (const ph of postHtmls) {
      if (ph.status === 'fulfilled' && ph.value) {
        releases = releases.concat(extractReleases(ph.value));
      }
    }
    if (!releases.length) { log('found 0 release(s)'); return []; }
    log(`found ${releases.length} release(s)`);
    // 4K first (extractReleases already sorts) — resolve in parallel with a soft sweep
    const batch = releases.slice(0, MAX_RELEASES);
    // Task 84d: stagger launches 250ms — merged bursts trip site-side rate limits
    const settled = await Promise.allSettled(batch.map(async (rel, i) => {
      if (i && Date.now() - t0 > SWEEP_SOFT_MS) return null; // soft sweep stop
      if (i) await new Promise(r => setTimeout(r, 250 * i));
      const deadline = new Promise(r => setTimeout(r, CHAIN_TIMEOUT_MS, null));
      const work = resolveRelease(rel, meta).catch(e => { err(`release resolve: ${e.message}`); return null; });
      return Promise.race([work, deadline]);
    }));
    const streams = [];
    const seenUrl = {};
    for (let i = 0; i < settled.length; i++) {
      const st = settled[i];
      const out = st.status === 'fulfilled' ? st.value : null;
      if (!out || !out.url || seenUrl[out.url]) continue;
      seenUrl[out.url] = true;
      const rel = batch[i];
      const title = buildDropdownMetadata(meta, rel, out.fileUrl);
      streams.push({
        name: rel.quality,
        title,
        size: rel.size || title,
        description: title,
        url: out.url,
        quality: '',
        language: '',
        type: 'direct',
        headers: { 'User-Agent': UA },
        provider: PROVIDER_NAME,
      });
    }
    log(`returning ${streams.length} stream(s) in ${Date.now() - t0}ms`);
    if (streams.length) _resultCache.set(tmdbId, { ts: Date.now(), streams });
    return streams;
  } catch (e) {
    err(`getStreams error: ${e.message}`);
    return [];
  }
}

module.exports = { getStreams };
