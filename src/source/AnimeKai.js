// src/source/AnimeKai.js
// animekai.at — anime with sub+dub HLS streams
//
// Flow (verified live, pure Node.js — no Playwright):
//   1. Search: GET /?s={query} via curl → /watch/{slug}/
//   2. Watch page: GET /watch/{slug}/ via curl → extract POST_ID, MAL_ID, SUB_COUNT, DUB_COUNT
//   3. Stream: GET https://zokoanime.video/stream/mal/{MAL_ID}/{ep}/{sub|dub}
//   4. Deobfuscate: base64decode(window.__P) → XOR("otaku-embed-v1") → JSON → {src: m3u8}
//   5. Play m3u8 with Referer: https://zokoanime.video/
//
// Both SUB (Japanese audio) and DUB (English audio) supported.
// animekai.at uses CF JS Detection — requires system curl for search/info fetch.
// zokoanime.video is accessible via got-scraping.

import { execSync } from 'child_process';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import * as cheerio from 'cheerio';
import { OTAKU_XOR_KEY } from '../utils/site-secrets.cjs';

const BASE = 'https://animekai.at';
const ZOKO = 'https://zokoanime.video';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const OBF_KEY = OTAKU_XOR_KEY; // central registry — env OTAKU_XOR_KEY overrides (site-secrets.cjs)
const REFERER = 'https://zokoanime.video/';

// ---------------------------------------------------------------------------
// Task 64: zokoanime.video DIRECT path (bypasses the animekai.at CF gate).
// Production evidence: animekai.at hard-403s Render egress ("Just a moment",
// both plain fetch and got-scraping), while zokoanime.video — the actual
// stream host animekai embeds — serves its /stream/mal/… payloads to Render
// (verified 200 + __P payload through /debug/rawfetch). The MAL id comes
// from AniList GraphQL (reliable, season-aware, exposes idMal).
// ---------------------------------------------------------------------------
const ANILIST_QUERY = `query ($search: String) { Page(perPage: 8) { media(search: $search, type: ANIME) { idMal startDate { year } title { romaji english } } } }`;

async function anilistSearchMalIds(search) {
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { search } }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const j = await res.json();
    const media = j?.data?.Page?.media || [];
    return media.filter(m => m.idMal).map(m => ({
      malId: m.idMal,
      romaji: (m.title?.romaji || '').toString(),
      english: (m.title?.english || '').toString(),
      year: m.startDate?.year || null,
    }));
  } catch { return []; }
}

const ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
const norm = (s) => (s || '').toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Pick the AniList entry whose title matches the TMDB name (+ season hints).
function pickMalEntry(entries, name, season) {
  const nameNorm = norm(name);
  const seasonNum = Number(season) || 1;
  let best = null;
  let bestScore = 0;
  for (const e of entries) {
    for (const t of [e.romaji, e.english]) {
      const tNorm = norm(t);
      if (!tNorm) continue;
      let score = 0;
      if (tNorm === nameNorm) score = 100;
      else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
        score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
      }
      if (score === 0) continue;
      // Season alignment: the base entry (no season suffix) maps to season 1;
      // "Nth season"/"Season N" titles map to season N.
      const mNth = tNorm.match(/(\d+)(?:nd|rd|th|st) season/) || tNorm.match(/season (\d+)/);
      const entrySeason = mNth ? Number(mNth[1]) : 1;
      if (entrySeason === seasonNum) score += 25;
      else if (seasonNum > 1) score -= 20; // prefer suffix-matching entries
      if (score > bestScore) { bestScore = score; best = e; }
    }
  }
  return bestScore >= 60 ? best : null;
}

