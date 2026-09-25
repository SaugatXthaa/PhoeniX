// src/source/CineFreak.js
// cinefreak.net — movies/series with direct googleusercontent MKV streams
//
// REVIVED Task 38 (2026-09). The source was deleted in Task 19 after an
// earlier upstream breakage; the site is alive again (TVVVV registry still
// lists cinefreak → https://cinefreak.net) with a changed flow:
//
//   1. Search: GET /search-api.php?q={title}&pg=1 → JSON
//      { results: [{ l: <slug>, t: <title>, q: <quality>, i: <thumb> }] }
//      (the /?s= page is now a JS shell around this API)
//   2. Post page /{slug}/ → h4.movie-title (quality + size) +
//      a.dlbtn-download[href="generate.php?id={base64}"]
//      base64 id = https://new5.cinecloud.site/f/{fileid}newgo32
//   3. Resolution: GET cinecloud.site /w/{fileid} → page embeds the DIRECT
//      video-downloads.googleusercontent.com URL (hidden .vd div). Works
//      anonymously when the file is already cached server-side.
//      Cold cache fallback: POST /d/{fileid} with CSRF (meta[name=X-CSRF-TOKEN])
//      → { data: { taskId } } → poll the hex-encoded status API until
//      status=completed → retry /w/{fileid}.
//   4. The googleusercontent URL ships raw — the AcerMovies extractor routes
//      it through /range-proxy for Range translation (direct play otherwise
//      200s without Range support). Non-video files (.zip season packs) are
//      skipped via the /w/ page title check.

import * as cheerio from 'cheerio';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { fetchWithCurl } from '../utils/cf-fetch.cjs';

const BASE_URL = 'https://cinefreak.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DIRECT_URL_RE = /https:\/\/video-downloads\.googleusercontent\.com\/[A-Za-z0-9_\-]+/;

const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

// cinecloud.site CF-challenges Node's native undici fetch (403 "Just a
// moment..." — JA3 block, verified 2026-09) while got-scraping's Chrome TLS
// passes; curl (SHORT_UA) is the escape hatch. POST is only needed for the
// cold-cache /d/ generate fallback.
async function fetchPage(url, { headers = {}, method = 'GET', body = null, timeout = 12000 } = {}) {
  try {
    const { gotScraping } = await import('got-scraping');
    const res = await gotScraping(url, {
      method,
      body: body || undefined,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', ...headers },
      timeout: { request: timeout },
      throwHttpErrors: false,
      followRedirect: true,
    });
    if (res.statusCode >= 400) return null;
    return res.body || '';
  } catch {
    // curl fallback (GET only)
    if (method === 'GET') {
      try {
        const buf = await fetchWithCurl(url, { headers, maxTimeSec: Math.ceil(timeout / 1000) });
        return buf.toString('utf8');
      } catch { return null; }
    }
    return null;
  }
}

// Parse quality/size/codec from an h4 like:
//   "Inception (2010) [Dual Audio] SD 480p [470 MB]"
//   "Inception (2010) [Dual Audio] HD 1080p [3.2 GB]"
function parseH4(text) {
  const t = text || '';
  let quality = 'HD';
  let height;
  let bytes;
  if (/4k|2160p/i.test(t)) { quality = '4K'; height = 2160; }
  else if (/1080p/i.test(t)) { quality = '1080p'; height = 1080; }
  else if (/720p/i.test(t)) { quality = '720p'; height = 720; }
  else if (/480p/i.test(t)) { quality = '480p'; height = 480; }
  else if (/360p/i.test(t)) { quality = '360p'; height = 360; }
  else {
    const m = t.match(/(\d{3,4})p/i);
    if (m) { quality = `${m[1]}p`; height = parseInt(m[1]); }
  }
  const sizeMatch = t.match(/\[\s*([\d.]+)\s*(GB|MB)\s*\]/i);
  if (sizeMatch) {
    const val = parseFloat(sizeMatch[1]);
    bytes = sizeMatch[2].toUpperCase() === 'GB' ? Math.round(val * 1024 * 1024 * 1024) : Math.round(val * 1024 * 1024);
  }
  const codec = /hevc|x265/i.test(t) ? 'HEVC' : (/x264|avc/i.test(t) ? 'AVC' : undefined);
  return { quality, height, bytes, codec };
}

