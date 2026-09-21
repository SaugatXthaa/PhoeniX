// src/source/Cineby.js
// cineby.by — movies, series and anime with multi-quality HLS streams (up to 4K)
//
// Task 40 reverse engineering (verified 2026-09-16):
//   https://cineby.by/ is a Laravel Livewire catalog (TMDB-driven). Its player
//   pages iframe vidking.net embeds — movie /embed/movie/<tmdbId>, series
//   /embed/tv/<tmdbId>/<s>/<e> — so the playable backend IS vidking's
//   api.speedracelight.com (seed + XOR keystream "mvm1" cipher, full trail in
//   src/nuvio/cineby.cjs). The rewritten provider queries ALL live vidking
//   servers (Yoru/cdn, Breach/m4uhd, hdmovie→Vyse(English)/Fade(Hindi),
//   Killjoy, Omen, Raze) and attaches the API's inline VTT subtitles.
//
// Audio metadata: the cdn server serves the original audio. We use TMDB's
// original_language for the honest audio label (same pattern as VidEasy):
//   - Japanese (ja) → "Audio: Japanese" (anime)
//   - Korean (ko)   → "Audio: Korean"   (K-drama)
//   - English (en)  → "Audio: English"
//   - Other         → no specific language shown (just "Original")
// The language servers' own labels (English/Hindi) flow through per-card via
// buildStreamResults' title parsing.
//
// Anime: vidking serves anime from the same servers (Frieren/One Piece verified
// at 2160p). No dub servers exist in the current bundle — original audio + all
// working servers + inline subs is the full honest coverage of this site.

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode } from '../types.js';
import { getImdbId, getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';
import { TMDB_PRIMARY } from '../utils/site-secrets.cjs';
import srlSeed from '../utils/srlSeed.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'cineby.cjs');
const require_ = createRequire(import.meta.url);

// Cache the scraper module — module code doesn't change between requests
// (same pattern as VidEasy; avoids reload churn per request).
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[cineby] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

// Map TMDB original_language to PhoeniX CountryCode — same table as VidEasy
const LANG_TO_CC = {
  ja: CountryCode.ja,
  ko: CountryCode.ko,
  en: CountryCode.en,
  zh: CountryCode.zh,
  hi: CountryCode.hi,
  fr: CountryCode.fr,
  es: CountryCode.es,
  de: CountryCode.de,
  pt: CountryCode.pt,
  it: CountryCode.it,
};

export class Cineby extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cineby';
    this.label = 'Cineby';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://cineby.by';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min — stream URLs have short-lived tokens
  }

  async handleInternal(ctx, _type, id) {
    // Task 73: confirmed-down speedracelight API — instant honest zero, skip
    // even the TMDB lookups (self-heals within 120s of upstream recovery).
    if (srlSeed.isSrlDown()) {
      console.log('[Cineby] speedracelight down (cached edge 5xx) — fast-fail');
      return [];
    }
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // imdbId — the speedracelight API wants the show/movie imdb id on every
    // call (best-effort: the API accepts an empty value but matches worse).
    let imdbId = '';
    try {
      imdbId = (await getImdbId(this.fetcher, ctx, tmdbId)).id || '';
    } catch { /* best effort */ }

    // original_language → honest audio label (ja anime / ko K-drama / en)
    let originalLang = '';
    try {
      const type = tmdbId.season ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/${type}/${tmdbId.id}?api_key=${process.env.TMDB_API_KEY || TMDB_PRIMARY}`;
      const { gotScraping } = await import('got-scraping');
      const r = await gotScraping.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeout: { request: 8000 }, throwHttpErrors: false, http2: false,
      });
      if (r.statusCode === 200) {
        originalLang = JSON.parse(r.body).original_language || '';
      }
    } catch { /* best effort */ }
    const langCC = LANG_TO_CC[originalLang];
    const countryCodes = langCC
      ? [CountryCode.multi, langCC]
      : [CountryCode.multi]; // Unknown language — don't show wrong audio

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    console.log(`[Cineby] Request: tmdb=${tmdbId.id} type=${mediaType}${tmdbId.season ? ` S${tmdbId.season}E${tmdbId.episode || 1}` : ''} imdb=${imdbId || '-'} origLang=${originalLang || '-'}`);
    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

    // Direct require (cached) instead of callNuvioProvider — the provider takes
    // preloaded TMDB meta (title/year/imdbId) to skip a duplicate TMDB call.
    // Retry on empty sweeps: individual speedracelight servers 500/timeout
    // stochastically (verified across Task 40 probes); one empty sweep ≠ no
    // streams. Empty sweeps fail fast (~2-6s), so the retry stays well under
    // the resolver's 35s per-source cutoff. Race cap 30s for the same reason
    // as VidEasy — anything later never survives the 35s SOURCE_TIMEOUT.
    const EMPTY_RETRY_MAX = 2;
    const EMPTY_RETRY_DELAY_MS = 2000;

    const preloaded = { title: name, year: year ? String(year) : '', imdbId };

    let streams;
    try {
      streams = await Promise.race([
        (async () => {
          let out = await mod.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null, preloaded);
          for (let attempt = 0; Array.isArray(out) && out.length === 0 && attempt < EMPTY_RETRY_MAX; attempt++) {
            // Task 73: an empty sweep with a definitive edge 5xx on /seed =
            // whole-API outage — mark down and stop retrying (the ladder
            // cannot conjure streams from a dead origin, it only burns a
            // wave-0 slot every refresh).
            if (await srlSeed.probeSeedDown(tmdbId.id)) {
              srlSeed.markSrlDown();
              console.log('[Cineby] speedracelight edge 5xx — marked down 120s, skipping retries');
              break;
            }
            await new Promise(r => setTimeout(r, EMPTY_RETRY_DELAY_MS));
            out = await mod.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null, preloaded);
          }
          return out;
        })(),
        new Promise(r => setTimeout(() => r(null), 30000)),
      ]);
    } catch (e) {
      console.error(`[cineby] getStreams error: ${e?.message || e}`);
      return [];
    }
    if (!Array.isArray(streams)) return [];
    console.log(`[Cineby] provider returned ${streams.length} streams`);

    return buildStreamResults({
      streams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes,
      ctx,
    });
  }
}
