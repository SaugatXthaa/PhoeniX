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
    if (res.statusCode === 200) {
      const data = JSON.parse(res.body);
      const media = data?.data?.Page?.media || [];
      if (media.length > 0) return media;
    }
  } catch { /* AniList might be down — fall through to Jikan */ }

  // Fallback: Jikan API (MyAnimeList wrapper) — returns MAL IDs
  try {
    const jikanUrl = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(name)}&limit=5&sfw=true`;
    const res = await fetch(jikanUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const jikanData = await res.json();
      const results = jikanData?.data || [];
      if (results.length > 0) {
        // Convert Jikan results to AniList-like shape (id: null — will use MAL ID)
        return results.map(r => ({
          id: null,
          idMal: r.mal_id,
          title: { romaji: r.title_japanese || r.title, english: r.title_english || r.title },
          format: r.type === 'TV' ? 'TV' : r.type === 'MOVIE' ? 'MOVIE' : 'TV',
          seasonYear: r.year || (r.aired?.from ? new Date(r.aired.from).getFullYear() : null),
        }));
      }
    }
  } catch { /* fall through to Kitsu */ }

  // Fallback: Kitsu API — no AniList/MAL IDs, but lets us match the title
  try {
    const kitsuUrl = `https://kitsu.app/api/edge/anime?filter[text]=${encodeURIComponent(name)}&page[limit]=5`;
    const res = await fetch(kitsuUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const kitsuData = await res.json();
      const results = kitsuData?.data || [];
      if (results.length > 0) {
        return results.map(r => ({
          id: null,
          idMal: null, // Kitsu doesn't expose MAL IDs in this endpoint
          title: {
            romaji: r.attributes?.titles?.en_jp || r.attributes?.canonicalTitle,
            english: r.attributes?.titles?.en || r.attributes?.canonicalTitle,
          },
          format: (r.attributes?.subtype === 'movie') ? 'MOVIE' : 'TV',
          seasonYear: r.attributes?.startDate ? new Date(r.attributes.startDate).getFullYear() : null,
        }));
      }
    }
  } catch { /* give up */ }

  return [];
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

    const nameNorm = normalize(name);
    const epNum = tmdbId.season ? (tmdbId.episode || 1) : 1;

    // Step 1: Search animegg.org directly by title (no AniList needed)
    let searchResults = await searchSeries(name);
    if (!searchResults.length) {
      // Try AniList to get an alternate title (English/Romaji) that might
      // match better on animegg.org
      const mediaList = await resolveAniList(name);
      if (mediaList?.length) {
        for (const m of mediaList) {
          const altTitle = m.title?.english || m.title?.romaji;
          if (altTitle && altTitle !== name) {
            searchResults = await searchSeries(altTitle);
            if (searchResults.length) break;
          }
        }
      }
    }
    if (!searchResults.length) return [];

    // Pick best match
    let bestSlug = searchResults[0].slug;
    for (const r of searchResults) {
      if (normalize(r.title) === nameNorm) { bestSlug = r.slug; break; }
    }

    // Step 2: Get episodes
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