export class CineFreak extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinefreak';
    this.label = 'CineFreak';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
    this._fileCache = new Map(); // cinecloudId → { url, ts }
    this._tokenCache = new Map(); // generate v2 token → { fileId, ts } (Task 91)
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const detailUrl = await this.findDetailPage(name, year, tmdbId);
    if (!detailUrl) return [];

    const dlLinks = await this.findDownloadLinks(detailUrl);
    if (dlLinks.length === 0) return [];

    const results = [];
    const seenUrls = new Set();
    // Task 46: 4K-first resolve order. Posts list up to 7+ quality variants
    // (480p → 4K-2160p) but only the first 6 links were resolved — the 4K link
    // sits at position #11-13 in DOM order (after every Watch-Online twin), so
    // it NEVER got processed and cinefreak shipped max 1080p. Sort by height
    // desc (file size desc as tiebreak: HQ 1080p 8.7GB before HD 1080p 3.4GB)
    // before the slice so the highest qualities always claim the 6 resolve
    // slots; lower qualities drop first when the post has 7+ variants.
    // Parallel resolve — sequential cost 2s/link (cold cinecloud generate
    // polls) pushed 6 links past the client budget; parallel wall = slowest.
    const dlLinksSorted = [...dlLinks].sort((a, b) => {
      const h = (b.height || 0) - (a.height || 0);
      if (h !== 0) return h;
      return (b.bytes || 0) - (a.bytes || 0);
    });
    const resolved = await Promise.all(dlLinksSorted.slice(0, 6).map(async dl => {
      try {
        // Task 91: legacy links carry the fileid directly; v2 links carry an
        // opaque generate token that needs the server-side go-flow first.
        let fileId = dl.cinecloudId;
        if (!fileId && dl.v2Token) fileId = await this.resolveGenerateToken(dl.v2Token);
        if (!fileId) return { dl, streamUrl: null };
        return { dl, streamUrl: await this.resolveStreamUrl(fileId) };
      } catch { return { dl, streamUrl: null }; }
    }));
    for (const { dl, streamUrl } of resolved) {
      if (!streamUrl) continue;
      if (seenUrls.has(streamUrl)) continue;
      seenUrls.add(streamUrl);

      const parsed = new URL(streamUrl);
      results.push({
        url: parsed,
        format: Format.mp4, // MKV plays as MP4 in Stremio
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
          title: `${title} (${dl.quality})`,
          sourceId: this.id,
          sourceLabel: this.label,
          ...(dl.height && { height: dl.height }),
          ...(dl.bytes && { bytes: dl.bytes }),
          ...(dl.codec && { codec: dl.codec }),
        },
      });
    }

    return results;
  }

  // Search via the JSON API (exact title match first, word-overlap fallback)
  async findDetailPage(name, year, tmdbId) {
    const nameNorm = normalize(name);
    const isTV = !!tmdbId.season;
    const query = isTV && tmdbId.season ? `${name} season ${tmdbId.season}` : name;

    const html = await fetchPage(`${BASE_URL}/search-api.php?q=${encodeURIComponent(query)}&pg=1`, {
      headers: { Referer: `${BASE_URL}/fast-search/?q=${encodeURIComponent(query)}`, Accept: 'application/json' },
    });
    if (!html) return null;

    let data;
    try { data = JSON.parse(html); } catch { return null; }
    const results = Array.isArray(data?.results) ? data.results : [];
    if (results.length === 0) return null;

    const yearNum = year ? parseInt(String(year), 10) : null;
    let best = null;
    let bestScore = 0;
    for (const r of results) {
      const tNorm = normalize(r.t);
      if (!tNorm) continue;
      let score = 0;
      if (tNorm === nameNorm) score = 100;
      // Post titles start with "Name [Year?] ..." then marketing noise
      // ("Inception 2010 WEB-DL [Dual Audio] Full Movie Download | GDrive Link")
      else if (tNorm.startsWith(nameNorm + ' ')) score = 95;
      else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
        score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
      }
      // Word-overlap fallback (multi-word names with reordered titles)
      if (score < 30) {
        const nameWords = nameNorm.split(' ').filter(w => w.length > 2);
        if (nameWords.length >= 2) {
          const titleWords = new Set(tNorm.split(' ').filter(w => w.length > 2));
          const common = nameWords.filter(w => titleWords.has(w));
          const coverage = common.length / nameWords.length;
          if (coverage >= 0.6) score = coverage * 80;
        }
      }
      if (score <= 0) continue;
      // TV: prefer the requested season's post
      if (isTV && tmdbId.season) {
        const mSeason = r.t.match(/season\s*0*(\d{1,2})/i);
        if (mSeason) {
          if (parseInt(mSeason[1]) === tmdbId.season) score += 30;
          else score -= 40; // wrong season — deprioritize hard
        }
      }
      // Year gate (±1), MOVIES ONLY: site posts use air-year for TV seasons
      // ("Breaking Bad (2011) (Season 5)" vs TMDB 2008) which would wrongly
      // reject; movie titles match TMDB years closely.
      if (yearNum && !isTV) {
        const m = r.t.match(/\((\d{4})\)|\b(19\d{2}|20\d{2})\b/);
        const pageYear = m ? parseInt(m[1] || m[2], 10) : null;
        if (pageYear && Math.abs(pageYear - yearNum) > 1) continue;
      }
      if (score > bestScore) { bestScore = score; best = r; }
    }

    if (best && bestScore >= 60 && best.l) return `${BASE_URL}/${best.l}/`;
    return null;
  }

  // Detail page → generate.php links with quality.
  // Movies: h4.movie-title + a.dlbtn-download inside .dlbtn-container.
  // Series ("Combo Packs Links"): BARE anchors (no class, relative
  // /generate.php?id=… hrefs, quality in the link text "HD 1080p").
  //
  // Task 91 (2026-09 site update): the generate id scheme went from plain
  // base64("https://new5.cinecloud.site/f/{fileid}newgo32") to OPAQUE v2
  // tokens ("v2…" with base64url chars '-' and '_'). The old id regex
  // ([A-Za-z0-9+/=]+) truncated them at the first '-' and the local base64
  // decode produced garbage — the mapping is now server-side. New ids are
  // resolved through resolveGenerateToken() during the resolve phase; the
  // legacy decode is kept first for rollback safety.
  async findDownloadLinks(detailUrl) {
    const html = await fetchPage(detailUrl, { headers: { Referer: BASE_URL + '/' } });
    if (!html) return [];

    const $ = cheerio.load(html);
    const links = [];
    const seenIds = new Set();

    $('a[href*="generate.php"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.includes('generate.php')) return;

      // Quality/size from the container's h4.movie-title (movies) or the
      // link text itself (series combo packs: "SD 480p" / "HD 1080p")
      let quality = 'HD';
      let height, bytes, codec;
      let h4Text = '';
      const $container = $(el).closest('.dlbtn-container');
      if ($container.length) h4Text = $container.prev('h4.movie-title').text().trim();
      if (!h4Text) h4Text = $(el).text().trim();
      if (h4Text) ({ quality, height, bytes, codec } = parseH4(h4Text));

      // generate.php?id={...} — full token capture incl. base64url '-'/_'.
      const m = href.match(/id=([A-Za-z0-9+/=_-]+)/);
      if (!m) return;

      // Legacy path (Task 38): base64 decode → cinecloud.site/f/{fileid}
      let decoded = '';
      try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { /* v2 token — not base64 */ }
      const idMatch = decoded.match(/cinecloud\.site\/f\/([a-z0-9]+)/i);
      if (idMatch) {
        // Strip the "newgo32" tracking suffix baked into the path
        const cinecloudId = idMatch[1].replace(/newgo32$/i, '');
        if (!cinecloudId || seenIds.has(cinecloudId)) return;
        seenIds.add(cinecloudId);
        links.push({ quality, height, bytes, codec, cinecloudId });
        return;
      }

      // v2 path (Task 91): opaque token — resolve server-side later.
      if (seenIds.has(m[1])) return;
      seenIds.add(m[1]);
      links.push({ quality, height, bytes, codec, v2Token: m[1] });
    });

    return links;
  }

  // Task 91: v2 generate token → cinecloud fileid (server-side mapping).
  // Two-step, cookie-free, verified live 2026-09:
  //   1. GET /generate.php?id={token} → interstitial page whose JS embeds
  //      go={ts}.{hash} (the "click twice" gate is purely client-side — the
  //      same page hands us the exact parameter the browser navigates to)
  //   2. GET /generate.php?id={token}&go={ts}.{hash} → 302 Location:
  //      https://new5.cinecloud.site/f/{fileid}
  // FINGERPRINT NOTES (measured live): the interstitial sits behind a
  // per-request CF gate that prefers curl's plain TLS and challenges
  // got-scraping/undici Chrome fingerprints (opposite of cinecloud.site,
  // which blocks undici but passes got-scraping). The &go= step is NOT
  // gated and answers 302 regardless. The origin also throws sporadic
  // CF 522s — every fetch here retries once, and the 60min token→fileid
  // cache keeps repeat resolves off the flaky path entirely.
  async resolveGenerateToken(token) {
    const cached = this._tokenCache.get(token);
    if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return cached.fileId;

    const genUrl = `${BASE_URL}/generate.php?id=${encodeURIComponent(token)}`;
    let goValue = null;
    for (let attempt = 1; attempt <= 2 && !goValue; attempt++) {
      let html = '';
      try {
        const buf = await fetchWithCurl(genUrl, { headers: { Referer: BASE_URL + '/' }, maxTimeSec: 12, userAgent: UA });
        html = buf ? buf.toString('utf8') : '';
      } catch { /* retry */ }
      const m = html.match(/\bgo=(\d{9,12}\.[0-9a-fA-F]{8,40})/);
      if (m) goValue = m[1];
      else if (attempt === 1) await new Promise(r => setTimeout(r, 900));
    }
    if (!goValue) {
      console.log('[cinefreak] generate v2: no go token after retries (CF gate or flow changed)');
      return null;
    }

    const finalUrl = `${genUrl}&go=${goValue}`;
    let location = '';
    try {
      // native fetch with manual redirect — the &go= endpoint is not gated
      const res = await fetch(finalUrl, {
        redirect: 'manual',
        headers: { 'User-Agent': UA, Referer: BASE_URL + '/' },
        signal: AbortSignal.timeout(12000),
      });
      if (res.status >= 500) throw new Error(`origin ${res.status}`); // sporadic CF 522s
      location = res.headers.get('location') || '';
    } catch {
      try {
        const { gotScraping } = await import('got-scraping');
        const res = await gotScraping(finalUrl, {
          headers: { 'User-Agent': UA, Referer: BASE_URL + '/' },
          timeout: { request: 12000 },
          throwHttpErrors: false,
          followRedirect: false, // capture the 302 Location itself
        });
        location = String(res.headers.location || '');
      } catch { /* fall through */ }
    }
    const m = location && location.match(/cinecloud\.site\/f\/([a-z0-9]+)/i);
    if (!m) {
      console.log('[cinefreak] generate v2: no cinecloud fileid in redirect');
      return null;
    }
    if (this._tokenCache.size > 300) this._tokenCache.clear();
    this._tokenCache.set(token, { ts: Date.now(), fileId: m[1] });
    return m[1];
  }

  // cinecloud file id → direct googleusercontent URL.
  // Fast path: GET /w/{id} (anonymous, works when the file is cached).
  // Cold-cache fallback: POST /d/{id} with CSRF, poll the hex-encoded status
  // API until completed, then retry /w/{id}.
  async resolveStreamUrl(cinecloudId) {
    const cached = this._fileCache.get(cinecloudId);
    if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.url;

    const direct = await this.tryWatchPage(cinecloudId);
    if (direct) {
      if (this._fileCache.size > 300) this._fileCache.clear();
      this._fileCache.set(cinecloudId, { ts: Date.now(), url: direct });
      return direct;
    }

    // Cold cache: trigger generation
    const gen = await this.triggerGeneration(cinecloudId);
    if (!gen) return null;
    const { statusApi, deadline } = gen;

    // Poll status (page polls every 1s; we poll every 1.5s up to ~10s)
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500));
      let statusText = await fetchPage(statusApi, { headers: { Accept: 'application/json' }, timeout: 6000 });
      if (statusText) {
        try {
          const st = JSON.parse(statusText);
          if (st.status && st.status !== 'completed' && st.status !== 'in-progress') {
            // queued/in-progress → keep waiting
          }
          if (st.status === 'completed') break;
        } catch { /* status endpoint hiccup — keep polling /w/ below */ }
      }
      const directRetry = await this.tryWatchPage(cinecloudId);
      if (directRetry) {
        this._fileCache.set(cinecloudId, { ts: Date.now(), url: directRetry });
        return directRetry;
      }
    }
    return null;
  }

  // GET /w/{id} → direct URL if present AND the file is a video
  async tryWatchPage(cinecloudId) {
    const html = await fetchPage(`https://new5.cinecloud.site/w/${cinecloudId}`, {
      headers: { Referer: BASE_URL + '/' },
    });
    if (!html) return null;

    // Title carries the filename: "... - Inception (2010) WEB-DL {Hin-Eng} 480p.mkv"
    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    const filename = titleMatch ? titleMatch[1] : '';
    if (filename && /\.(mkv|mp4|avi|webm)\b/i.test(filename) === false) return null; // zip packs etc.

    const m = html.match(DIRECT_URL_RE);
    return m ? m[0] : null;
  }

  // POST /d/{id} with CSRF; returns { statusApi, deadline } or null
  async triggerGeneration(cinecloudId) {
    const pageUrl = `https://new5.cinecloud.site/d/${cinecloudId}`;
    const html = await fetchPage(pageUrl, { headers: { Referer: BASE_URL + '/' } });
    if (!html) return null;

    const csrfMatch = html.match(/meta\s+name="X-CSRF-TOKEN"\s+content="([^"]+)"/i);
    if (!csrfMatch) return null;

    // Status API is hex-encoded in the page (anti-adblock obfuscation)
    const hexMatch = html.match(/const binaryApiUrl = "([0-9a-f]+)"/);
    let statusApi = null;
    if (hexMatch) {
      try {
        statusApi = (hexMatch[1].match(/.{2}/g) || []).map(h => String.fromCharCode(parseInt(h, 16))).join('');
      } catch { statusApi = null; }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(pageUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          'Referer': pageUrl,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: 'csrf_test_name=' + encodeURIComponent(csrfMatch[1]),
      });
      // 200 with {success:true,data:{taskId...}} — enough to kick generation
      if (!res.ok && res.status !== 400) return null;
    } catch {
      return null;
    } finally { clearTimeout(timer); }

    return { statusApi, deadline: Date.now() + 10000 };
  }
}
