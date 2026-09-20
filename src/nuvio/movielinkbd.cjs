// src/nuvio/movielinkbd.cjs
// movielinkbd.one / movielinkbd.pw / ssged4.movielinkbd.li — MovieLinkBD
// Official. Movies / series / kdrama / cdrama / jdrama / animes / cartoons,
// MULTI-REGIONAL (language taxonomy: english, korean, chinese, japanese,
// french, italian, portuguese, bangla, hindi, tamil, telugu, ...), up to
// 4K/2160p. Task 58 v2 (2026-09-19) — full reverse engineering.
//
// SITE ARCHITECTURE (verified live on the open w23gdv.movielinkbd.pw mirror):
//   - Discovery : GET {base}/search?q=<query> (HTML) → links
//                 /movie/mKs_* /series/mKs_* /anime/mKs_* /drama/mKs_* + titles
//   - Content   : GET {base}/<section>/mKs_* → the page embeds a machine-
//                 readable JSON blob: <script id="mlbdInlinePlayerData"
//                 type="application/json"> with title, poster (TMDB/IMDb),
//                 content_type, episodes[{number, label, season, kind,
//                 sources[...]}]
//   - Sources[] : name  = REAL filename (e.g. "MovieLinkBD.com -
//                 Kattalan.2026.2160p.Hindi.AAC.WEB-DL.HEVC.h265.ESub.mkv",
//                 "Flex.x.Cop.S02E01.720p.Korean.AAC.WEB-DL.h264.ESub.mkv")
//                 quality/is_best/quality_label/codec/hevc/audio_languages,
//                 url      = https://cdn.dramalinkbd.tv/p/<token> (player)
//                 download_url = https://cdn.dramalinkbd.tv/d/<token>
//                 external_subtitles[] = {language, label, url} → WEBVTT
//   - CDN       : cdn.dramalinkbd.tv serves video/x-matroska with
//                 accept-ranges: bytes (206 mid-file verified), CORS *,
//                 access-control-allow-origin * — DIRECT playable, native
//                 seeking, no proxy needed. Tokens are time-limited (the
//                 health_token exp ≈ 8 days; a refresh regenerates anyway).
//
// QUALITY TRUTH: the `quality` field LIES for 4K (measured: the 2160p file
// carries quality:720 + is_best:true + quality_label:"Best Quality"). The
// FILENAME is ground truth — parse 2160p/1080p/720p/480p from `name`.
//
// SEASONS: posts are season-specific ("Squid Game (2024) Season 2",
// "Flex x Cop Season 2"); the blob's `season` is null on these. Requested
// season comes from the POST TITLE, verified by the filename SxxExx.
//
// SUBTITLES: the site serves separate WEBVTT tracks (text/vtt, CORS *)
// per source when available — shipped as Stremio subtitle tracks alongside
// the addon-wide unified granite+natsuki stack (which still runs for every
// card like every other source).
//
// MULTI-AUDIO: audio_languages e.g. ['Hindi','Japanese','English'] (anime
// sub+dub), ['Korean'] (kdrama subs), Multi[Hindi-Tamil-Telugu-Malayalam].
// Both sub & dub live in ONE file per quality.
//
// MIRRORS: w23gdv.movielinkbd.pw (open, datacenter-friendly), vpha33.
// movielinkbd.pw (redirects to the current rotating subdomain), apex
// movielinkbd.pw, and the CF-gated ssged4.movielinkbd.li / movielinkbd.one
// (403 from datacenter IPs — kept as last-resort candidates; the probe
// drops them when challenged). movielinkbd.NET is a DIFFERENT (older,
// BD-only, no-4K) site — deliberately NOT used (user instruction).
//
// Task 57 pattern: ALL upstream GETs route through the addon Fetcher
// (preloaded {fetcher, ctx}) — family:4, node-level timeout, got-scraping
// CF fallback; bare fetch remains the fallback for local tooling.

