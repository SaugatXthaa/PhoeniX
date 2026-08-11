// src/source/AnimeGG.js
// animegg.org — anime with sub+dub direct MP4 streams
//
// Flow (verified live, pure Node.js — no Playwright):
//   1. Resolve AniList ID via AniList GraphQL search by title
//   2. Search animegg.org for the series slug
//   3. Get episode list from series page
//   4. Fetch episode page → find iframe embed IDs (sub + dub)
//   5. Fetch embed page → parse videoSources JS array → direct MP4 URLs
//
// Streams require Referer: https://www.animegg.org/ — routed through /proxy.
// Both sub (Japanese audio) and dub (English audio) supported.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const ANIMEGG_BASE = 'https://www.animegg.org';
const ANILIST_GQL = 'https://graphql.anilist.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

async function fetchText(url, referer) {
  const res = await gotScraping.get(url, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'User-Agent': UA, 'Accept': 'text/html', ...(referer && { Referer: referer }) },
    timeout: { request: 12000 }, throwHttpErrors: false, http2: true,
  });
  return res.statusCode === 200 ? res.body : null;
}

// Resolve AniList ID by searching for the anime title
async function resolveAniList(name) {
  const query = `
    query($search: String) {
      Page(page: 1, perPage: 5) {
        media(type: ANIME, search: $search, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
          id idMal title { romaji english } format seasonYear
        }
      }
    }`;
  try {
    const { gotScraping } = await import('got-scraping');
    const res = await gotScraping.post(ANILIST_GQL, {
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { search: name } }),
      timeout: { request: 10000 }, throwHttpErrors: false,
    });
    if (res.statusCode !== 200) return null;
    const data = JSON.parse(res.body);
    return data?.data?.Page?.media || [];
  } catch { return null; }
}

