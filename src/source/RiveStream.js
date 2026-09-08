// src/source/RiveStream.js
// rivestream.ru — multi-server direct HLS streams (movies + TV, up to 4K)
//
// Uses the scraper (src/nuvio/rivestream.cjs) which queries 11 backend
// providers via scrapper.rivestream.app/api/provider:
//   apex, citadel, primevids, quasar, solstice, horizon, pulse,
//   flowcast, asiacloud, hindicast, guru
//
// Returns DIRECT PLAYABLE HLS streams:
//   - Citadel: img1.*.com m3u8 (multi-language: English/Hindi/Tamil/Telugu)
//   - PrimeVids: ngcorp.dad m3u8 (needs Referer: rivestream.ru)
//   - Apex: proxied m3u8 via valhallastream.dpdns.org (multi-quality)
//   - FlowCast: hakunaymatata.com MP4 (via proxy)
//   - Quasar: uqload.vc HLS
//
// ENRICHED METADATA (from scraper):
//   - height: 360/480/720/1080/2160
//   - audioLabel: multi/English/Hindi/Tamil/Telugu/Japanese
//   - serverName: provider name (Apex/Citadel/PrimeVids/etc.)
//   - sourceType: WebDL
//   - codec: x264/HEVC

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'rivestream.cjs');
const require_ = createRequire(import.meta.url);

let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try { _scraperMod = require_(PROVIDER_PATH); }
  catch (e) { console.error(`[rivestream] failed to load scraper: ${e?.message || e}`); }
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
    if ((data.genres || []).some(g => g.id === 16)) return true;
    if (data.original_language === 'ja') return true;
    return false;
  } catch { return false; }
}

function parseHeight(q) {
  if (!q) return 1080;
  const s = String(q).toLowerCase();
  if (s.includes('2160') || s.includes('4k')) return 2160;
  if (s.includes('1080')) return 1080;
  if (s.includes('720')) return 720;
  if (s.includes('480')) return 480;
  if (s.includes('360')) return 360;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : 1080;
}

function parseLanguage(lang) {
  if (!lang) return 'English';
  const l = lang.toLowerCase();
  if (l.includes('multi')) return 'Multi Audio';
  if (l.includes('japanese')) return 'Japanese';
  if (l.includes('hindi')) return 'Hindi';
  if (l.includes('tamil')) return 'Tamil';
  if (l.includes('telugu')) return 'Telugu';
  if (l.includes('kannada')) return 'Kannada';
  if (l.includes('english')) return 'English';
  return 'English';
}

function parseCountryCodes(lang, isAnime) {
  const l = (lang || '').toLowerCase();
  const codes = new Set(['multi']);
  if (l.includes('hindi') || isAnime) codes.add('hi');
  if (l.includes('english') || isAnime) codes.add('en');
  if (l.includes('japanese') || isAnime) codes.add('ja');
  if (l.includes('tamil')) codes.add('ta');
  if (l.includes('telugu')) codes.add('te');
  if (codes.size === 1) codes.add('en');
  return [...codes];
}

export class RiveStream extends Source {
  constructor(fetcher) {
    super();
    this.id = 'rivestream';
    this.label = 'RiveStream';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en, CountryCode.hi, CountryCode.ja];
    this.baseUrl = 'https://rivestream.ru';
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min — stream URLs have short-lived auth tokens
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
        new Promise(r => setTimeout(() => r(null), 30000)),
      ]);
    } catch (e) {
      console.error(`[rivestream] error: ${e?.message || e}`);
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

      const height = parseHeight(s.quality);
      const language = parseLanguage(s.language || s.lang);
      const countryCodes = parseCountryCodes(language, isAnime);
      const serverName = s.source || s.providerName || 'RiveStream';
      const sourceName = s.sourceName || '';
      const codec = height >= 2160 ? 'HEVC' : 'x264';

      // Determine if URL is HLS or MP4
      const isHls = url.pathname.includes('.m3u8') || s.format === 'hls' || s.format === 'application/vnd.apple.mpegurl';
      const isMp4 = url.pathname.includes('.mp4') || s.format === 'mp4';

      // For HLS streams that need Referer (Citadel img1.*, PrimeVids ngcorp.dad):
      // Use requestHeaders (proxyHeaders) so Stremio sends the Referer directly.
      // For proxied URLs (valhallastream.dpdns.org): use directly (they handle Referer internally)
      // For FlowCast (hakunaymatata.com): route through /proxy with Referer
      const needsReferer = !url.hostname.includes('valhallastream.dpdns.org') &&
                          !url.hostname.includes('localhost');

      const audioLabel = isAnime && language === 'Japanese' ? 'Japanese (Sub)' :
                         isAnime && language === 'English' ? 'English (Dub)' :
                         language;

      if (needsReferer) {
        // Set requestHeaders → StreamResolver will route through /proxy automatically
        results.push({
          url,
          format: isHls ? Format.hls : Format.mp4,
          requestHeaders: { 'Referer': 'https://rivestream.ru/' },
          meta: {
            countryCodes,
            title: `${title} — [RiveStream ${serverName}] ${height}p ${audioLabel}`,
            sourceId: this.id,
            sourceLabel: this.label,
            height,
            sourceType: 'WebDL',
            codec,
            serverName: `${serverName}${sourceName ? ' ' + sourceName : ''}`,
            audioLabel: language,
            isMultiAudio: language === 'Multi Audio' || /multi/i.test(language),
            ...(isAnime && { isMultiAudio: true }),
          },
        });
      } else {
        // URL is already proxied (valhallastream) — use directly
        results.push({
          url,
          format: isHls ? Format.hls : Format.mp4,
          meta: {
            countryCodes,
            title: `${title} — [RiveStream ${serverName}] ${height}p ${audioLabel}`,
            sourceId: this.id,
            sourceLabel: this.label,
            height,
            sourceType: 'WebDL',
            codec,
            serverName: `${serverName}${sourceName ? ' ' + sourceName : ''}`,
            audioLabel: language,
            isMultiAudio: language === 'Multi Audio' || /multi/i.test(language),
            ...(isAnime && { isMultiAudio: true }),
          },
        });
      }
    }

    console.log(`[rivestream] ${results.length} playable stream(s)${isAnime ? ' [anime]' : ''}`);
    return results;
  }
}
