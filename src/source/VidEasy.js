// src/source/VidEasy.js
// videasy — movies and TV series with multi-quality HLS streams (up to 4K)
//
// Uses the Nuvio provider (src/nuvio/videasy.cjs) which queries 10 speedracelight
// servers in parallel (Hydrogen, Titanium, Oxygen, Lithium, Krypton, Carbon,
// Aluminium, Nitrogen, Neon, Helium). Returns HLS URLs from moon.ironwallnet.net.
// Requires Referer: https://www.vidking.net/
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Fetch TMDB details to get original_language (for correct audio metadata)
//   3. Call provider.getStreams(tmdbId, 'movie'|'tv', season, episode)
//   4. Convert streams to Source result format via buildStreamResults()
//
// Audio metadata: VidEasy returns "Original Audio" — the actual language depends
// on the content. We use TMDB's original_language to set the correct audio:
//   - Japanese (ja) → "Audio: Japanese" (anime)
//   - Korean (ko) → "Audio: Korean" (K-drama)
//   - English (en) → "Audio: English"
//   - Other → no specific language shown (just "Original")

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'videasy.cjs');

// Map TMDB original_language to PhoeniX CountryCode
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

export class VidEasy extends Source {
  constructor(fetcher) {
    super();
    this.id = 'videasy';
    this.label = 'VidEasy';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://player.videasy.net';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Fetch TMDB details to get original_language for correct audio metadata
    let originalLang = '';
    try {
      const type = tmdbId.season ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/${type}/${tmdbId.id}?api_key=${process.env.TMDB_API_KEY || ''}`;
      const { gotScraping } = await import('got-scraping');
      const r = await gotScraping.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeout: { request: 8000 }, throwHttpErrors: false, http2: false,
      });
      if (r.statusCode === 200) {
        const data = JSON.parse(r.body);
        originalLang = data.original_language || '';
      }
    } catch { /* best effort */ }

    // Map original_language to countryCodes — don't guess, only add if known
    const langCC = LANG_TO_CC[originalLang];
    const countryCodes = langCC
      ? [CountryCode.multi, langCC]
      : [CountryCode.multi]; // Unknown language — don't show wrong audio

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType,
      season: tmdbId.season || null,
      episode: tmdbId.episode || null,
      timeoutMs: 25000, // Videasy queries 10 servers, cap at 25s
    });

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
