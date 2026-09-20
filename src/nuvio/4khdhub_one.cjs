// src/nuvio/4khdhub_one.cjs
// 4khdhub.one — movies & TV series with HubCloud/HubDrive download links
//
// Flow:
//   1. Search via /?s={title} (HTML, no CF challenge)
//   2. Match by title + year (movies) or season (TV)
//   3. For movies: extract download links grouped by quality (content-file blocks)
//   4. For series: filter by season+episode, extract links (season-item blocks)
//   5. GREENMOTORS (2026-09): 4khdhub.one replaced direct hubcloud.ist/hubdrive.tips
//      hrefs with ad-funnel links (greenmotors.cc/?id=<encrypted>). The funnel's
//      landing HTML embeds a localStorage token whose decode chain yields the
//      REAL file URL — fully server-side resolvable, no browser needed:
//          token = atob(atob(rot13(atob(token))))  → JSON {l, w, o}
//          realUrl = atob(json.o)                  → hubcloud.ist/drive/<id> etc.
//      Task 50 (2026-09): the funnel domain ROTATES — live pages now carry
//      greenmotors.club (and may rotate again). Detection is TLD-agnostic:
//   6. hubcloud.ist URLs ship raw — the ESM HubExtractor → HubCloud extractor
//      pipeline resolves them downstream (workers.dev / pixeldrain direct CDN).
//      hubdrive.pics results are SKIPPED: its download API is login-gated
//      (401 "Not signed in" for guests; verified 2026-09).
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
    // Task 49: one fast retry on NETWORK-level errors (the Render DNS/socket
    // hiccup class — Task 48 fix2; a single "fetch failed" used to zero the
    // whole multi-hop chain with no retry). HTTP-status errors keep caller
    // semantics (404 = no match, 403 = gated). Both attempts share the one
    // AbortController budget so the total stays bounded.
    //
    // Task 57 (2026-09-19): BARE UNDICI FETCH IS THE MERGED-RESOLVE KILLER.
    // Production evidence (/debug/stream Inception): 4khdhub + fourkhdhubone
    // TIMEOUT at the flat 35s cap on EVERY merged resolve while isolated
    // /debug/source returns 6 cards @0.8s. Root cause = the Task 55
    // DNS-stall class: during a 15-concurrent-source resolve, bare undici
    // fetch stalls in DNS past AbortSignal deadlines (abort does not cancel
    // in-flight lookups; the instance's IPv6/AAAA path makes it worse).
    // Fix (atlantic.cjs Task 55 pattern): when the caller provides the addon
    // Fetcher (https.request, family:4 forced, node-level timeout, got-scraping
    // CF fallback) all GETs route through it. Bare fetch remains the fallback
    // (local tooling / no-fetcher callers).
    const doFetch = async () => {
      if (options.fetcher && options.ctx) {
        try {
          const data = await options.fetcher.text(options.ctx, new URL(url), {
            headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', ...options.headers },
            timeout: options.timeout || 15000,
          });
          return { ok: true, status: 200, text: data };
        } catch (e) {
          // Normalize Fetcher errors to bare-fetch semantics so every caller's
          // existing status handling (404 = no match, 403 = gated) is intact.
          const status = e?.statusCode || e?.status || 0;
          if (status >= 400) return { ok: false, status, text: '' };
          throw e; // network-level → retry below
        }
      }
      const r = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', ...options.headers },
      });
      return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' };
    };
    let r;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(res => setTimeout(res, 400));
      try {
        r = await doFetch();
        break;
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return r.text;
  } finally { clearTimeout(timer); }
}

