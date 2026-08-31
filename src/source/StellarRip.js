// src/source/StellarRip.js
// stellar.rip — movies/TV/anime/kdrama with direct HLS streams (up to 4K)
//
// Uses two paired scrapers:
//   - src/nuvio/stellarrip.cjs — source: TMDB ID → embed URL → resolveStreams
//   - src/nuvio/stellarrip-extractor.cjs — extractor: embed URL → direct m3u8 URLs
//
// Architecture (from stellar.rip JS bundle, reverse-engineered):
//   1. GET embed page → window.__REQUEST_TOKEN__ (JWT)
//   2. POST /api/playback-init → stream token (or PoW challenge if protected)
//   3. Solve PoW (SHA-256 starts with N zero bits) → POST again → stream token
//   4. POST /api/encrypt per server → signed GET URL for /api/stream-encrypted
//   5. GET stream-encrypted → { data: { stream_url } } — direct HLS/MP4 URL
//   6. Probe each playlist → real max resolution + audio/subtitle labels
//
// All requests ride ONE shared keep-alive https.Agent (IP-bound tokens, no IP
// rotation between connections). Retries with backoff on transient 403s.
//
// 19 servers (star-named): Rigel, Vega, Capella, Betelgeuse, Arcturus, Canopus,
// Procyon, Aldebaran, Spica, Deneb, Altair, Antares, Regulus, Castor, Polaris,
// Fomalhaut, Bellatrix, Pollux, Sirius.
//
// The stream CDN rejects non-browser User-Agents (error 1010) but accepts
// any Referer/client IP — so we pass User-Agent via requestHeaders + proxyHeaders.
//
// 4K SUPPORT: Servers marked fourKAvailability=confirmed (Rigel, Vega, Capella,
// Betelgeuse, Canopus, Sirius) return 3840x2160 (4K UHD) variants when available.
//
// ANIME: Anime is served as type=tv (Stellar only supports movie/tv). Multi-audio
// playlists include subbed + dubbed tracks — surfaced via audioNames.

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'stellarrip.cjs');
const require_ = createRequire(import.meta.url);

// Cache the scraper module — stellarrip.cjs has shared keep-alive sockets
// that benefit from reuse (single agent, single IP end-to-end).
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[stellarrip] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

// Map "4K" / quality labels from scraper to numeric height for meta.height.
function parseHeightFromQuality(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
  if (s.includes('1440')) return 1440;
  if (s.includes('1080')) return 1080;
  if (s.includes('720')) return 720;
  if (s.includes('480')) return 480;
  if (s.includes('360') || s.includes('304')) return 360;
  const m = s.match(/(\d{3,4})p?/);
  return m ? parseInt(m[1], 10) : undefined;
}

// Detect audio language from the audio names list (e.g. "English, Français")
// Returns the first non-"Track N" language, or '' if unknown.
function detectAudioLang(audioNames) {
  if (!Array.isArray(audioNames) || audioNames.length === 0) return '';
  // Filter out generic "Track 1", "Track 2" labels — these are unnamed audio tracks
  const named = audioNames.filter(n => !/^Track \d+$/i.test(n));
  if (named.length === 0) return '';
  const first = named[0].toLowerCase();
  if (first.includes('english')) return 'en';
  if (first.includes('japanese') || first.includes('日本')) return 'ja';
  if (first.includes('hindi')) return 'hi';
  if (first.includes('tamil')) return 'ta';
  if (first.includes('telugu')) return 'te';
  if (first.includes('french') || first.includes('français') || first.includes('francais')) return 'fr';
  if (first.includes('spanish') || first.includes('español')) return 'es';
  if (first.includes('german') || first.includes('deutsch')) return 'de';
  if (first.includes('italian') || first.includes('italiano')) return 'it';
  if (first.includes('portuguese') || first.includes('português')) return 'pt';
  if (first.includes('korean') || first.includes('한국')) return 'ko';
  if (first.includes('chinese') || first.includes('中文')) return 'zh';
  return '';
}

const LANG_TO_CC = {
  en: CountryCode.en, ja: CountryCode.ja, hi: CountryCode.hi,
  ta: CountryCode.ta, te: CountryCode.te, fr: CountryCode.fr,
  es: CountryCode.es, de: CountryCode.de, it: CountryCode.it,
  pt: CountryCode.pt, ko: CountryCode.ko, zh: CountryCode.zh,
};