'use strict';

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const BASE_CANDIDATES = [
  'https://w23gdv.movielinkbd.pw',   // verified-open rotating subdomain
  'https://vpha33.movielinkbd.pw',   // redirects to the current one
  'https://movielinkbd.pw',          // apex
  'https://ssged4.movielinkbd.li',   // CF-gated (user-provided URL)
  'https://movielinkbd.one',         // CF-gated official alternative
];
// Page-fetch UA: the TRUNCATED UA (cf-fetch.cjs §4.2 precedent) — the site
// poisons /p/ tokens for page fetches that claim a full Chrome build while
// presenting non-Chrome TLS (measured live: full-UA Fetcher fetches returned
// blobs whose tokens 403 "FILE DELETED" instantly, short-UA fetches return
// tokens that stream 206 for the whole rotation window).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const SEARCH_TIMEOUT = 12000;
const PAGE_TIMEOUT = 12000;
const PROBE_TIMEOUT = 8000;
const PAGE_CAP = 6;        // max content pages fetched in parallel (TV seasons live in different posts)
const MOVIE_PAGE_CAP = 2;  // movies live in one post; 2 covers split editions
const BASE_CACHE_TTL = 10 * 60 * 1000;
let _baseCache = { url: null, ts: 0 };

// Safe error brief — error objects from Fetcher/AbortSignal can carry EMPTY
// or non-string messages; falling back to the raw object then calling .slice
// crashes the catch handler itself and MASKS the real failure (Task 58 v1
// lesson, kept for v2).
function errBrief(e) {
  if (e instanceof Error && e.message) return String(e.message).slice(0, 80);
  if (typeof e === 'string') return e.slice(0, 80);
  const parts = [];
  if (e && typeof e === 'object') {
    if (e.status || e.statusCode) parts.push(`status ${e.status || e.statusCode}`);
    if (e.statusText) parts.push(String(e.statusText));
    if (e.code) parts.push(String(e.code));
  }
  return (parts.join(' ') || 'unknown error').slice(0, 80);
}

async function fetchText(url, options = {}) {
  const { fetcher, ctx, timeout = 15000, headers = {} } = options;
  // PRIMARY: got-scraping (HTTP/2 + browser TLS fingerprint). The site arms/
  // disarms /p/ tokens based on HOW the page was fetched — tokens from pages
  // delivered to Node's HTTP/1.1 https.request come back "FILE DELETED" (403)
  // even though the token STRING is identical, while pages fetched via
  // browser-like h2 clients (curl, got-scraping) yield tokens that stream 206
  // for the whole rotation window (measured live, Task 58 v2). The addon
  // Fetcher stays the CF-fallback for hosts that need its cookie jar.
  const isSite = /movielinkbd\.(pw|one|li)/.test(String(url));
  if (isSite) {
    try {
      const { gotScraping } = await import('got-scraping');
      const resp = await gotScraping.get(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...headers },
        timeout: { request: timeout },
        throwHttpErrors: false,
        followRedirect: true,
      });
      if (resp.statusCode === 404) return '';
      if (resp.statusCode >= 200 && resp.statusCode < 400) return resp.body;
      if (resp.statusCode === 403 || resp.statusCode === 503) {
        // fall through to the Fetcher (its got-scraping path has the cookie jar)
      } else {
        return '';
      }
    } catch { /* fall through to Fetcher */ }
  }
  if (fetcher && ctx) {
    try {
      return await fetcher.text(ctx, new URL(url), {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*', ...headers },
        timeout,
      });
    } catch (e) {
      const status = e?.status || e?.statusCode || 0;
      if (status === 404) return '';
      throw e;
    }
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': UA, ...headers } });
  if (!r.ok) return '';
  return r.text();
}

// Base resolution: first candidate that answers with the real site (not a
// CF challenge). Cached 10min; re-probes expire automatically.
async function getBase(fetcher, ctx) {
  const now = Date.now();
  if (_baseCache.url && now - _baseCache.ts < BASE_CACHE_TTL) return _baseCache.url;
  for (const base of BASE_CANDIDATES) {
    try {
      const html = await fetchText(base + '/', { fetcher, ctx, timeout: PROBE_TIMEOUT });
      if (html && html.includes('MovieLinkBD') && !html.includes('Just a moment')) {
        _baseCache = { url: base, ts: now };
        return base;
      }
    } catch { /* next candidate */ }
  }
  // nothing answered — fall back to the first candidate (the fetch itself
  // will surface the error state downstream)
  return BASE_CANDIDATES[0];
}