async function getTMDBInfo(tmdbId, mediaType, fetcher, ctx) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  try {
    // Task 49: this fetch previously had NO timeout — an unbounded TMDB call
    // stalls the whole chain (and a silent failure empties the title used for
    // matching). 8s cap + one fast retry keeps matching alive through hiccups.
    let r;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(res => setTimeout(res, 400));
      try {
        r = await fetchText('https://api.themoviedb.org/3/' + type + '/' + tmdbId + '?api_key=' + TMDB_API_KEY, { timeout: 8000, fetcher, ctx });
        break;
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
    // Task 57: fetchText returns the BODY STRING (not a Response) — parse it.
    const d = JSON.parse(r);
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
async function search(title, fetcher, ctx) {
  const searchUrl = BASE_URL + '/?s=' + encodeURIComponent(title);
  console.log('[4KHDHubOne] Searching: ' + searchUrl);
  const html = await fetchText(searchUrl, { fetcher, ctx });
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
//
// YEAR MATCHING (critical for movies with same title across years):
//   The slug itself (e.g. "moana-movie-234") doesn't include the year,
//   but the post page <title> or <h1> does (e.g. "Moana (2016)").
//   So we fetch the page title for each candidate and parse the year.
//
//   When TMDB provides a year (info.year is set), we HARD-FILTER:
//   reject candidates whose page year differs by more than 1 from TMDB.
//   This prevents "Moana 2026" from matching the 2016 Moana page.
//
//   When TMDB has no year, we fall back to title-score-only matching.
async function findBestMatch(results, tmdbTitle, tmdbYear, isMovie, fetcher, ctx) {
  if (!results.length) return null;
  const nameNorm = normalize(tmdbTitle);
  const yearNum = tmdbYear ? parseInt(String(tmdbYear), 10) : null;
  const yearStr = tmdbYear ? String(tmdbYear) : '';

  // Filter by type (movie vs series)
  const filtered = results.filter(r => r.isMovie === isMovie);
  if (filtered.length === 0) return null;

  // For movies with a known year, pre-fetch each candidate's page title
  // to extract the year. This lets us hard-filter by year.
  // TV shows don't typically have year conflicts (slugs include season info).
  if (isMovie && yearNum) {
    const withPageYear = await Promise.all(filtered.map(async (r) => {
      try {
        const html = await fetchText(r.url, { timeout: 8000, fetcher, ctx });
        // Extract year from <title> or <h1>
        //   "Moana (2016) - 4K-HDHub" → 2016
        //   "Moana 2 (2024) - 4K-HDHub" → 2024
        const titleMatch = html.match(/<title>[^<]*\((\d{4})\)[^<]*<\/title>/i);
        const h1Match = html.match(/<h1[^>]*>[^<]*\((\d{4})\)[^<]*<\/h1>/i);
        const pageYearStr = (titleMatch?.[1] || h1Match?.[1] || '');
        const pageYear = pageYearStr ? parseInt(pageYearStr, 10) : null;
        return { ...r, pageYear, _html: html }; // cache HTML for reuse in getStreams
      } catch {
        return { ...r, pageYear: null, _html: null };
      }
    }));

    // Hard-filter by year (allow ±1 year tolerance for delayed releases)
    const yearMatched = withPageYear.filter(r => {
      if (r.pageYear == null) return true; // couldn't parse → keep, score-based fallback
      const diff = Math.abs(r.pageYear - yearNum);
      return diff <= 1;
    });

    if (yearMatched.length === 0) {
      console.log('[4KHDHubOne] No matches with year=' + yearNum + ' (all ' + withPageYear.length + ' candidates had different years)');
      return null;
    }

    // Among year-matched candidates, pick by title score
    let best = null;
    let bestScore = 0;
    for (const r of yearMatched) {
      const slugNorm = normalize(r.slug.replace(/-(?:movie|series)-\d+$/, '').replace(/-/g, ' '));
      let score = 0;
      if (slugNorm === nameNorm) score = 100;
      else if (slugNorm.includes(nameNorm) || nameNorm.includes(slugNorm)) score = 80;
      else {
        const words = nameNorm.split(' ').filter(w => w.length > 2);
        const matched = words.filter(w => slugNorm.includes(w)).length;
        score = (matched / Math.max(words.length, 1)) * 60;
      }
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }

    if (best && bestScore >= 60) {
      console.log('[4KHDHubOne] Matched: ' + best.slug + ' (year=' + (best.pageYear || '?') + ', score=' + bestScore + ')');
      return best;
    }
    console.log('[4KHDHubOne] No good match found (best score=' + bestScore + ', need >= 60)');
    return null;
  }

  // Original logic for TV shows or when year is unknown
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

    // Year matching for movies (bonus only — original behavior)
    if (yearStr && isMovie && r.slug.includes(yearStr)) score += 20;

    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  // Only return matches with score >= 60 — prevents random movie matches
  if (best && bestScore >= 60) {
    console.log('[4KHDHubOne] Matched: ' + best.slug + ' (score=' + bestScore + ')');
    return best;
  }
  console.log('[4KHDHubOne] No good match found (best score=' + bestScore + ', need >= 60)');
  return null;
}

// ===========================================================================
// GREENMOTORS RESOLUTION (2026-09)
// ===========================================================================
// greenmotors.<tld>/?id=<X> returns a 1.4KB page whose only job is to stash a
// token in localStorage and redirect through an ad mediator. The token is
// EMBEDDED IN THE RESPONSE HTML:
//     s('o', '<token>', 180*1000);
// Decode chain (reversed from the mediator's deobfuscated pr()):
//     atob → atob → rot13 → atob → JSON {"l": <landing>, "w": <secs>, "o": <b64>}
//     realUrl = atob(json.o)
// Verified 2026-09: greenmotors.club pages decode identically to the
// original greenmotors.cc (same script, same chain — only the domain changed).
// Verified 2026-09: lands on hubcloud.ist/drive/<id> (resolvable) or
// hubdrive.pics/file/<id> (login-gated → skip).

// ROT13 used by the mediator's String.prototype.pen
function rot13(s) {
  return String(s).replace(/[a-zA-Z]/g, c => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

// atob equivalent that never throws on odd padding
function b64decode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('binary');
}

// Resolve one greenmotors URL → { url, host } or null
// Task 70: ONE inline retry on failure. Under 15-source contention on Render
// 0.1-CPU the 12s fetch timeout fires far more often than on a clean network
// (sandbox: same page resolves in 0.5-2.5s), and a failed block meant a lost
// quality tier — or, when ALL blocks failed in the same window (measured on
// production: "Resolved 0 file URLs" while the identical scrape succeeded
// from the sandbox), a ZERO-count result that then got cached empty at the
// source layer. One retry inside the same resolve recovers the transient
// window without meaningfully extending the chain (retry only fires on
// failure).
async function resolveGreenmotors(href, fetcher, ctx) {
  const attempt = () => new Promise(async (resolve) => {
    try {
      const html = await fetchText(href, { timeout: 12000, headers: { Referer: BASE_URL + '/' }, fetcher, ctx });
      const tokenMatch = html.match(/s\(\s*['"]o['"]\s*,\s*['"]([A-Za-z0-9+/=]+)['"]/);
      if (!tokenMatch) { console.log('[4KHDHubOne] greenmotors: no token on ' + href.slice(0, 60)); return resolve(null); }
      let s = b64decode(tokenMatch[1]);
      s = b64decode(s);
      s = rot13(s);
      s = b64decode(s);
      const json = JSON.parse(s);
      if (!json || !json.o) return resolve(null);
      const real = b64decode(json.o);
      if (!/^https?:\/\//.test(real)) return resolve(null);
      const host = new URL(real).hostname;
      resolve({ url: real, host });
    } catch (e) {
      console.log('[4KHDHubOne] greenmotors resolve failed: ' + (e?.message || e));
      resolve(null);
    }
  });
  const first = await attempt();
  if (first) return first;
  return attempt();
}

// In-module cache — the decoded URL is stable per 4khdhub post link.
// Task 70: NEGATIVE results no longer cache for 30 minutes. One transient
// greenmotors timeout used to pin "Resolved 0 file URLs" for the FULL TTL —
// every refresh for half an hour served the locked-out empty from the source
// cache (user-visible: "4khdhub not returning any 4K movies"). Positives
// keep the 30min TTL; negatives now expire after 90s so the next refresh
// re-resolves fresh.
const _gmCache = new Map();
const GM_CACHE_TTL = 30 * 60 * 1000;
const GM_NEG_CACHE_TTL = 90 * 1000;
async function resolveGreenmotorsCached(href, fetcher, ctx) {
  const hit = _gmCache.get(href);
  if (hit) {
    const ttl = hit.val ? GM_CACHE_TTL : GM_NEG_CACHE_TTL;
    if (Date.now() - hit.ts < ttl) return hit.val;
  }
  const val = await resolveGreenmotors(href, fetcher, ctx);
  if (_gmCache.size > 400) _gmCache.clear();
  _gmCache.set(href, { ts: Date.now(), val });
  return val;
}

// Extract the download links from one 4khdhub file block.
// Movie block:  <div id="content-fileNNN"> <div class="file-title">…2160p…mkv</div>
//               <span class="badge">BluRay 2160p</span> …
//               <a href="greenmotors">Download HubDrive|HubCloud</a> </div>
// Series block: <div class="episode-download-item">
//               <div class="episode-file-title">…S05E01…mkv</div>
//               <span class="badge-psa">Episode-01</span>
//               <span class="badge-size">1.65 GB</span>
//               <a href="greenmotors">Download HubCloud</a> </div>
// Returns { title, quality, size, greenmotorsHrefs[], legacyHubcloudHrefs[] }
function parseFileBlock($, el) {
  const $el = $(el);
  const blockHtml = $.html(el);
  const title = ($el.find('.file-title, .episode-file-title').first().text() || '').trim();
  if (!title) return null;

  const qualityMatch = title.match(/(2160p|1080p|720p|480p)/i);
  const quality = qualityMatch ? qualityMatch[1] : '';
  // Size: real sizes look like "1.65 GB" / "520 MB". The naive \d+\s*MB regex
  // false-matches Tailwind spacing classes ("gap-2 mb-3" → "2 mb"), so the
  // char BEFORE the number must not be a hyphen/alnum and nothing may follow.
  const sizeMatch = blockHtml.match(/(?:^|[^a-z0-9-])(\d+(?:\.\d+)?\s*(?:GB|MB))(?![a-z])/i);
  const size = sizeMatch ? sizeMatch[1].replace(/\s+/g, ' ') : '';

  const greenmotorsHrefs = [];
  const legacyHubcloudHrefs = [];
  const seen = new Set();
  $el.find('a[href]').each((_i, a) => {
    const href = ($(a).attr('href') || '').replace(/&amp;/g, '&');
    if (!href || seen.has(href)) return;
    seen.add(href);
    // Task 50: TLD-agnostic — the funnel moved greenmotors.cc → greenmotors.club
    // mid-flight (that migration WAS the "0 streams until 4-5 refreshes" bug:
    // edge caches served both variants, so only requests hitting a stale .cc
    // page yielded links). Accept any greenmotors.<tld>.
    if (/greenmotors\.[a-z]{2,}\/?\?id=/i.test(href)) greenmotorsHrefs.push(href);
    else if (/hubcloud|hubdrive/i.test(href)) legacyHubcloudHrefs.push(href);
  });

  // Prefer the "Download HubCloud" button (its decode lands on hubcloud.ist,
  // which resolves anonymously). HubDrive buttons decode to hubdrive.pics,
  // whose download API is login-gated.
  greenmotorsHrefs.sort((a, b) => {
    const aCloud = /hubcloud/i.test($('a[href="' + a + '"]', el).text() || '') ? 0 : 1;
    const bCloud = /hubcloud/i.test($('a[href="' + b + '"]', el).text() || '') ? 0 : 1;
    return aCloud - bCloud;
  });

  return { title, quality, size, greenmotorsHrefs, legacyHubcloudHrefs };
}

// Extract download entries from a movie post page (2026-09 layout)
function extractMovieLinks(html) {
  const $ = cheerio.load(html);
  const blocks = [];

  // Primary: content-fileNNN blocks (one per quality/edition)
  $('div[id^="content-file"]').each((_i, el) => {
    const parsed = parseFileBlock($, el);
    if (parsed && (parsed.greenmotorsHrefs.length || parsed.legacyHubcloudHrefs.length)) {
      blocks.push(parsed);
    }
  });

  // Fallback: legacy direct-hubcloud anchors (pre-greenmotors layout)
  if (blocks.length === 0) {
    $('a[href*="hubcloud"]').each((_i, el) => {
      const href = ($(el).attr('href') || '').replace(/&amp;/g, '&');
      if (!href) return;
      // Walk up for quality badges (legacy behavior)
      let quality = '';
      let size = '';
      let parent = $(el);
      for (let depth = 0; depth < 8 && !quality; depth++) {
        parent = parent.parent();
        if (!parent.length) break;
        parent.find('.badge').each((_j, badge) => {
          const t = $(badge).text().trim();
          if (t.match(/2160p|1080p|720p|480p|4K|HDR|UHD|IMAX|BluRay|WEB|REMUX|HEVC/i) && !quality) quality = t;
          if (t.match(/[\d.]+\s*(?:GB|MB)/i) && !size) size = t;
        });
      }
      blocks.push({ title: quality || 'Download', quality, size, greenmotorsHrefs: [], legacyHubcloudHrefs: [href] });
    });
  }

  console.log('[4KHDHubOne] Found ' + blocks.length + ' file blocks (movie)');
  return blocks;
}

// Extract download entries from a series post page, filtered by season/episode
// 2026-09 layout: .season-content > .season-item.episode-item
//   .episode-number = "S05" (season), .episode-download-item per file with
//   .badge-psa = "Episode-01" and .episode-file-title = filename
function extractEpisodeLinks(html, targetSeason, targetEpisode) {
  const $ = cheerio.load(html);
  const blocks = [];

  // 2026-09+ layout drift: some posts pack MULTIPLE seasons into ONE
  // .season-content block (e.g. kaiju-no-8-series-50 holds S01/S02/S04 items),
  // so a block-level "first .episode-number == S{target}" filter discards every
  // item. Resolve the season PER ITEM instead:
  //   1. item file title "…S01E01…" (most precise — the actual file's tag)
  //   2. nearest .episode-number in the enclosing .download-item header
  //   3. legacy block-level first .episode-number (old one-season-per-block layout)
  $('.season-content').each((_i, seasonEl) => {
    $(seasonEl).find('.episode-download-item').each((_j, el) => {
      const $el = $(el);
      const itemTitle = ($el.find('.episode-file-title').first().text() || '').trim();
      const titleMatch = itemTitle.match(/S(\d{1,2})E(\d{1,3})/i);
      let itemSeason = titleMatch ? parseInt(titleMatch[1]) : null;
      let itemEpisode = titleMatch ? parseInt(titleMatch[2]) : null;

      if (itemSeason === null || itemEpisode === null) {
        // Episode fallback: badge-psa "Episode-NN" (packs list every episode file)
        if (itemEpisode === null && targetEpisode) {
          const psa = ($el.find('.badge-psa').first().text() || '').trim();
          const m = psa.match(/Episode[-\s]*0*(\d{1,3})/i);
          if (m) itemEpisode = parseInt(m[1]);
        }
        // Season fallback: enclosing .download-item header badge
        if (itemSeason === null) {
          const headerNum = $el.closest('.download-item').find('.episode-number').first().text().trim();
          const hNum = headerNum.match(/S(\d+)/)?.[1];
          if (hNum) itemSeason = parseInt(hNum);
        }
        // Season fallback: legacy block-level first .episode-number
        if (itemSeason === null) {
          const seasonText = $(seasonEl).find('.episode-number').first().text().trim();
          const sNum = seasonText.match(/S(\d+)/)?.[1];
          if (sNum) itemSeason = parseInt(sNum);
        }
      }

      if (itemSeason !== null && itemSeason !== targetSeason) return;
      if (itemEpisode !== null && targetEpisode && itemEpisode !== targetEpisode) return;

      const parsed = parseFileBlock($, el);
      if (parsed && (parsed.greenmotorsHrefs.length || parsed.legacyHubcloudHrefs.length)) {
        blocks.push(parsed);
      }
    });
  });

  // Legacy fallback: any hubcloud anchor inside the season block
  if (blocks.length === 0) {
    $('.season-content').each((_i, seasonEl) => {
      const seasonText = $(seasonEl).find('.episode-number').first().text().trim();
      const seasonNum = seasonText.match(/S(\d+)/)?.[1];
      if (!seasonNum || parseInt(seasonNum) !== targetSeason) return;
      $(seasonEl).find('a[href*="hubcloud"]').each((_j, el) => {
        const href = ($(el).attr('href') || '').replace(/&amp;/g, '&');
        if (href) blocks.push({ title: 'Download', quality: '', size: '', greenmotorsHrefs: [], legacyHubcloudHrefs: [href] });
      });
    });
  }

  console.log('[4KHDHubOne] Found ' + blocks.length + ' file blocks (S' + String(targetSeason).padStart(2, '0') + 'E' + String(targetEpisode).padStart(2, '0') + ')');
  return blocks;
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

// Resolve file blocks → concrete file URLs (greenmotors-decoded or legacy)
// Returns [{ url, quality, size, title }] with hubdrive.pics skipped.
// PERF: greenmotors decodes are ~0.5-2s each; decoding ALL blocks (14+ for a
// season episode) took 20s+ and blew the resolver budget. Batches of 8 with
// early-exit once `limit` unique URLs are in hand keep this at ~1 round.
async function resolveBlocks(blocks, limit, fetcher, ctx) {
  const out = [];
  const seenUrls = new Set();
  const seenQualities = new Set();

  // Collect resolution jobs: prefer greenmotors, then legacy hrefs
  const jobs = [];
  for (const b of blocks) {
    if (b.greenmotorsHrefs.length) jobs.push({ block: b, href: b.greenmotorsHrefs[0], via: 'greenmotors' });
    else if (b.legacyHubcloudHrefs.length) jobs.push({ block: b, href: b.legacyHubcloudHrefs[0], via: 'legacy' });
  }
  // 4K-first, then highest size — best variants resolve in the first batch
  const qRank = q => /2160|4k/i.test(q) ? 0 : /1080/i.test(q) ? 1 : /720/i.test(q) ? 2 : 3;
  jobs.sort((a, b) => {
    const d = qRank(a.block.quality) - qRank(b.block.quality);
    if (d !== 0) return d;
    return (parseFloat(b.block.size) || 0) - (parseFloat(a.block.size) || 0);
  });

  // Cap parallel greenmotors fetches to keep the resolve inside budget
  const CAP = 8;
  for (let i = 0; i < jobs.length && out.length < limit; i += CAP) {
    const batch = jobs.slice(i, i + CAP);
    const vals = await Promise.all(batch.map(j =>
      (j.via === 'greenmotors' ? resolveGreenmotorsCached(j.href, fetcher, ctx) : Promise.resolve({ url: j.href, host: new URL(j.href).hostname }))
        .catch(() => null)
    ));
    for (let k = 0; k < vals.length && out.length < limit; k++) {
      const val = vals[k];
      if (!val || !val.url) continue;
      // hubdrive.pics is login-gated (401 for guests) — the hubcloud.ist twin
      // of the same quality covers it; skip to avoid dead cards.
      if (val.host.includes('hubdrive.pics')) continue;
      if (seenUrls.has(val.url)) continue;
      // Quality diversity: at most 3 editions per quality tier
      const qKey = (batch[k].block.quality || 'na').toLowerCase();
      const qCount = out.filter(o => (o.quality || 'na').toLowerCase() === qKey).length;
      if (qCount >= 3 && out.length >= 2) continue;
      seenUrls.add(val.url);
      out.push({ url: val.url, quality: batch[k].block.quality, size: batch[k].block.size, title: batch[k].block.title });
    }
  }
  return out;
}

// Main: getStreams
// Task 57: optional 5th param `preloaded` ({fetcher, ctx}) — when provided,
// ALL upstream GETs route through the addon Fetcher (family:4, node-level
// timeout, got-scraping CF fallback). Fixes the merged-resolve 35s timeout:
// bare undici fetch stalls in DNS under 15-source contention (isolated 0.8s
// vs merged 35s+ — /debug/stream evidence, Task 55 DNS-stall class).
async function getStreams(tmdbId, type, season, episode, preloaded) {
  const fetcher = preloaded?.fetcher || null;
  const ctx = preloaded?.ctx || null;
  const isMovie = type !== 'tv';
  console.log('[4KHDHubOne] Request: tmdb=' + tmdbId + ' type=' + type + (fetcher ? ' (Fetcher transport)' : ' (bare fetch)'));

  const info = await getTMDBInfo(tmdbId, type, fetcher, ctx);
  if (!info.title) return [];
  console.log('[4KHDHubOne] TMDB: ' + info.title + ' (' + info.year + ')');

  const results = await search(info.title, fetcher, ctx);
  if (!results.length) return [];

  const match = await findBestMatch(results, info.title, info.year, isMovie, fetcher, ctx);
  if (!match) return [];

  // If findBestMatch already fetched the page HTML (for year matching),
  // reuse it to avoid an extra HTTP roundtrip.
  let html;
  if (match._html) {
    html = match._html;
    console.log('[4KHDHubOne] Reusing cached post page (' + html.length + ' chars)');
  } else {
    html = await fetchText(match.url, { fetcher, ctx });
    console.log('[4KHDHubOne] Post page: ' + match.url + ' (' + html.length + ' chars)');
  }

  const targetSeason = season || 1;
  const targetEpisode = episode || 1;
  const blocks = isMovie
    ? extractMovieLinks(html)
    : extractEpisodeLinks(html, targetSeason, targetEpisode);

  if (!blocks.length) {
    console.log('[4KHDHubOne] No download links found');
    return [];
  }

  // Task 53: series resolves fewer blocks than movies. The post-episode chain
  // (greenmotors decode + hubcloud extract per block) inflates 2-3s local →
  // 35-95s on Render's 0.1-CPU under resolver contention — the background
  // continuation then misses the next refresh entirely ("4khdhub not showing
  // until I refresh 4-5 times"). 4 blocks (4K-first order preserved by
  // resolveBlocks' qRank sort) cuts the fetch count ~1/3 so the chain
  // completes in ~25-35s and caches (15min TTL) for refresh 2-3.
  const resolved = await resolveBlocks(blocks, isMovie ? 6 : 4, fetcher, ctx);
  console.log('[4KHDHubOne] Resolved ' + resolved.length + ' file URLs');

  const epSuffix = isMovie ? '' : ' S' + String(season || 1).padStart(2, '0') + 'E' + String(episode || 1).padStart(2, '0');

  return resolved.map(l => ({
    name: '4KHDHubOne - ' + (l.quality || 'Download') + (l.size ? ' - ' + l.size : ''),
    title: info.title + epSuffix + ' ' + (l.quality || '') + (l.size ? ' [' + l.size + ']' : ''),
    url: l.url,
    quality: l.quality || '',
    size: l.size || '',
    type: 'video/mkv',
    headers: { 'User-Agent': UA },
    behaviorHints: { bingeGroup: '4khdhubone-' + (l.quality || 'default') },
  }));
}

module.exports = { getStreams, resolveGreenmotors, extractMovieLinks, extractEpisodeLinks };