// Fetch a zoko stream payload for one audio category. Returns {src, subtitles}.
// Task 64: zoko serves a compact no-player variant to some transports —
// production measured got(h2) 2714B vs plain-fetch 4107B for the same URL
// (the short page lacks __P). Ladder: got h2 → got h1 → plain fetch.
async function zokoStream(malId, episode, category) {
  const streamUrl = `${ZOKO}/stream/mal/${malId}/${episode}/${category}`;
  const extract = (html) => {
    if (!html) return null;
    const m = html.match(/window\.__P="([^"]+)"/);
    if (!m) return null;
    try { return deobfuscate(m[1]); } catch { return null; }
  };
  // got-scraping transports (browser TLS)
  for (const http2 of [true, false]) {
    const html = await gotPage(streamUrl, `${BASE}/`, http2);
    const data = extract(html);
    if (data) return data;
  }
  // plain fetch — the transport /debug/rawfetch proved lands the full Player page
  try {
    const res = await fetch(streamUrl, {
      headers: { 'User-Agent': UA, Referer: `${BASE}/` },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) return extract(await res.text());
  } catch { /* fallthrough */ }
  return null;
}

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

// Use system curl for CF-protected pages (animekai.at has CF JS Detection)
function curlGet(url, referer) {
  try {
    const refHeader = referer ? ` -H "Referer: ${referer}"` : '';
    return execSync(
      `curl -sS -L --max-time 10 -A "${UA}"${refHeader} "${url}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 12000 }
    );
  } catch { return null; }
}

// Task 52: got-scraping transport with h2→h1 fallback. On Render: curl is
// ABSENT (node:20-slim) and a single h2 attempt dies (GOAWAY class — Task 51
// evidence). h1 keeps the same browser JA3, which is what animekai.at's
// passive CF actually gates on (plain node TLS 403s even locally; curl and
// got-scraping pass).
async function gotPage(url, referer, http2Override) {
  const attempts = http2Override === undefined ? [true, false] : [http2Override];
  for (const http2 of attempts) {
    try {
      const res = await gotScraping.get(url, {
        headers: { ...hg.getHeaders({ httpVersion: http2 ? '2' : '1' }), 'User-Agent': UA, 'Accept': 'text/html,*/*', ...(referer && { Referer: referer }) },
        timeout: { request: 12000 }, throwHttpErrors: false, http2,
      });
      if (res.statusCode === 200 && res.body) {
        console.log(`[AnimeKai] got(${http2 ? 'h2' : 'h1'}) 200 len=${String(res.body).length} for ${url.slice(0, 70)}`);
        return res.body;
      }
      if (res.statusCode !== 200) console.log(`[AnimeKai] got(${http2 ? 'h2' : 'h1'}) HTTP ${res.statusCode} for ${url.slice(0, 70)}`);
    } catch (e) {
      console.log(`[AnimeKai] got(${http2 ? 'h2' : 'h1'}) failed: ${String(e?.message || e).slice(0, 70)}`);
    }
  }
  return null;
}

function deobfuscate(p) {
  const padded = p + '='.repeat((4 - (p.length % 4)) % 4);
  const raw = Buffer.from(padded, 'base64');
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw[i] ^ OBF_KEY.charCodeAt(i % OBF_KEY.length);
  }
  return JSON.parse(out.toString('utf-8'));
}

// Fetch stream URL from zokoanime.video
async function getStream(malId, episode, type) {
  const streamUrl = `${ZOKO}/stream/mal/${malId}/${episode}/${type}`;
  const html = await gotPage(streamUrl, `${BASE}/`);
  if (!html) return null;
  const m = html.match(/window\.__P="([^"]+)"/);
  if (!m) return null;
  try { return deobfuscate(m[1]); } catch { return null; }
}

// Task 41b: parse watch links from a search page (shared by curl + got paths)
function parseWatchLinks(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const results = [];
  const bySlug = new Map();
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/watch\/([^/]+)\/?$/);
    if (!m) return;
    const text = $(el).text().trim();
    if (!bySlug.has(m[1])) {
      bySlug.set(m[1], { title: text || m[1].replace(/-/g, ' '), slug: m[1] });
    } else if (text.length > bySlug.get(m[1]).title.length) {
      // poster-card anchors have empty text; a later anchor may carry the
      // real title — prefer the most informative occurrence
      bySlug.get(m[1]).title = text;
    }
  });
  bySlug.forEach(v => results.push(v));
  return results;
}

// got-scraping fallback when plain curl comes back empty (CF TLS fingerprinting)
// — now with h2→h1 inside gotPage (Task 52).
async function gotSearch(query) {
  return gotPage(`${BASE}/?s=${encodeURIComponent(query)}`);
}

export class AnimeKai extends Source {
  constructor(fetcher) {
    super();
    this.id = 'animekai';
    this.label = 'AnimeKai';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = BASE;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const titleBase = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);
    const epNum = tmdbId.season ? (tmdbId.episode || 1) : 1;

    const buildResults = async (malId, sourceTag) => {
      const results2 = [];
      const seenUrls = new Set();
      for (const category of ['sub', 'dub']) {
        try {
          const data = await zokoStream(malId, epNum, category);
          if (!data?.src || seenUrls.has(data.src)) continue;
          seenUrls.add(data.src);

          let parsed;
          try { parsed = new URL(data.src); } catch { continue; }

          const audioLabel = category === 'dub' ? 'DUB' : 'SUB';
          const countryCodes = category === 'dub'
            ? [CountryCode.multi, CountryCode.en]
            : [CountryCode.multi, CountryCode.ja];

          const subs = Array.isArray(data.subtitles)
            ? data.subtitles
                .filter(s => s?.src && typeof s.src === 'string')
                .map((s, i) => {
                  const lang = (s.lang || s.label || 'en').toString().slice(0, 8);
                  try {
                    return { id: `${lang}${i}`.slice(0, 8), url: new URL(s.src).href, lang };
                  } catch { return null; }
                })
                .filter(Boolean)
            : [];

          results2.push({
            url: parsed,
            format: Format.hls,
            meta: {
              countryCodes,
              title: `${titleBase} (AnimeKai ${audioLabel}${sourceTag})`,
              sourceId: this.id,
              sourceLabel: this.label,
              height: 1080,
              ...(subs.length > 0 && { subtitles: subs }),
            },
          });
        } catch { /* skip */ }
      }
      return results2;
    };

    // Task 64 DIRECT path: AniList idMal → zoko stream. Works from Render
    // egress (zokoanime.video is not CF-gated) where the animekai.at search
    // chain 403s. Season-aware via AniList "Nth Season" title alignment.
    try {
      const seasonNum = Number(tmdbId.season) || 1;
      const queries = seasonNum > 1 ? [`${name} ${ORDINALS[seasonNum] || seasonNum + 'th'} season`, name] : [name];
      for (const q of queries) {
        const entries = await anilistSearchMalIds(q);
        const picked = pickMalEntry(entries, name, seasonNum);
        if (!picked) continue;
        console.log(`[AnimeKai] direct path: mal=${picked.malId} ("${picked.romaji || picked.english}") via "${q}"`);
        const direct = await buildResults(picked.malId, '');
        if (direct.length > 0) {
          console.log(`[AnimeKai] S${tmdbId.season || 1}E${epNum} mal=${picked.malId} → ${direct.length} stream(s) (direct)`);
          return direct;
        }
      }
    } catch { /* fall through to the site-search chain */ }

    // Task 41b: Step 1 — progressive site search (fallback; works when
    // animekai.at's CF relents, e.g. from residential/device egress).
    const candidates = [];
    const push = (t) => {
      const v = (t || '').trim();
      if (v.length >= 3 && !candidates.includes(v)) candidates.push(v);
    };
    push(name);
    const colonIdx = name.search(/[:–—]\s/);
    if (colonIdx > 0) push(name.slice(0, colonIdx).trim());
    const words = name.split(/\s+/);
    if (words.length > 2) push(words.slice(0, 2).join(' '));
    if (words.length > 1) push(words[0]);

    let results = [];
    let usedCandidate = '';
    for (const cand of candidates) {
      let searchHtml = curlGet(`${BASE}/?s=${encodeURIComponent(cand)}`);
      let parsed = parseWatchLinks(searchHtml);
      if (!parsed.length) {
        searchHtml = await gotSearch(cand);
        parsed = parseWatchLinks(searchHtml);
      }
      if (parsed.length) { results = parsed; usedCandidate = cand; break; }
    }
    console.log(`[AnimeKai] search "${name}" → candidate "${usedCandidate}" → ${results.length} hits`);
    if (!results.length) return [];

    // Pick best match — require fuzzy score >= 60 to avoid false matches
    // Apostrophes are dropped BEFORE tokenizing so "Journey's" == "journeys"
    // (TMDB title text vs site slug artifact otherwise never converge).
    const normalize = (s) => s.toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const nameNorm = normalize(name);
    let best = null;
    let bestScore = 0;
    for (const r of results) {
      const tNorm = normalize(r.title);
      if (!tNorm) continue;
      let score = 0;
      if (tNorm === nameNorm) score = 100;
      else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
        score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
      }
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (!best || bestScore < 60) {
      console.log(`[AnimeKai] no match >=60 (best=${best ? bestScore.toFixed(1) : 'none'}) for "${name}"`);
      return [];
    }
    console.log(`[AnimeKai] matched "${best.slug}" (score=${bestScore.toFixed(1)})`);

    // Step 2: Get anime info (POST_ID, MAL_ID) — curl first (local), then the
    // got-scraping h2→h1 chain. Production note (Task 52): the deployed Render
    // image HAS curl but animekai.at CF-403s it, so the got h1 transport is
    // the one that lands. If the fetched shell lacks the MAL_ID var (challenge
    // or variant page), fall back to the myanimelist.net/anime/<id>/ link that
    // every watch page carries.
    const extractMalId = (html) => html?.match(/MAL_ID\s*=\s*["']?(\d+)["']?/)?.[1]
      || html?.match(/myanimelist\.net\/anime\/(\d+)\//)?.[1]
      || null;
    const watchUrl = `${BASE}/watch/${best.slug}/`;
    let watchHtml = curlGet(watchUrl, `${BASE}/`);
    let malId = extractMalId(watchHtml);
    if (!malId) {
      const gotHtml = await gotPage(watchUrl, `${BASE}/`);
      if (gotHtml) {
        malId = extractMalId(gotHtml);
        if (malId) watchHtml = gotHtml;
      }
    }
    if (!watchHtml) {
      console.log('[AnimeKai] watch page fetch failed');
      return [];
    }

    if (!malId) {
      console.log(`[AnimeKai] MAL_ID not found on watch page (len=${watchHtml.length})`);
      return [];
    }

    // Step 3: Fetch streams for both sub and dub via zokoanime.video
    const results2 = [];
    const seenUrls = new Set();

    for (const category of ['sub', 'dub']) {
      try {
        const data = await getStream(malId, epNum, category);
        if (!data?.src || seenUrls.has(data.src)) continue;
        seenUrls.add(data.src);

        let parsed;
        try { parsed = new URL(data.src); } catch { continue; }

        const audioLabel = category === 'dub' ? 'DUB' : 'SUB';
        const countryCodes = category === 'dub'
          ? [CountryCode.multi, CountryCode.en]
          : [CountryCode.multi, CountryCode.ja];

        // Task 41b: attach the stream's real inline subtitles (zoko payload
        // carries {lang, label, src} VTT tracks per audio category).
        const subs = Array.isArray(data.subtitles)
          ? data.subtitles
              .filter(s => s?.src && typeof s.src === 'string')
              .map((s, i) => {
                const lang = (s.lang || s.label || 'en').toString().slice(0, 8);
                try {
                  return { id: `${lang}${i}`.slice(0, 8), url: new URL(s.src).href, lang };
                } catch { return null; }
              })
              .filter(Boolean)
          : [];

        results2.push({
          url: parsed,
          format: Format.hls,
          meta: {
            countryCodes,
            title: `${titleBase} (AnimeKai ${audioLabel})`,
            sourceId: this.id,
            sourceLabel: this.label,
            height: 1080,
            ...(subs.length > 0 && { subtitles: subs }),
          },
        });
      } catch { /* skip */ }
    }
    console.log(`[AnimeKai] S${tmdbId.season || 1}E${epNum} mal=${malId} → ${results2.length} stream(s) (sub+dub attempted)`);
    return results2;
  }
}
