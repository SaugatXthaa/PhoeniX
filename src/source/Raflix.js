// src/source/Raflix.js
// raflixx.vercel.app — movies/TV/anime via multiple embed providers
//
// Raflix is a Vite/TanStack Start SPA that provides embed URLs from
// multiple streaming providers via its API:
//
//   Movies/TV: GET /api/media/sources?type={movie|tv}&tmdbId={id}&season={s}&episode={e}
//   Anime:     GET /api/anime/sources?tmdbId={id}&title={title}&season={s}&episode={e}&dub={0|1}&year={y}
//
// The APIs return JSON with a "sources" array containing:
//   { id, label, kind: "embed", url, language?: "sub"|"dub" }
//
// Movies/TV get 8 sources: Anicine, XPass, MoviesAPI, FileSun, VidStorm,
//   VidRift, APIPlayer, EmbedMaster
// Anime gets 17 sources (both sub and dub): TryEmbed, AniLink, MegaVid, Vidy,
//   VidNest, MegaPlay, VidLink, Yenime, SupaPlay, NHD, NontonGo, Anicine,
//   VidRift, AniEmbed, Filmu, FrameXTV
//
// Many of these embed URLs are handled by existing extractors:
//   - Megaplay → Megaplay extractor
//   - VidNest → handled by EmbedResolver
//   - VidLink → VidLink extractor
//   - FrameXTV → NuvioExtractor (framextv source)
//   - Others → EmbedResolver/ExternalUrl fallback
//
// ENRICHED METADATA:
//   - height: 1080 (default, resolved by extractor)
//   - sourceType: WebDL (default)
//   - audioLabel: SUB/DUB for anime, English for movies
//   - serverName: from API source label

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://raflixx.vercel.app';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let _gotScraping = null;
async function getGot() {
  if (_gotScraping) return _gotScraping;
  try { const mod = await import('got-scraping'); _gotScraping = mod.gotScraping; }
  catch (e) { console.error('[raflix] Failed to load got-scraping:', e.message); }
  return _gotScraping;
}

async function gotJson(url, timeoutMs = 12000) {
  const got = await getGot();
  if (!got) return null;
  const res = await got(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeout: { request: timeoutMs },
    throwHttpErrors: false,
    followRedirect: true,
    http2: true,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

// Detect anime via TMDB genres + original language
async function isAnimeContent(fetcher, ctx, tmdbId) {
  try {
    const type = tmdbId.season ? 'tv' : 'movie';
    const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}`);
    url.searchParams.set('api_key', TMDB_API_KEY);
    const data = await fetcher.json(ctx, url);
    if (!data) return false;
    if ((data.genres || []).some(g => g.id === 16)) return true;
    if (data.original_language === 'ja') return true;
    return false;
  } catch { return false; }
}

// Fetch media sources (movies/TV)
async function fetchMediaSources(type, tmdbId, season, episode) {
  let url = `${BASE_URL}/api/media/sources?type=${type}&tmdbId=${tmdbId}`;
  if (type === 'tv' && season && episode) {
    url += `&season=${season}&episode=${episode}`;
  }
  const data = await gotJson(url);
  return data?.ok ? (data.sources || []) : [];
}

// Fetch anime sources (sub + dub)
async function fetchAnimeSources(tmdbId, title, season, episode, year) {
  const results = { sub: [], dub: [] };

  for (const dub of [0, 1]) {
    const params = new URLSearchParams({
      tmdbId: String(tmdbId),
      title,
      season: String(season || 1),
      episode: String(episode || 1),
      dub: String(dub),
    });
    if (year) params.set('year', String(year));

    const data = await gotJson(`${BASE_URL}/api/anime/sources?${params.toString()}`);
    if (data?.ok && Array.isArray(data.sources)) {
      const lang = dub === 1 ? 'dub' : 'sub';
      results[lang] = data.sources;
    }
  }

  return results;
}

export class Raflix extends Source {
  constructor(fetcher) {
    super();
    this.id = 'raflix';
    this.label = 'Raflix';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en, CountryCode.ja];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const isAnime = await isAnimeContent(this.fetcher, ctx, tmdbId);
    const mediaType = tmdbId.season ? 'tv' : 'movie';
    const season = tmdbId.season || null;
    const episode = tmdbId.episode || null;

    const results = [];

    if (isAnime) {
      // Fetch anime sources (sub + dub)
      console.log(`[raflix] Fetching anime sources for ${name}...`);
      const animeSources = await fetchAnimeSources(tmdbId.id, name, season, episode, year);

      for (const [lang, sources] of Object.entries(animeSources)) {
        for (const src of sources) {
          if (!src.url || typeof src.url !== 'string') continue;
          if (!src.url.startsWith('http')) continue;

          let url;
          try { url = new URL(src.url); } catch { continue; }

          const isDub = lang === 'dub';
          const countryCodes = isDub
            ? [CountryCode.multi, CountryCode.en, CountryCode.ja]
            : [CountryCode.multi, CountryCode.ja, CountryCode.en];

          const audioLabel = isDub ? 'English (Dub)' : 'Japanese (Sub)';

          results.push({
            url,
            format: Format.hls,
            meta: {
              countryCodes,
              title: `${title} — [Raflix ${src.label}] ${audioLabel}`,
              sourceId: this.id,
              sourceLabel: this.label,
              height: 1080,
              sourceType: 'WebDL',
              codec: 'x264',
              serverName: `${src.label} ${lang.toUpperCase()}`,
              audioLabel: isDub ? 'English' : 'Japanese',
              isMultiAudio: true,
            },
          });
        }
      }
    } else {
      // Fetch movie/TV sources
      console.log(`[raflix] Fetching media sources for ${name}...`);
      const sources = await fetchMediaSources(mediaType, tmdbId.id, season, episode);

      for (const src of sources) {
        if (!src.url || typeof src.url !== 'string') continue;
        if (!src.url.startsWith('http')) continue;

        let url;
        try { url = new URL(src.url); } catch { continue; }

        results.push({
          url,
          format: Format.hls,
          meta: {
            countryCodes: [CountryCode.multi, CountryCode.en],
            title: `${title} — [Raflix ${src.label}]`,
            sourceId: this.id,
            sourceLabel: this.label,
            height: 1080,
            sourceType: 'WebDL',
            codec: 'x264',
            serverName: src.label,
            audioLabel: 'English',
          },
        });
      }
    }

    console.log(`[raflix] ${results.length} stream(s)${isAnime ? ' [anime]' : ''}`);
    return results;
  }
}
