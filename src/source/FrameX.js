// src/source/FrameX.js
// framextv.tech — movies, TV series, anime (sub+dub) with HLS streams up to 4K
//
// Uses the FrameX API at https://api.framextv.tech/api/stream
// Returns HLS m3u8 URLs with Referer headers (for moon.peakstorm.top CDN).
//
// Supports:
//   - Movies (up to 2160p/4K)
//   - TV Series (up to 2160p/4K)
//   - Anime (sub + dub, via AniList ID mapping)
//   - K-Dramas (via TV series type)
//
// Stream URLs from moon.peakstorm.top require Referer: https://player.videasy.to/
// This is passed via meta.nuvioReferer so NuvioExtractor routes through /proxy.

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, parseHeight, callNuvioProvider, normalizeAudioTracks, buildAudioLabel } from './nuvioHelpers.js';
import { TMDB_PRIMARY } from '../utils/site-secrets.cjs'; // central site-secret registry (env-overridable)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'framextv.cjs');

// Task 33: ISO 639-1 → display language name (the subset TMDB actually
// returns as original_language). Drives the per-content audio metadata.
const ISO_LANG_NAMES = {
  en: 'English', ja: 'Japanese', ko: 'Korean', hi: 'Hindi', es: 'Spanish',
  fr: 'French', de: 'German', zh: 'Chinese', cn: 'Chinese', it: 'Italian',
  ru: 'Russian', pt: 'Portuguese', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam',
  bn: 'Bengali', mr: 'Marathi', pa: 'Punjabi', ar: 'Arabic', tr: 'Turkish',
  th: 'Thai', id: 'Indonesian', ms: 'Malay', fil: 'Filipino', tl: 'Filipino',
  sv: 'Swedish', no: 'Norwegian', nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian',
  he: 'Hebrew', fa: 'Persian', vi: 'Vietnamese',
};

export class FrameX extends Source {
  constructor(fetcher) {
    super();
    this.id = 'framextv';
    this.label = 'FrameX';
    this.contentTypes = ['movie', 'series'];
    // Task 33: was [multi, en, ja, ko] — a hardcode that leaked Japanese+
    // Korean flags onto EVERY card ("Audio: English, Japanese, Korean" on
    // English-only films). Per-stream codes are now derived from the
    // content's real audio (see enrichment below); this default only backs
    // streams that somehow bypass enrichment.
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://framextv.tech';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Load scraper module (cached via nuvioHelpers)
    const { callNuvioProvider } = await import('./nuvioHelpers.js');

    // FrameX API only supports 'movie' and 'tv' types.
    // Anime is handled as type=tv (anime IS TV on TMDB).
    // The API resolves anime by TMDB TV ID directly — no AniList mapping needed.
    const apiType = tmdbId.season ? 'tv' : 'movie';
    let isAnime = false;
    let originalLanguage = '';

    // Task 33: probe TMDB for BOTH movies and series (previously movies were
    // skipped entirely, so every movie stream inherited the source-level
    // [en, ja, ko] default → wrong audio flags on English-only films). One
    // 8s-capped call; failure falls back to the English default below.
    try {
      const tmdbUrl = `https://api.themoviedb.org/3/${apiType}/${tmdbId.id}?api_key=${TMDB_PRIMARY}`;
      const { gotScraping } = await import('got-scraping');
      const r = await gotScraping.get(tmdbUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeout: { request: 8000 }, throwHttpErrors: false, http2: false,
      });
      if (r.statusCode === 200) {
        const data = JSON.parse(r.body);
        originalLanguage = data.original_language || '';
        isAnime = originalLanguage === 'ja' &&
          (data.genres || []).some(g => g.id === 16);
      }
    } catch { /* best effort */ }

    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType: apiType,
      season: tmdbId.season || null,
      episode: tmdbId.episode || null,
      // 20-provider sweep: ~10-16s typical, 22s internal deadline (same
      // strategy as streamxtv.cjs). Task 65 re-measure: with the working
      // transport the FULL 20-provider sweep lands at ~26.4s on Render —
      // the old 25s race discarded the completed result 1.4s before it
      // returned (debug probe: "6 stream(s) total in 26433ms" but count=0).
      // 33s keeps the whole chain under the 35s source timeout.
      timeoutMs: 33000,
    });

    // Enrich streams with metadata markers for StreamResolver.enrichMeta
    // Same format as 4KHDHub/Cinejoy
    if (Array.isArray(streams)) {
      for (const s of streams) {
        // Parse quality markers from the stream name/title
        const height = parseHeight(s.quality);

        // Task 33: audio metadata. The FrameX API returns audioTracks: null
        // for its provider backends (verified live across movie/series/
        // anime requests), and buildStreamResults then fell back to the
        // source-level countryCodes — the old [multi, en, ja, ko] hardcode
        // that produced "Audio: English, Japanese, Korean" on English-only
        // films. When the API omits tracks, inject the content's REAL
        // audio language instead: anime → Japanese (extractor handles the
        // English dub), otherwise the TMDB original language, else English.
        // This ONLY touches meta labels — URLs, counts and playability are
        // untouched.
        const apiTracks = normalizeAudioTracks(s.audioTracks);
        if (apiTracks.length === 0) {
          s.audioTracks = [isAnime ? 'Japanese' : (ISO_LANG_NAMES[originalLanguage] || 'English')];
        }

        // Build enriched title with metadata markers
        let markers = [];
        // Task 33: do NOT re-push s.quality — the scraper's title already
        // embeds it ("FrameX <provider> <quality> <server>"), so the extra
        // marker duplicated it on cards ("headhunter 1080p headhunter 1080p").
        markers.push('WEB-DL');
        if (height === 2160) { markers.push('HEVC'); markers.push('HDR'); }
        else { markers.push('x264'); }

        // Audio language — prefer the API's own audioTracks metadata
        // ("Dual Audio (Hindi + English)" / "Hindi" / …), which also drives
        // the language flags + DUAL/MULTI tags via buildStreamResults;
        // fall back to the injected single-language track above.
        markers.push(buildAudioLabel(normalizeAudioTracks(s.audioTracks), s.hasMultipleAudio)
          || (isAnime ? 'Japanese' : 'English'));

        // Append markers to title for enrichMeta parsing
        s.title = (s.title || '') + ' ' + markers.join(' ');
      }
    }

    return buildStreamResults({
      streams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });
  }
}
