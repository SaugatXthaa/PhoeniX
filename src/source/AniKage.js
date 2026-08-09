// src/source/AniKage.js
// anikage.cc — anime-only streaming with clean JSON API + direct HLS
//
// Flow (all JSON, no scraping):
//   1. Search: GET /api/media/anime/browse?q={title} → [{slug, anilistId, title, ...}]
//   2. Episodes: GET /api/media/anime/{slug}/episodes → {total, episodes:[{number, ...}]}
//   3. Servers: GET /api/media/anime/{slug}/episodes/{N}/servers
//      → {servers:[{id, subTypes:[sub|dub]}], embeds:[...]}
//   4. Sources: GET /api/media/anime/{slug}/episodes/{N}/sources?provider={id}&lang={sub|dub}
//      → {sources:[{url, quality, isM3U8, type}], subtitles, embeds, ...}
//   5. The source.url is a TOKEN — build the direct URL:
//      - HLS: https://prox.anicore.tv/m3u8/{token}
//      - MP4: https://prox.anicore.tv/stream/{token}
//   6. prox.anicore.tv requires `Origin: https://anikage.cc` header → route through /proxy
//
// Providers: neko (default, sub+dub), koto (sub+dub, often 1080p),
//            dib (BD, sub only), wave (Vidplay, sub+dub), megg (MP4, sub+dub)
//
// Both SUB and DUB streams are returned when available.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://anikage.cc';
const PROXY_BASE = 'https://prox.anicore.tv';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Provider priority order — neko (default) first, then koto (often 1080p),
// then dib (BD), wave (Vidplay), megg (MP4 fallback)
const PROVIDER_PRIORITY = ['neko', 'koto', 'dib', 'wave', 'megg'];

// Normalize for fuzzy title matching
const normalize = (s) => (s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function apiGet(path, referer = BASE_URL + '/') {
  const { gotScraping } = await import('got-scraping');
  const url = path.startsWith('http') ? path : BASE_URL + path;
  const res = await gotScraping.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Referer': referer,
    },
    timeout: { request: 25000 },
    throwHttpErrors: false,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

export class AniKage extends Source {
  constructor(fetcher) {
    super();
    this.id = 'anikage';
    this.label = 'AniKage';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search for the anime
    const slug = await this.findSlug(name);
    if (!slug) return [];

    // Step 2: Fetch episodes list
    const epData = await apiGet(`/api/media/anime/${slug}/episodes`);
    if (!epData?.episodes?.length) return [];

    // Step 3: Find the requested episode
    const targetEp = tmdbId.season ? (tmdbId.episode || 1) : 1;
    const episode = epData.episodes.find(ep => ep.number === targetEp) || epData.episodes[0];
    if (!episode) return [];

    // Step 4: Fetch available servers for this episode
    const serversData = await apiGet(`/api/media/anime/${slug}/episodes/${episode.number}/servers`);
    if (!serversData?.servers?.length) return [];

    // Step 5: For each provider + sub/dub, fetch sources
    const results = [];
    const seenUrls = new Set();
    const seenLabels = new Set();

    for (const provider of PROVIDER_PRIORITY) {
      const server = serversData.servers.find(s => s.id === provider);
      if (!server) continue;

      const subTypes = server.subTypes || [];
      for (const lang of subTypes) {
        if (lang !== 'sub' && lang !== 'dub') continue;

        const sourcesData = await apiGet(
          `/api/media/anime/${slug}/episodes/${episode.number}/sources?provider=${provider}&lang=${lang}`
        );
        if (!sourcesData?.sources?.length) continue;

        for (const source of sourcesData.sources) {
          if (!source.url) continue;

          // Build the direct stream URL from the token
          const streamPath = source.isM3U8 ? `/m3u8/${source.url}` : `/stream/${source.url}`;
          const streamUrl = PROXY_BASE + streamPath;
          let parsed;
          try { parsed = new URL(streamUrl); } catch { continue; }
          if (seenUrls.has(parsed.href)) continue;
          seenUrls.add(parsed.href);

          const format = source.isM3U8 ? Format.hls : Format.mp4;
          const audioLabel = lang === 'dub' ? 'Dub' : 'Sub';
          const countryCodes = lang === 'dub'
            ? [CountryCode.multi, CountryCode.en]
            : [CountryCode.multi, CountryCode.ja];

          const labelKey = `${provider}_${lang}_${source.quality || 'auto'}`;
          if (seenLabels.has(labelKey)) continue;
          seenLabels.add(labelKey);

          // Parse height from quality string (e.g. "hardsub HD-1" → 720,
          // "1080p" → 1080, "VidPlay-1 auto" → undefined)
          const qualityStr = String(source.quality || '');
          let height;
          const resMatch = qualityStr.match(/(\d{3,4})p?/);
          if (resMatch) height = parseInt(resMatch[1]);
          else if (qualityStr.includes('HD')) height = 720;

          // Return the DIRECT m3u8 URL with requestHeaders.
          // The AnimeDirect extractor claims prox.anicore.tv URLs and routes
          // them through /proxy with the Referer from meta.requestHeaders.
          results.push({
            url: parsed,
            format,
            requestHeaders: { Referer: BASE_URL + '/' },
            meta: {
              countryCodes,
              title: `${title} (${audioLabel} · ${provider} · ${source.quality || 'HD'})`,
              sourceId: this.id,
              sourceLabel: this.label,
              ...(height && { height }),
            },
          });
        }
      }
    }

    return results;
  }

  // Search AniKage by name and return the slug of the best match
  async findSlug(name) {
    const queries = [
      name,
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    const nameNorm = normalize(name);

    for (const query of queries) {
      const data = await apiGet(`/api/media/anime/browse?q=${encodeURIComponent(query)}`);
      if (!data?.data?.length) continue;

      let best = null;
      let bestScore = 0;
      for (const r of data.data) {
        const titles = [
          r.title?.english,
          r.title?.romaji,
          r.title?.native,
          r.title?.userPreferred,
        ].filter(Boolean);
        for (const t of titles) {
          const tNorm = normalize(t);
          if (!tNorm) continue;
          let score = 0;
          if (tNorm === nameNorm) score = 100;
          else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
            score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
          }
          if (score > bestScore) {
            bestScore = score;
            best = r;
          }
        }
      }

      if (best && bestScore >= 0.6) return best.slug;
    }

    return null;
  }
}
