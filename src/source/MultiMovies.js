// src/source/MultiMovies.js
// multimovies.beer — movies/TV/anime with multi-server embed streams (up to 4K)
//
// Uses the scraper (src/nuvio/multimovies.cjs) which:
//   1. Searches multimovies.beer via /?s={title}
//   2. Fetches movie/TV page → extracts DooPlay player data (post ID, nonce, servers)
//   3. Calls /wp-admin/admin-ajax.php?action=doo_player_ajax → embed URLs (4 servers)
//   4. For iqsmartgames server: calls /mymovieapi → file list with quality/size info
//   5. Returns embed URLs as stream entries
//
// EMBED RESOLUTION:
//   The embed URLs (modiplay.xyz, iqsmartgames.com, screenscape.me, nxsha.space)
//   are iframe embeds. They're handled by:
//   - EmbedResolver (tries to extract direct stream from page HTML)
//   - ExternalUrl (passes URL to Stremio's built-in player as external link)
//
// ENRICHED METADATA (from iqsmartgames file list):
//   - height: 480/720/1080/2160 (from filename)
//   - codec: HEVC (x265) / x264 (from filename)
//   - sourceType: WEB-DL / BluRay (from filename)
//   - audioLabel: Multi Audio / Dual Audio / Hindi / English / Japanese (anime)
//   - fileSize: from API response
//
// ANIME SUPPORT:
//   - Detects anime via TMDB genres (Animation=16) or original_language=ja
//   - Anime files typically have "Multi Audio" (Japanese + Hindi + English)
//   - Sub/Dub: embeds contain both sub and dub (player handles audio switching)
//
// SUBTITLES:
//   - File names often have "ESub" (English subtitles embedded in MKV)
//   - OpenSubtitles fallback provides multi-language subs via StreamResolver

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'multimovies.cjs');
const require_ = createRequire(import.meta.url);

let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try { _scraperMod = require_(PROVIDER_PATH); }
  catch (e) { console.error(`[multimovies] failed to load scraper: ${e?.message || e}`); }
  return _scraperMod;
}

// Detect anime via TMDB genres + original language
async function isAnimeContent(fetcher, ctx, tmdbId) {
  try {
    const type = tmdbId.season ? 'tv' : 'movie';
    const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}`);
    url.searchParams.set('api_key', process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c');
    const data = await fetcher.json(ctx, url);
    if (!data) return false;
    const genres = data.genres || [];
    if (genres.some(g => g.id === 16)) return true;
    if (data.original_language === 'ja') return true;
    return false;
  } catch { return false; }
}

export class MultiMovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'multimovies';
    this.label = 'MultiMovies';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://multimovies.beer';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const isAnime = await isAnimeContent(this.fetcher, ctx, tmdbId);

    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await Promise.race([
        mod.getStreams(String(tmdbId.id), mediaType, tmdbId.season || null, tmdbId.episode || null),
        new Promise(r => setTimeout(() => r(null), 25000)),
      ]);
    } catch (e) {
      console.error(`[multimovies] error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    const results = [];
    const seenUrls = new Set();

    for (const s of streams) {
      if (!s.url || typeof s.url !== 'string') continue;
      if (!s.url.startsWith('http')) continue;
      if (seenUrls.has(s.url)) continue;
      seenUrls.add(s.url);

      let url;
      try { url = new URL(s.url); } catch { continue; }

      const height = s._height || 1080;
      const codec = s._codec || 'x264';
      const sourceType = s._sourceType || 'WebDL';
      const language = s._language || (isAnime ? 'Multi Audio' : 'Multi Audio');
      const fileSize = s._fileSize;
      const isMultiAudio = /multi|dual/i.test(language);
      const embedHost = s._embedHost || url.hostname;

      // Country codes based on audio + anime
      const countryCodes = isAnime
        ? [CountryCode.multi, CountryCode.ja, CountryCode.en]
        : [CountryCode.multi, CountryCode.hi, CountryCode.en];

      // Build display title with enriched metadata
      const hdrTag = '';
      const audioTag = isAnime ? ' [SUB+DUB]' : '';
      const displayTitle = `${title} — [MultiMovies ${height}p ${sourceType} ${codec} ${language}${audioTag}]`;

      results.push({
        url,
        format: 'iframe', // Embed URL — not directly playable, needs extraction
        meta: {
          countryCodes,
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          height,
          sourceType,
          codec,
          serverName: embedHost,
          audioLabel: language,
          isMultiAudio,
          ...(isAnime && { isMultiAudio: true }),
          ...(fileSize && { bytes: fileSize }),
          // Mark as external — Stremio will open in browser if extraction fails
          // Actually, don't set isExternal — let EmbedResolver try first
        },
      });
    }

    console.log(`[multimovies] ${results.length} stream(s)${isAnime ? ' [anime]' : ''}`);
    return results;
  }
}
