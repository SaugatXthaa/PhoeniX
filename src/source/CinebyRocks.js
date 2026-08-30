// src/source/CinebyRocks.js
// cineby.rocks — movies/TV/anime with multi-server HLS streams (up to 4K)
//
// Uses the all-in-one scraper (src/nuvio/cineby_rocks.cjs) which queries
// vidbolt.xyz's VidRock API. Returns direct m3u8/mp4 URLs from multiple
// CDNs (gigle432ski.com, ngcorp.dad, dolphin-55.workers.dev, hakunaymatata.com).
//
// 8 server iframe embeds are also returned by the scraper but filtered out
// here — Stremio's runtime can't execute the SPA JavaScript inside
// cross-origin iframes, so they would just hang. Only direct playable
// streams are kept.
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Scraper fetches VidRock API → direct m3u8/mp4 sources
//   3. Filter out iframe streams (unplayable in Stremio)
//   4. Convert direct streams to Source result format via buildStreamResults
//      (HLS+Referer → /proxy, MP4+Referer → requestHeaders, direct → direct)
//
// Enriched metadata (quality, codec, sourceType, audioCodec, countryCodes,
// subtitles) is parsed by enrichMeta() in StreamResolver.js — the stream
// title contains quality + server name so enrichMeta can extract info.

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'cineby_rocks.cjs');
const require_ = createRequire(import.meta.url);

// Cache the scraper module — cineby_rocks.cjs has no initialization side
// effects but caching avoids re-reading the file on every request.
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[cinebyrocks] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

// Detect audio language from the VidRock source name
//   "VidRock • Hindi" → 'hi'
//   "VidRock • Tamil" → 'ta'
//   "VidRock • Telugu" → 'te'
//   "VidRock • Bengali" → 'bn' (note: 'bn' is not in CountryCode, falls back to 'multi')
//   "VidRock • Lyra" → '' (default — usually English)
function detectAudioLang(name) {
  if (!name) return '';
  const n = name.toLowerCase();
  if (n.includes('hindi')) return 'hi';
  if (n.includes('tamil')) return 'ta';
  if (n.includes('telugu')) return 'te';
  if (n.includes('bengali')) return 'bn';
  if (n.includes('english')) return 'en';
  if (n.includes('japanese')) return 'ja';
  if (n.includes('korean')) return 'ko';
  if (n.includes('chinese')) return 'zh';
  return '';
}

// Map ISO 639-1 language code to PhoeniX CountryCode
// NOTE: 'bn' (Bengali) is not in CountryCode — we fall back to 'multi'
const LANG_TO_CC = {
  hi: CountryCode.hi,
  ta: CountryCode.ta,
  te: CountryCode.te,
  en: CountryCode.en,
  ja: CountryCode.ja,
  ko: CountryCode.ko,
  zh: CountryCode.zh,
  // Bengali not in CountryCode — uses 'multi' fallback
};