async function getTMDBInfo(tmdbId, mediaType, fetcher, ctx) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  try {
    const raw = await fetchText(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}`, { fetcher, ctx, timeout: 8000 });
    const d = JSON.parse(raw);
    return {
      title: (type === 'tv' ? d.name : d.title) || '',
      originalTitle: d.original_title || d.original_name || '',
      year: ((d.first_air_date || d.release_date || '') + '').split('-')[0],
    };
  } catch { return { title: '', originalTitle: '', year: '' }; }
}

function normalize(s) {
  return String(s || '').toLowerCase()
    .replace(/&#0*38;|&amp;/g, '&')
    .replace(/&[a-z#0-9]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&#0*39;|&apos;|&#8217;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"').replace(/&ndash;/g, '-').replace(/&mdash;/g, '—')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

// Search: /search?q= HTML → result entries (section path + title)
async function searchContent(title, fetcher, ctx) {
  const base = await getBase(fetcher, ctx);
  const url = `${base}/search?q=${encodeURIComponent(title)}`;
  let html = '';
  try {
    html = await fetchText(url, { fetcher, ctx, timeout: SEARCH_TIMEOUT });
  } catch (e) {
    console.error('[MovieLinkBD] search error: ' + errBrief(e));
    return [];
  }
  if (!html) return [];
  // NOTE: each result appears as TWO anchors — an image card (no text)
  // followed by the titled link. Dedupe per path but keep the first
  // NON-EMPTY title (adding the path on the empty anchor would drop the
  // real entry — found live in the first v2 parse).
  const byPath = new Map();
  const re = /<a[^>]*href="(\/(?:movie|series|anime|drama)\/mKs_[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const path = m[1];
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
    const existing = byPath.get(path);
    if (existing !== undefined) {
      if (!existing && text) byPath.set(path, text);
      continue;
    }
    byPath.set(path, text);
  }
  const results = [];
  for (const [path, title] of byPath) {
    if (!title) continue;
    results.push({ path: base + path, section: path.split('/')[1], title });
  }
  return results;
}

// Candidate ranking: normalized-title containment mandatory; score = name
// equality + year. TV keeps several candidates (seasons live in different
// posts: "Squid Game (2021) season 1" vs "(2024) Season 2").
function rankCandidates(posts, info) {
  const nameNorm = normalize(info.title);
  const origNorm = normalize(info.originalTitle);
  const words = nameNorm.split(' ').filter(w => w.length > 2);
  const scored = [];
  for (const p of posts) {
    const tNorm = normalize(p.title);
    const hasName = (nameNorm && tNorm.includes(nameNorm)) || (origNorm && tNorm.includes(origNorm));
    const wordHits = words.filter(w => tNorm.includes(w)).length;
    if (!hasName && words.length > 0 && wordHits / words.length < 0.6) continue;
    let score = hasName ? 4 : wordHits;
    if (origNorm && tNorm.includes(origNorm)) score += 2;
    const ym = p.title.match(/\b(19|20)\d{2}\b/);
    if (info.year && ym && ym[0] === String(info.year)) score += 2;
    scored.push({ ...p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// Content page → mlbdInlinePlayerData JSON
function parseContentPage(html) {
  const m = html.match(/<script id="mlbdInlinePlayerData" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  let d;
  try { d = JSON.parse(m[1]); } catch { return null; }
  const episodes = [];
  for (const e of (Array.isArray(d.episodes) ? d.episodes : [])) {
    const sources = [];
    for (const s of (Array.isArray(e.sources) ? e.sources : [])) {
      if (!s || typeof s.url !== 'string' || !/^https:\/\//.test(s.url)) continue;
      sources.push({
        name: String(s.name || '').trim(),
        qualityField: s.quality,
        isBest: !!s.is_best,
        qualityLabel: String(s.quality_label || '').trim(),
        codec: String(s.codec || '').trim(),
        hevc: !!s.hevc,
        type: String(s.type || '').trim(),
        audio: String(s.audio || '').trim(),
        audioLanguages: Array.isArray(s.audio_languages) ? s.audio_languages.map(String) : [],
        url: s.url,
        subtitles: (Array.isArray(s.external_subtitles) ? s.external_subtitles : [])
          .filter(x => x && typeof x.url === 'string' && /^https:\/\//.test(x.url))
          .map(x => ({ language: String(x.language || '').trim(), label: String(x.label || '').trim(), url: x.url })),
      });
    }
    episodes.push({
      label: String(e.label ?? '').trim(),
      number: e.number,
      season: e.season,
      kind: String(e.kind || '').trim(),
      sources,
    });
  }
  return {
    title: String(d.title || '').trim(),
    poster: String(d.poster || '').trim(),
    contentType: String(d.content_type || '').trim(),
    episodes,
  };
}

// Quality from the FILENAME (ground truth — the JSON `quality` field lies
// for 4K: measured 2160p file carried quality:720 + is_best:true).
function nameQuality(name) {
  const s = String(name || '');
  if (/2160|4k\b/i.test(s)) return '2160p';
  const m = s.match(/(\d{3,4})p/i);
  return m ? m[1] + 'p' : '';
}

function qRank(q) {
  const s = String(q || '');
  if (/2160|4k/i.test(s)) return 0;
  if (/1080/.test(s)) return 1;
  if (/720/.test(s)) return 2;
  if (/480/.test(s)) return 3;
  return 4;
}

// Sizes from the page's download-button labels ("Download [480p • 623 MB]",
// "Download [Best Quality 🔥 • 5.5 GB]") — keyed by quality word, order-safe.
function extractSizeMap(html) {
  const out = new Map();
  const re = /Download\s*\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(html))) {
    const inner = decodeEntities(m[1]);
    const sm = inner.match(/([\d.]+)\s*(GB|MB|TB)/i);
    if (!sm) continue;
    const q = /best/i.test(inner) ? 'best' : (inner.match(/(\d{3,4})p/i)?.[0]?.toLowerCase() || '');
    if (q && !out.has(q)) out.set(q, `${sm[1]} ${sm[2].toUpperCase()}`);
  }
  return out;
}

// Post-title season ("Squid Game (2024) Season 2", "[S02 Ep01-09 Added]",
// "Season 02", "S2") — null when the post is a season-1/single-season post.
function titleSeason(title) {
  const t = String(title || '');
  const m = t.match(/\bS(?:eason)?\s*\.?\s*0*(\d{1,2})\b/i);
  return m ? parseInt(m[1]) : null;
}

// Movie filename → request verification (Task 53 wrong-content class).
// ≥80% of significant title words as word-boundary hits in the filename,
// plus a year gate (±1) when both years are known.
function movieFileMatches(fname, title, originalTitle, reqYear) {
  const norm = s => String(s || '').toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const fn = norm(fname);
  let bestRatio = 0, bestWords = 0, bestHits = 0;
  for (const c of [title, originalTitle].map(norm).filter(Boolean)) {
    const words = c.split(' ').filter(w => w.length > 2);
    if (!words.length) continue;
    const hits = words.filter(w => new RegExp(`(^| )${w}( |$)`).test(fn)).length;
    const ratio = hits / words.length;
    if (ratio > bestRatio || (ratio === bestRatio && words.length > bestWords)) {
      bestRatio = ratio; bestWords = words.length; bestHits = hits;
    }
  }
  if (bestWords > 0 && bestRatio < 0.8) {
    return { ok: false, reason: `title words ${bestHits}/${bestWords}` };
  }
  const fy = fname.match(/\b(19|20)\d{2}\b/);
  if (fy && reqYear) {
    const d = Math.abs(parseInt(fy[0]) - parseInt(reqYear));
    if (d > 1) return { ok: false, reason: `year ${fy[0]} vs ${reqYear}` };
  }
  return { ok: true };
}

// Site subtitle language normalization: the API carries language codes
// ('en') or provider names ('MoviesMod.org') in `language`/`label` — map
// proper codes to display names (Stremio groups by this), fall back to the
// label, and only then to 'Unknown'.
const SUB_LANG_NAMES = {
  en: 'English', ko: 'Korean', zh: 'Chinese', ja: 'Japanese', hi: 'Hindi',
  ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada', bn: 'Bengali',
  ar: 'Arabic', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', ru: 'Russian', tr: 'Turkish', id: 'Indonesian', ms: 'Malay',
  th: 'Thai', vi: 'Vietnamese', ur: 'Urdu', fa: 'Persian', pl: 'Polish',
  nl: 'Dutch', sv: 'Swedish', fil: 'Filipino',
};
function subLangName(x) {
  const code = String(x.language || '').toLowerCase().trim();
  if (SUB_LANG_NAMES[code]) return SUB_LANG_NAMES[code];
  const label = String(x.label || '').trim();
  // Provider names like "MoviesMod.org" are NOT language names — skip them.
  if (label && !/\.(com|org|net|io|tv|cc|xyz|me)$/i.test(label)) return label;
  return 'English';
}

// Main ----------------------------------------------------------------------

// getStreams(tmdbId, type, season, episode, preloaded)
// type: 'movie' | 'tv'; preloaded: {fetcher, ctx} (Task 57 transport threading)
async function getStreams(tmdbId, type, season, episode, preloaded) {
  const fetcher = preloaded?.fetcher || null;
  const ctx = preloaded?.ctx || null;
  const isTv = type === 'tv';
  console.log(`[MovieLinkBD] Request: tmdb=${tmdbId} type=${type}` +
    (isTv ? ` S${season}E${episode}` : '') + (fetcher ? ' (Fetcher transport)' : ' (bare fetch)'));

  const info = await getTMDBInfo(tmdbId, type, fetcher, ctx);
  if (!info.title) return [];
  console.log(`[MovieLinkBD] TMDB: ${info.title}${info.year ? ' (' + info.year + ')' : ''}`);

  const posts = await searchContent(info.title, fetcher, ctx);
  if (!posts.length) {
    console.log('[MovieLinkBD] no search results');
    return [];
  }
  const candidates = rankCandidates(posts, info);
  if (!candidates.length) {
    console.log('[MovieLinkBD] no candidates after title ranking');
    return [];
  }

  // Task 65: season-aware post ordering. The site publishes ONE POST PER
  // SEASON ("Game Of Thrones S08 Hindi [ORG] - Complete" ... "Season 1") and
  // relevance ranking alone left the requested season's post OUTSIDE PAGE_CAP
  // (GoT S1 ranked last of 8 → its page never fetched → honest zero for every
  // season-1 episode). Posts matching the requested season (and null-season
  // posts when the request IS season 1) now sort to the front; relevance
  // stays the tiebreaker inside each group.
  if (isTv) {
    const reqSeason = Number(season) || 1;
    const seasonMatch = t => {
      const s = titleSeason(t);
      return s === reqSeason || (s === null && reqSeason === 1);
    };
    candidates.sort((a, b) => {
      const ma = seasonMatch(a.title) ? 0 : 1;
      const mb = seasonMatch(b.title) ? 0 : 1;
      if (ma !== mb) return ma - mb;
      return (b.score || 0) - (a.score || 0);
    });
    console.log(`[MovieLinkBD] season ${reqSeason}: top post now "${candidates[0].title}"`);
  }
  console.log(`[MovieLinkBD] ${candidates.length} candidate post(s), top: ${candidates[0].title}`);

  // Fetch content pages in parallel (cap)
  const cap = isTv ? PAGE_CAP : MOVIE_PAGE_CAP;
  const tops = candidates.slice(0, cap);
  const pages = await Promise.all(tops.map(async c => {
    try {
      const html = await fetchText(c.path, { fetcher, ctx, timeout: PAGE_TIMEOUT });
      const parsed = html ? parseContentPage(html) : null;
      return { post: c, parsed, html };
    } catch { return { post: c, parsed: null, html: '' }; }
  }));

  // Normalize sources → stream jobs
  const jobs = [];
  const targetSeason = isTv ? (Number(season) || 1) : null;
  const targetEpisode = isTv ? (Number(episode) || 1) : null;

  for (const { post, parsed, html } of pages) {
    if (!parsed || !parsed.episodes.length) continue;
    const postSeason = titleSeason(post.title); // null = single-season/season-1 post
    const sizes = extractSizeMap(html || '');

    if (!isTv) {
      // MOVIE: the single episode entry holds every edition
      for (const ep of parsed.episodes) {
        for (const s of ep.sources) {
          jobs.push({ post, parsed, src: s, postSeason, sizes });
        }
      }
    } else {
      // TV: match episode; season = post title season (fallback: filename)
      for (const ep of parsed.episodes) {
        for (const s of ep.sources) {
          const fnameSeason = s.name.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
          const sSeason = fnameSeason ? parseInt(fnameSeason[1]) : (postSeason || 1);
          const sEp = fnameSeason ? parseInt(fnameSeason[2])
            : (Number.isFinite(ep.number) && ep.number !== null ? Number(ep.number)
              : (parseInt(String(ep.label).match(/0*(\d{1,3})/)?.[1] || '')) || null);
          if (sSeason !== targetSeason) continue;
          if (sEp !== targetEpisode) continue;
          jobs.push({ post, parsed, src: s, postSeason, sizes });
        }
      }
    }
  }

  if (!jobs.length) {
    console.log('[MovieLinkBD] no matching sources for the request');
    return [];
  }

  // Dedupe by URL + wrong-content guards, quality-first
  const seen = new Set();
  const unique = jobs.filter(j => !seen.has(j.src.url) && seen.add(j.src.url));
  const accepted = [];
  for (const j of unique) {
    const q = nameQuality(j.src.name) || (j.src.isBest ? '2160p' : '');
    if (!isTv && info.title) {
      const verdict = movieFileMatches(j.src.name, info.title, info.originalTitle, info.year);
      if (!verdict.ok) {
        console.log(`[MovieLinkBD] drop ${j.src.name.slice(0, 60)}: file mismatch: ${verdict.reason}`);
        continue;
      }
    }
    if (isTv && targetSeason && targetEpisode) {
      const m = j.src.name.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
      if (m && (parseInt(m[1]) !== targetSeason || parseInt(m[2]) !== targetEpisode)) {
        console.log(`[MovieLinkBD] drop ${j.src.name.slice(0, 60)}: filename mismatch S${m[1]}E${m[2]}`);
        continue;
      }
    }
    accepted.push({ ...j, quality: q });
  }
  if (!accepted.length) {
    console.log('[MovieLinkBD] all sources dropped by guards (honest zero)');
    return [];
  }
  accepted.sort((a, b) => qRank(a.quality) - qRank(b.quality));

  const epSuffix = isTv ? ` S${String(targetSeason).padStart(2, '0')}E${String(targetEpisode).padStart(2, '0')}` : '';
  return accepted.map(j => {
    const s = j.src;
    const langTag = s.audioLanguages.length ? ` — ${s.audioLanguages.join(', ')}` : (s.audio ? ` — ${s.audio}` : '');
    const size = (j.sizes.get(j.quality.toLowerCase()) || j.sizes.get('best') || '');
    const sizeTag = size && j.quality !== '2160p' ? ` [${size}]` : (size ? ` [${size}]` : '');
    const codecTag = /hevc|h265/i.test(s.name) || s.hevc ? ' HEVC' : '';
    const name = `MovieLinkBD${epSuffix} — ${j.quality}${sizeTag}${codecTag}${langTag}`;
    // Rich title feeds enrichMeta: the real filename carries WEB-DL/HEVC/
    // Hindi/English/ESub; audio languages + subs appended explicitly.
    const subTag = s.subtitles.length ? ` — Subs: ${s.subtitles.map(x => subLangName(x)).join(', ')}` : '';
    const richTitle = `${info.title}${epSuffix} — ${s.name || j.quality}${langTag ? ' — Audio: ' + s.audioLanguages.join(', ') : ''}${subTag}`;
    // Site-provided WEBVTT subtitle tracks (Stremio shape {id, url, lang})
    const subtitles = s.subtitles.map((x, i) => ({
      id: `mlbd-${(x.language || x.label || 's' + i).toLowerCase().replace(/[^a-z0-9]/g, '')}-${i}`,
      url: x.url,
      lang: subLangName(x),
    }));
    return {
      name,
      title: richTitle,
      url: s.url,
      quality: j.quality,
      size,
      filename: s.name,
      audioTracks: s.audioLanguages.join(', ') || s.audio,
      subtitles,
      type: 'video/mkv',
      headers: { 'User-Agent': UA },
      behaviorHints: { bingeGroup: 'movielinkbd' + epSuffix },
    };
  });
}

module.exports = { getStreams, searchContent, parseContentPage, rankCandidates, movieFileMatches, nameQuality, titleSeason, extractSizeMap };