export class StellarRip extends Source {
  constructor(fetcher) {
    super();
    this.id = 'stellarrip';
    this.label = 'StellarRip';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://stellar.rip';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min — stream tokens are time-limited
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Detect anime (TMDB original_language=ja + Animation genre) — Stellar
    // serves anime as type=tv with multi-audio playlists (subbed + dubbed).
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
    if (!mod || typeof mod.resolveStreams !== 'function') return [];

    // Stellar only accepts type=movie or type=tv — anime + kdrama are tv.
    const stellarType = tmdbId.season ? 'series' : 'movie';

    let rawStreams;
    try {
      rawStreams = await Promise.race([
        mod.resolveStreams({
          type: stellarType,
          tmdbId: tmdbId.id,
          ...(tmdbId.season ? { season: tmdbId.season, episode: tmdbId.episode } : {}),
        }, { verbose: false }),
        new Promise(r => setTimeout(() => r(null), 45000)),
      ]);
    } catch (e) {
      console.error(`[stellarrip] resolveStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(rawStreams) || rawStreams.length === 0) return [];

    // Filter out streams without a valid URL — Stellar may return null for
    // servers that failed to resolve (the scraper filters these but be safe).
    const validStreams = rawStreams.filter(s => {
      if (!s || !s.url || typeof s.url !== 'string') return false;
      if (!s.url.startsWith('http')) return false;
      return true;
    });

    if (validStreams.length === 0) {
      console.log(`[stellarrip] no playable streams`);
      return [];
    }

    // Build Source result objects directly (don't use buildStreamResults —
    // Stellar streams use proxyHeaders.request.User-Agent, not Referer, so
    // the standard NuvioExtractor routing doesn't apply. We set requestHeaders
    // directly so StreamResolver routes them via proxyHeaders).
    const results = [];
    for (const s of validStreams) {
      const serverName = s.serverName || s.name || 'Stellar';
      const height = parseHeightFromQuality(s.quality) || s.height || 1080;
      const codec = height >= 2160 ? 'HEVC' : 'x264';
      const audioLang = detectAudioLang((s.audio || '').split(',').map(a => a.trim()));
      const audioLabel = audioLang
        ? (audioLang.charAt(0).toUpperCase() + audioLang.slice(1))
        : (isAnime ? 'Japanese' : 'English');

      // Detect multi-audio (e.g. "Track 1, Track 2" → multi-audio content)
      const audioNames = (s.audio || '').split(',').map(a => a.trim()).filter(Boolean);
      const isMultiAudio = audioNames.length > 1;

      // Build country codes based on detected audio
      const langCC = LANG_TO_CC[audioLang];
      const streamCountryCodes = langCC && !baseCountryCodes.includes(langCC)
        ? [...baseCountryCodes, langCC]
        : baseCountryCodes;

      // Convert subtitles (array of language names) to Stremio subtitle format
      // Note: Stellar's `subtitles` is an array of language NAMES (e.g. ["English", "Français"])
      // not URLs. We can't attach them as playable subtitle tracks (Stremio needs URLs).
      // OpenSubtitles fallback in StreamResolver will attach proper subtitle URLs.
      // We just use them to detect country codes.
      const subtitleLangs = Array.isArray(s.subtitles) ? s.subtitles : [];
      for (const subLang of subtitleLangs) {
        const subCode = detectAudioLang([subLang]);
        const subCC = LANG_TO_CC[subCode];
        if (subCC && !streamCountryCodes.includes(subCC)) {
          streamCountryCodes.push(subCC);
        }
      }

      // Format: "{movie} — [StellarRip {server}] {height}p WEB-DL {codec} {audio}"
      // (no movie title — StreamResolver prepends it via meta.title)
      const displayTitle = `[StellarRip ${serverName}] ${height}p WEB-DL ${codec}${isMultiAudio ? ' MultiAudio' : ''} ${audioLabel}`;

      // Get the User-Agent from the scraper (CDN requires browser UA)
      const userAgent = s.requestHeaders?.['User-Agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

      // Parse the URL
      let url;
      try { url = new URL(s.url); } catch { continue; }

      // Detect HLS vs MP4
      const isHls = (s.format === 'hls') || s.url.includes('.m3u8') || s.url.includes('/playlist');
      const isMp4 = s.format === 'mp4' || s.url.includes('.mp4');

      results.push({
        url,
        format: isHls ? Format.hls : (isMp4 ? Format.mp4 : Format.unknown),
        // requestHeaders triggers proxyHeaders routing in StreamResolver
        // (matches how MovieBox, AniBD, etc. work)
        requestHeaders: { 'User-Agent': userAgent },
        meta: {
          countryCodes: streamCountryCodes,
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          height,
          sourceType: 'WebDL',
          codec,
          serverName, // StreamResolver shows "StellarRip · Rigel" instead of "· Nuvio"
          ...(isMultiAudio && { specialTags: 'Multi-Audio' }),
        },
      });
    }

    // Dedupe by URL (some servers may return same stream URL)
    const seenUrls = new Set();
    const deduped = results.filter(r => {
      const key = r.url.href;
      if (seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    });

    console.log(`[stellarrip] ${deduped.length} playable stream(s) (filtered ${results.length - deduped.length} duplicates)`);

    return deduped;
  }
}
