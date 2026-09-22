// src/source/Atlantic.js — atlantic.st (Task 48 reverse engineering; Task 55 budget fix)
//
// https://atlantic.st/ is a TMDB-driven React SPA with two stream servers
// (full RE trail in src/nuvio/atlantic.cjs):
//   Artemis   — stellar.maybeoneday.ch/resolve (Orbit fMP4 up to 2160p movies/
//               TV, Nova muxed up to 1080p anime/TV) — no signing
//   Aphrodite — cdn.maybeoneday.ch/content/... (curated single-4K-variant
//               masters) — aphrodite.a.v1 HMAC/AES-GCM gate (port in scraper)
// Subtitles: the source no longer fetches its own (Task 55) — StreamResolver's
// unified stack (src/utils/siteSubtitles.cjs) runs the SAME granite+natsuki
// providers ONCE per title and merges the set into EVERY source's cards,
// Atlantic's included. One provider set for movies/series/kdramas/animes.
//
// Audio metadata: Orbit multi-audio masters carry unnamed audio groups
// ("Audio 1"/"Audio 2", no LANGUAGE attribute upstream) — the card title says
// "N audio tracks" without inventing languages. For the source-level flag we
// use TMDB original_language (Cineby/VidEasy pattern): ja → Japanese (anime),
// ko → Korean, en → English. Nova muxed streams carry the original audio.
//
// Anime: served through the same TV path (Frieren/One Piece verified via Nova,
// muxed Japanese audio + site subs). No separate dub endpoints exist in the
// bundle — when a title's HLS has multiple audio groups the card exposes them
// via the player's audio menu; nothing is fabricated.

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode } from '../types.js';
import { getImdbId, getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';
import { TMDB_PRIMARY } from '../utils/site-secrets.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'atlantic.cjs');
const require_ = createRequire(import.meta.url);

let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[atlantic] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

// TMDB original_language → honest audio flag (same table as Cineby)
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

export class Atlantic extends Source {
  constructor(fetcher) {
    super();
    this.id = 'atlantic';
    this.label = 'Atlantic';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://atlantic.st';
    this.fetcher = fetcher;
    // Payload URLs are opaque signed blobs upstream; the site refetches every
    // play. Task 79: the payload workers now rotate payloads every ~30-60s
    // (verified live — a minutes-old card URL decoys to the SPA shell), so the
    // old 10min TTL served guaranteed-dead URLs from cache. 60s keeps cached
    // cards inside the payload lifetime; expired entries re-resolve fresh.
    this.ttl = 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    let imdbId = '';
    try {
      imdbId = (await getImdbId(this.fetcher, ctx, tmdbId)).id || '';
    } catch { /* best effort — natsuki matches by tmdbId without it */ }

    // original_language → honest audio label — fetched in PARALLEL with the
    // scraper (it only feeds buildStreamResults' countryCodes, so the serial
    // path pays zero for it; production evidence: 4 serial TMDB-phase calls
    // under Render resolve storms ate 15-18s before the scraper even started,
    // then the 20s race expired with 0 cards).
    const mediaType0 = tmdbId.season ? 'tv' : 'movie';
    const origLangP = (async () => {
      try {
        const url = `https://api.themoviedb.org/3/${mediaType0}/${tmdbId.id}?api_key=${process.env.TMDB_API_KEY || TMDB_PRIMARY}`;
        const { gotScraping } = await import('got-scraping');
        const r = await gotScraping.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
          timeout: { request: 8000 }, throwHttpErrors: false, http2: false,
        });
        return r.statusCode === 200 ? (JSON.parse(r.body).original_language || '') : '';
      } catch { return ''; }
    })().catch(() => '');

    const mediaType = mediaType0;
    console.log(`[Atlantic] Request: tmdb=${tmdbId.id} type=${mediaType}${tmdbId.season ? ` S${tmdbId.season}E${tmdbId.episode || 1}` : ''} imdb=${imdbId || '-'} (origLang pending)`);
    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

    // Both servers run in parallel inside the scraper (~2-5s measured
    // uncontended, deadline-bounded 10.5s inside the scraper since Task 55).
    // One empty retry absorbs transient upstream windows — SKIPPED when the
    // first attempt already consumed most of the client budget (a retry would
    // blow past it and the client-budget cutoff would zero the source again).
    const EMPTY_RETRY_MAX = 1;
    const EMPTY_RETRY_DELAY_MS = 2000;
    const EMPTY_RETRY_MAX_FIRST_MS = 8000;

    const preloaded = {
      title: name,
      year: year ? String(year) : '',
      imdbId,
      hostUrl: ctx?.hostUrl ? ctx.hostUrl.href : '',
      // Task 55: route all upstream GETs through the addon Fetcher (family:4,
      // node-level timeout, got-scraping CF fallback) — bare undici fetch
      // stalls on Render during resolve storms past AbortSignal deadlines,
      // which was pushing Atlantic past the client budget (zero cards).
      fetcher: this.fetcher,
      ctx,
    };

    let streams;
    try {
      const t0 = Date.now();
      let out = await mod.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null, preloaded);
      for (let attempt = 0; Array.isArray(out) && out.length === 0 && attempt < EMPTY_RETRY_MAX; attempt++) {
        if (Date.now() - t0 > EMPTY_RETRY_MAX_FIRST_MS) {
          console.log(`[Atlantic] first attempt took ${Date.now() - t0}ms — skipping empty-retry (client budget)`);
          break;
        }
        await new Promise(r => setTimeout(r, EMPTY_RETRY_DELAY_MS));
        out = await mod.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null, preloaded);
      }
      streams = out;
    } catch (e) {
      console.error(`[atlantic] getStreams error: ${e?.message || e}`);
      return [];
    }
    if (!Array.isArray(streams)) return [];
    const originalLang = await Promise.race([origLangP, new Promise(r => setTimeout(() => r(''), 9000))]);
    console.log(`[Atlantic] provider returned ${streams.length} streams (origLang=${originalLang || '-'})`);
    const langCC = LANG_TO_CC[originalLang];
    const countryCodes = langCC ? [CountryCode.multi, langCC] : [CountryCode.multi];

    const results = buildStreamResults({
      streams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes,
      ctx,
    });

    // Task 60: artemis/aphrodite payload cards are /proxy-wrapped INSIDE the
    // scraper (wrapArtemis) and validate strictly from our IP before shipping
    // — the old ipGated → nuvioDirectWithHeaders direct-shipping hung on iOS
    // (payload workers trailer-redirect headerless requests). The mapping
    // below can no longer match (raw streams carry no ipGated flag) and is
    // kept only as a no-op safeguard.
    const rawByHref = new Map(streams.map(s => [s.url, s]));
    for (const r of results) {
      const raw = r?.url ? rawByHref.get(r.url.href) : null;
      if (raw?.ipGated && r.meta) {
        r.meta.nuvioDirectWithHeaders = true;
      }
    }
    return results;
  }
}
