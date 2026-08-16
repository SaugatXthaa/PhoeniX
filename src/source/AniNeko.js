// src/source/AniNeko.js
// anineko.to — anime with hard-sub, soft-sub, and dub HLS streams
//
// Uses the AniNeko scraper (src/nuvio/anineko.cjs) which:
//   1. Searches anineko.to/browser?keyword={title}
//   2. Finds the episode page → extracts server buttons
//   3. Resolves each server (HD-1/HD-2 → vibeplayer, StreamHG/Earnvids → packer, Doodstream)
//   4. Returns HLS URLs with sub/dub labels
//
// The scraper returns streams with labels like:
//   "AniNeko [StreamHG] Hard Sub - HD"  → Hard Sub (Japanese audio)
//   "AniNeko [StreamHG] Soft Sub - HD"  → Soft Sub (Japanese audio)
//   "AniNeko [StreamHG] DUB - HD"       → Dub (English audio)
//
// Enriched metadata (like 4KHDHub):
//   - height: 1080 (default, since scraper returns "HD")
//   - sourceType: 'WebDL' (HLS streaming rips)
//   - countryCodes: ja for sub, en for dub
//   - title: anime title with sub/dub + server label
//
// Anime-only — only runs for content with Animation genre or Japanese origin.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'anineko.cjs');

// Cache the scraper module
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[anineko] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

// TMDB genre ID for Animation
const ANIMATION_GENRE_ID = 16;

// Check if content is anime (has Animation genre or Japanese origin)
async function isAnimeContent(fetcher, ctx, tmdbId) {
  try {
    const type = tmdbId.season ? 'tv' : 'movie';
    const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}`);
    url.searchParams.set('api_key', process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c');
    const data = await fetcher.json(ctx, url);
    if (!data) return false;
    const genres = data.genres || [];
    if (genres.some(g => g.id === ANIMATION_GENRE_ID)) return true;
    if (data.original_language === 'ja') return true;
    return false;
  } catch {
    return true; // Be permissive if TMDB fails
  }
}

// Detect sub/dub from stream name/label
function detectAudioType(name, title) {
  const text = ((name || '') + ' ' + (title || '')).toLowerCase();
  if (text.includes('dub')) return 'dub';
  if (text.includes('hard sub') || text.includes('hardsub')) return 'hsub';
  return 'sub'; // Default: soft sub
}

export class AniNeko extends Source {
  constructor(fetcher) {
    super();
    this.id = 'anineko';
    this.label = 'AniNeko';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = 'https://anineko.to';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // AniNeko is anime-only — check if content is actually anime
    const isAnime = await isAnimeContent(this.fetcher, ctx, tmdbId);
    if (!isAnime) return [];

    // Load the scraper module (cached)
    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await Promise.race([
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season, tmdbId.episode || 1),
        new Promise(r => setTimeout(() => r(null), 25000)),
      ]);
    } catch (e) {
      console.error(`[anineko] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    const results = [];
    const seenUrls = new Set();

    for (const s of streams) {
      if (!s || !s.url || typeof s.url !== 'string') continue;
      if (!s.url.startsWith('http')) continue;
      if (seenUrls.has(s.url)) continue;
      seenUrls.add(s.url);

      let url;
      try { url = new URL(s.url); } catch { continue; }

      // Detect sub/dub type from stream name
      const audioType = detectAudioType(s.name, s.title);
      const audioLabel = audioType === 'dub' ? 'DUB' :
                         audioType === 'hsub' ? 'Hard Sub' : 'Soft Sub';
      const countryCodes = audioType === 'dub'
        ? [CountryCode.multi, CountryCode.en]
        : [CountryCode.multi, CountryCode.ja];

      // Extract server name from stream name (e.g. "AniNeko [StreamHG] Hard Sub - HD")
      const serverMatch = s.name?.match(/\[([^\]]+)\]/);
      const serverName = serverMatch ? serverMatch[1] : 'AniNeko';

      const displayTitle = `${title} (${audioLabel} · ${serverName})`;

      results.push({
        url,
        format: Format.hls,
        meta: {
          countryCodes,
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          height: 1080, // AniNeko streams are typically 1080p
          sourceType: 'WebDL',
        },
      });
    }

    return results;
  }
}