export class CinebyRocks extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinebyrocks';
    this.label = 'CinebyRocks';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://cineby.rocks';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min — stream URLs may have short-lived tokens
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Detect anime by checking TMDB original_language + genres
    // Anime is Japanese-origin animation. We add 'ja' to countryCodes for anime.
    let isAnime = false;
    let originalLang = '';
    try {
      const type = tmdbId.season ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/${type}/${tmdbId.id}?api_key=${process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c'}`;
      const { gotScraping } = await import('got-scraping');
      const r = await gotScraping.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeout: { request: 8000 }, throwHttpErrors: false, http2: false,
      });
      if (r.statusCode === 200) {
        const data = JSON.parse(r.body);
        originalLang = data.original_language || '';
        isAnime = originalLang === 'ja' &&
          (data.genres || []).some(g => g.id === 16); // 16 = Animation genre
      }
    } catch { /* best effort */ }

    // Build country codes based on detected audio language
    const baseCountryCodes = isAnime
      ? [CountryCode.multi, CountryCode.ja]
      : [CountryCode.multi, CountryCode.en];

    // Load cached scraper module
    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await Promise.race([
        mod.getStreams(String(tmdbId.id), mediaType, tmdbId.season || null, tmdbId.episode || null),
        new Promise(r => setTimeout(() => r(null), 30000)),
      ]);
    } catch (e) {
      console.error(`[cinebyrocks] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    // Filter out iframe streams — Stremio's runtime can't run JS inside
    // cross-origin iframes, so they would just hang. Keep only direct
    // playable HLS (m3u8) and MP4 streams.
    const directStreams = streams.filter(s => {
      if (!s || !s.url || typeof s.url !== 'string') return false;
      if (!s.url.startsWith('http')) return false;
      // Reject iframes
      if (s.type === 'iframe') return false;
      if (s.behaviorHints?.notWebVideo === true) return false;
      return true;
    });

    if (directStreams.length === 0) {
      console.log(`[cinebyrocks] no direct playable streams (all iframe)`);
      return [];
    }

    // Enrich stream titles with metadata markers + audio language detection.
    // The scraper returns titles like:
    //   "Inception (2010) [Cineby Cipher VidRock • Hindi 1920x1080 (Hindi)]"
    //
    // We build a STREAM title (without the movie title — buildStreamResults
    // will prepend it automatically) containing:
    //   "[CinebyRocks {server}] {quality} WEB-DL {codec} {audio}"
    // enrichMeta parses: quality (1080p), sourceType (WebDL), codec (HEVC/x264),
    // audio language (Hindi/Tamil/Telugu/Japanese/English).
    const enrichedStreams = directStreams.map(s => {
      const serverName = (s.name || '').replace(/^Cineby\s*-\s*/, '').trim();
      const audioLang = detectAudioLang(s.name + ' ' + (s.title || ''));

      // Add language-specific country code if we detected one
      const langCC = LANG_TO_CC[audioLang];
      const streamCountryCodes = langCC && !baseCountryCodes.includes(langCC)
        ? [...baseCountryCodes, langCC]
        : baseCountryCodes;

      // Parse resolution from title if present (e.g. "1920x1080")
      let resFromTitle = '';
      const resMatch = (s.title || '').match(/(\d{3,4})x(\d{3,4})/);
      if (resMatch) {
        const h = parseInt(resMatch[2], 10);
        if (h >= 2160) resFromTitle = '2160p';
        else if (h >= 1080) resFromTitle = '1080p';
        else if (h >= 720) resFromTitle = '720p';
        else if (h >= 480) resFromTitle = '480p';
      }

      // Build enriched STREAM title (WITHOUT movie title — buildStreamResults
      // prepends it). Format: "[CinebyRocks {server}] {quality} WEB-DL {codec} {audio}"
      const quality = s.quality || resFromTitle || '1080p';
      const codec = quality === '2160p' ? 'HEVC' : 'x264';
      const audioLabel = audioLang
        ? (audioLang.charAt(0).toUpperCase() + audioLang.slice(1))
        : (isAnime ? 'Japanese' : 'English');

      // Stremio-standard stream object — buildStreamResults will pick up:
      //   - url (direct m3u8/mp4)
      //   - quality (1080p, 720p, 480p, 2160p)
      //   - title (enriched for meta parsing — WITHOUT movie title)
      //   - name (display name)
      //   - headers (Referer/User-Agent from proxyHeaders — NuvioExtractor routes through /proxy)
      //   - subtitles (passed through to meta.subtitles)
      const headers = s.behaviorHints?.proxyHeaders?.request || {};
      const subtitles = Array.isArray(s.subtitles) ? s.subtitles.map(sub => ({
        id: sub.id || sub.lang || 'en',
        url: sub.url,
        lang: sub.lang || sub.language || 'English',
      })) : [];

      return {
        url: s.url,
        quality,
        title: `[CinebyRocks ${serverName}] ${quality} WEB-DL ${codec} ${audioLabel}`,
        name: 'CinebyRocks - ' + serverName,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        size: s.size,
        subtitles: subtitles.length > 0 ? subtitles : undefined,
        // Internal flag — used to inject countryCodes into buildStreamResults
        _countryCodes: streamCountryCodes,
      };
    });

    // Use buildStreamResults to convert to Source result format.
    // It will:
    //   - Set meta.nuvioProvider=true so NuvioExtractor handles /proxy routing
    //   - Set meta.nuvioReferer from s.headers.Referer (CDNs need Referer)
    //   - Set meta.nuvioForceHls when URL is ambiguous + has Referer
    //   - Pass through s.subtitles to meta.subtitles
    //   - Parse height from s.quality
    const results = buildStreamResults({
      streams: enrichedStreams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: baseCountryCodes,
      ctx,
    });

    // Override countryCodes per-stream if we detected a specific language
    // (buildStreamResults uses the source-level countryCodes; we want per-stream)
    for (const r of results) {
      const matchedStream = enrichedStreams.find(s => s.url === r.url.href);
      if (matchedStream?._countryCodes) {
        r.meta.countryCodes = matchedStream._countryCodes;
      }
    }

    console.log(`[cinebyrocks] ${results.length} playable stream(s) (filtered out ${streams.length - directStreams.length} iframe)`);

    return results;
  }
}