// Search animegg.org for series slugs
async function searchSeries(query) {
  const html = await fetchText(`${ANIMEGG_BASE}/search/?q=${encodeURIComponent(query)}`);
  if (!html) return [];
  const slugs = new Set();
  const matches = html.match(/\/series\/([^"'/?#]+)/g) || [];
  for (const m of matches) {
    const slug = m.replace('/series/', '');
    if (slug.length > 2) slugs.add(slug);
  }
  return [...slugs].map(slug => ({ slug, title: slug.replace(/-/g, ' ') }));
}

// Get episode list from series page
async function getEpisodes(slug) {
  const html = await fetchText(`${ANIMEGG_BASE}/series/${slug}`);
  if (!html) return [];
  const episodes = [];
  const matches = html.match(/href=["']\/([^"'?]*-episode-(\d+))["']/gi) || [];
  const seen = new Set();
  for (const m of matches) {
    const pm = m.match(/\/([^"'?]*-episode-(\d+))/);
    if (!pm || seen.has(pm[2])) continue;
    seen.add(pm[2]);
    episodes.push({ number: parseInt(pm[2]), slug: pm[1] });
  }
  return episodes.sort((a, b) => a.number - b.number);
}

// Get streams from episode page — parses videoSources JS array
async function getEpisodeStreams(epSlug, category) {
  const html = await fetchText(`${ANIMEGG_BASE}/${epSlug}`, `${ANIMEGG_BASE}/`);
  if (!html) return [];

  // Find all iframe embed IDs
  const iframeMatches = [...html.matchAll(/<iframe[^>]+src=["']\/embed\/(\d+)["']/gi)];
  if (!iframeMatches.length) return [];

  // Find which embed is sub vs dub by looking at nearby labels
  let subEmbedId = null;
  let dubEmbedId = null;
  for (const m of iframeMatches) {
    const embedId = m[1];
    const idx = m.index;
    const before = html.slice(Math.max(0, idx - 500), idx);
    const after = html.slice(idx, idx + 500);
    const context = (before + after).toLowerCase();
    if (context.includes('dubb') && !dubEmbedId) dubEmbedId = embedId;
    else if (context.includes('subb') && !subEmbedId) subEmbedId = embedId;
  }
  // Fallback: first embed = sub, second = dub
  if (!subEmbedId) subEmbedId = iframeMatches[0][1];
  if (!dubEmbedId && iframeMatches[1]) dubEmbedId = iframeMatches[1][1];
  if (!dubEmbedId && iframeMatches[2]) dubEmbedId = iframeMatches[2][1];

  const targetEmbedIds = category === 'dub'
    ? [dubEmbedId, iframeMatches[2]?.[1]].filter(Boolean)
    : [subEmbedId].filter(Boolean);
  if (!targetEmbedIds.length) return [];

  const allStreams = [];
  for (const embedId of [...new Set(targetEmbedIds)]) {
    try {
      const embedHtml = await fetchText(`${ANIMEGG_BASE}/embed/${embedId}`, `${ANIMEGG_BASE}/${epSlug}`);
      if (!embedHtml) continue;
      const m = embedHtml.match(/var\s+videoSources\s*=\s*(\[[\s\S]*?\]);/);
      if (!m) continue;
      // Convert JS object to JSON (unquoted keys → quoted, single quotes → double)
      const asJson = m[1]
        .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
        .replace(/:\s*'([^']*)'/g, ': "$1"');
      const parsed = JSON.parse(asJson);
      for (const s of parsed) {
        let backup = null;
        if (s.bk) {
          try { backup = decodeURIComponent(Buffer.from(s.bk, 'base64').toString()); } catch {}
        }
        const url = s.file ? (s.file.startsWith('http') ? s.file : ANIMEGG_BASE + s.file) : (backup || '');
        if (url) {
          allStreams.push({
            url, backup,
            quality: s.label || 'unknown',
            type: (s.file || '').includes('.m3u8') ? 'hls' : 'mp4',
          });
        }
      }
    } catch {}
  }
  return allStreams;
}

const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

export class AnimeGG extends Source {
  constructor(fetcher) {
    super();
    this.id = 'animegg';
    this.label = 'AnimeGG';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = ANIMEGG_BASE;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const titleBase = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Resolve AniList ID
    const mediaList = await resolveAniList(name);
    if (!mediaList?.length) return [];

    const nameNorm = normalize(name);
    let bestMedia = null;
    let bestScore = 0;
    for (const m of mediaList) {
      const titles = [m.title?.english, m.title?.romaji].filter(Boolean);
      for (const t of titles) {
        const tNorm = normalize(t);
        if (!tNorm) continue;
        let score = 0;
        if (tNorm === nameNorm) score = 100;
        else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
          score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
        }
        if (score > bestScore) { bestScore = score; bestMedia = m; }
      }
    }
    if (!bestMedia || bestScore < 60) return [];

    const anilistTitle = bestMedia.title?.english || bestMedia.title?.romaji || name;
    const epNum = tmdbId.season ? (tmdbId.episode || 1) : 1;

    // Step 2: Search animegg.org for the series
    const searchResults = await searchSeries(anilistTitle);
    if (!searchResults.length) return [];

    // Pick best match
    let bestSlug = searchResults[0].slug;
    for (const r of searchResults) {
      if (normalize(r.title) === nameNorm) { bestSlug = r.slug; break; }
    }

    // Step 3: Get episodes
    const episodes = await getEpisodes(bestSlug);
    const ep = episodes.find(e => e.number === epNum) || episodes[0];
    if (!ep) return [];

    // Step 4: Get streams for both sub and dub
    const results = [];
    const seenUrls = new Set();

    for (const category of ['sub', 'dub']) {
      try {
        const rawStreams = await getEpisodeStreams(ep.slug, category);
        for (const s of rawStreams) {
          if (!s.url || seenUrls.has(s.url)) continue;
          seenUrls.add(s.url);

          let parsed;
          try { parsed = new URL(s.url); } catch { continue; }

          const height = s.quality.includes('1080') ? 1080
                      : s.quality.includes('720') ? 720
                      : s.quality.includes('480') ? 480
                      : s.quality.includes('360') ? 360
                      : undefined;

          const audioLabel = category === 'dub' ? 'DUB' : 'SUB';
          const countryCodes = category === 'dub'
            ? [CountryCode.multi, CountryCode.en]
            : [CountryCode.multi, CountryCode.ja];

          results.push({
            url: parsed,
            format: s.type === 'hls' ? Format.hls : Format.mp4,
            meta: {
              countryCodes,
              title: `${titleBase} (AnimeGG ${s.quality} ${audioLabel})`,
              sourceId: this.id,
              sourceLabel: this.label,
              ...(height && { height }),
            },
          });
        }
      } catch {}
    }

    return results;
  }
}
