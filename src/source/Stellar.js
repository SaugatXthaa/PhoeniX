// src/source/Stellar.js
// stellar.gdn — movies/TV/anime with direct HLS streams (up to 4K)
//
// Uses the all-in-one scraper (src/nuvio/stellar.cjs) which:
//   1. Fetches a PoW (proof-of-work) challenge from api.stellar.gdn
//   2. Solves the PoW (SHA-256 starts with N zeros)
//   3. AES-256-GCM encrypts the request payload
//   4. POSTs to /api/resolve → returns direct HLS m3u8 URL
//
// Streams returned by Stellar:
//   - Orbit (cdn.reallyfast.ch) — master playlist with 360p/720p/1080p/4K
//   - Valenox (h.midnightexpress.workers.dev) — alternate CDN
//   - Iframe fallback (stellar.rip/embed/...) — filtered out (unplayable in Stremio)
//
// The stream URL works WITHOUT Referer/auth headers — completely public once
// resolved. Stremio plays it directly via HLS.
//
// Flow:
//   1. Resolve TMDB ID + name/year + detect anime
//   2. Scraper resolves stream URL via PoW + AES-GCM
//   3. Filter out iframe streams (Stremio can't play cross-origin iframes)
//   4. Convert direct HLS streams to Source result format via buildStreamResults
//   5. Subtitles pass-through (Stellar API returns subtitle URLs when available)

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'stellar.cjs');
const require_ = createRequire(import.meta.url);

// Cache the scraper module — stellar.cjs has no initialization side effects
// but caching avoids re-reading the file on every request.
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[stellar] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

// Parse a quality string into a height number for meta.height.
function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
  if (s.includes('1440')) return 1440;
  const m = s.match(/(\d{3,4})p?/);
  return m ? parseInt(m[1], 10) : undefined;
}

export class Stellar extends Source {
  constructor(fetcher) {
    super();
    this.id = 'stellar';
    this.label = 'Stellar';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://stellar.gdn';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min — stream URLs may have short-lived tokens
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Detect anime by checking TMDB original_language + genres
    let isAnime = false;
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
        isAnime = data.original_language === 'ja' &&
          (data.genres || []).some(g => g.id === 16); // 16 = Animation
      }
    } catch { /* best effort */ }

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
      console.error(`[stellar] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    // Filter out iframe streams — Stremio's runtime can't run JS inside
    // cross-origin iframes, so they would just hang. Keep only direct
    // playable HLS (m3u8) streams.
    const directStreams = streams.filter(s => {
      if (!s || !s.url || typeof s.url !== 'string') return false;
      if (!s.url.startsWith('http')) return false;
      // Reject iframes
      if (s.type === 'iframe') return false;
      if (s.behaviorHints?.notWebVideo === true) return false;
      return true;
    });

    if (directStreams.length === 0) {
      console.log(`[stellar] no direct playable streams (all iframe)`);
      return [];
    }

    // Enrich stream titles with metadata markers.
    // The scraper returns titles like:
    //   "Inception (2010) [Stellar Orbit 1920x1080]"
    //   "Oppenheimer (2023) [Stellar Orbit 3840x2160 4K]"
    //
    // We build a STREAM title (without the movie title — buildStreamResults
    // prepends it automatically) containing:
    //   "[Stellar {server}] {quality} WEB-DL {codec} {audio}"
    // enrichMeta parses: quality, sourceType (WebDL from URL), codec.
    const enrichedStreams = directStreams.map(s => {
      const serverName = (s.name || '').replace(/^Stellar\s*-\s*/, '').trim();
      const height = parseHeight(s.quality) || 1080;
      const codec = height >= 2160 ? 'HEVC' : 'x264';
      const audioLabel = isAnime ? 'Japanese' : 'English';

      // Stremio-standard stream object — buildStreamResults will pick up:
      //   - url (direct m3u8)
      //   - quality (2160p, 1080p, 720p)
      //   - title (enriched for meta parsing — WITHOUT movie title)
      //   - name (display name)
      //   - subtitles (passed through to meta.subtitles)
      const subtitles = Array.isArray(s.subtitles) ? s.subtitles.map(sub => ({
        id: sub.id || sub.lang || sub.language || 'en',
        url: sub.url,
        lang: sub.lang || sub.language || sub.label || 'English',
      })) : [];

      return {
        url: s.url,
        quality: s.quality || (height + 'p'),
        title: `[Stellar ${serverName}] ${height}p WEB-DL ${codec} ${audioLabel}`,
        name: 'Stellar - ' + serverName,
        subtitles: subtitles.length > 0 ? subtitles : undefined,
        // Internal flag — used to inject countryCodes into buildStreamResults
        _countryCodes: baseCountryCodes,
      };
    });

    // Use buildStreamResults to convert to Source result format.
    // Stellar streams have NO Referer requirement — they play directly via HLS.
    // buildStreamResults sets meta.nuvioProvider=true so NuvioExtractor handles
    // routing — but since there's no Referer, NuvioExtractor's "No Referer →
    // direct URL" branch returns the URL as-is (no /proxy needed).
    const results = buildStreamResults({
      streams: enrichedStreams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: baseCountryCodes,
      ctx,
    });

    // Override countryCodes per-stream (buildStreamResults uses source-level)
    for (const r of results) {
      const matchedStream = enrichedStreams.find(s => s.url === r.url.href);
      if (matchedStream?._countryCodes) {
        r.meta.countryCodes = matchedStream._countryCodes;
      }
    }

    console.log(`[stellar] ${results.length} playable stream(s) (filtered out ${streams.length - directStreams.length} iframe)`);

    return results;
  }
}
