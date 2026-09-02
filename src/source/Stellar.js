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
//   - Nova (h.themepark.workers.dev) — alternate CDN
//   - Download files (DL — direct MKV/MP4 URLs up to 4K BluRay REMUX)
//
// The stream URL works WITHOUT Referer/auth headers — completely public once
// resolved. Stremio plays it directly via HLS.

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import bytes from 'bytes';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'stellar.cjs');
const require_ = createRequire(import.meta.url);

let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try { _scraperMod = require_(PROVIDER_PATH); }
  catch (e) { console.error(`[stellar] failed to load scraper: ${e?.message || e}`); }
  return _scraperMod;
}

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
    this.ttl = 10 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

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
          (data.genres || []).some(g => g.id === 16);
      }
    } catch { /* best effort */ }

    const baseCountryCodes = isAnime
      ? [CountryCode.multi, CountryCode.ja]
      : [CountryCode.multi, CountryCode.en];

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
      console.error(`[stellar] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    const directStreams = streams.filter(s => {
      if (!s || !s.url || typeof s.url !== 'string') return false;
      if (!s.url.startsWith('http')) return false;
      if (s.type === 'iframe') return false;
      if (s.behaviorHints?.notWebVideo === true) return false;
      return true;
    });

    if (directStreams.length === 0) return [];

    const enrichedStreams = directStreams.map(s => {
      const serverName = (s.name || '').replace(/^Stellar\s*-\s*/, '').trim();
      const height = parseHeight(s.quality) || 1080;
      const isDownload = s.type === 'video/x-matroska' || s.type === 'video/mp4' || (s.name || '').includes('DL ');
      const subtitles = Array.isArray(s.subtitles) ? s.subtitles.map(sub => ({
        id: sub.id || sub.lang || sub.language || 'en',
        url: sub.url,
        lang: sub.lang || sub.language || sub.label || 'English',
      })) : [];

      const labelText = ((s.name || '') + ' ' + (s.title || '')).toLowerCase();
      let codec = 'x264';
      let sourceType = 'WebDL';

      if (labelText.includes('h265') || labelText.includes('hevc') || labelText.includes('x265')) {
        codec = 'HEVC';
      } else if (labelText.includes('remux')) {
        codec = 'AVC';
      }

      if (labelText.includes('bluray') || labelText.includes('remux') || labelText.includes('bdrip')) {
        sourceType = labelText.includes('remux') ? 'BluRay Remux' : 'BluRay';
      }

      let hdrInfo = '';
      if (labelText.includes('dolby vision') || labelText.includes(' dv ')) {
        hdrInfo = ' DolbyVision';
      } else if (labelText.includes('hdr10+')) {
        hdrInfo = ' HDR10+';
      } else if (labelText.includes('hdr')) {
        hdrInfo = ' HDR';
      }

      let fileSize = undefined;
      const sizeMatch = (s.title || '').match(/([\d.]+)\s*(GB|MB)/i);
      if (sizeMatch) {
        const val = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        if (unit === 'GB') fileSize = Math.round(val * 1024 * 1024 * 1024);
        else if (unit === 'MB') fileSize = Math.round(val * 1024 * 1024);
      }

      const audioLabel = isAnime ? 'Japanese' : 'English';
      const streamType = isDownload ? sourceType : 'WEB-DL';

      return {
        url: s.url,
        quality: s.quality || (height + 'p'),
        title: `[Stellar ${serverName}] ${height}p ${streamType} ${codec}${hdrInfo} ${audioLabel}`,
        name: 'Stellar - ' + serverName,
        size: fileSize ? bytes(fileSize) : undefined,
        subtitles: subtitles.length > 0 ? subtitles : undefined,
        _countryCodes: baseCountryCodes,
        _serverName: serverName,
        _isDownload: isDownload,
        _fileSize: fileSize,
        _sourceType: sourceType,
        _codec: codec,
      };
    });

    const results = buildStreamResults({
      streams: enrichedStreams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: baseCountryCodes,
      ctx,
    });

    for (const r of results) {
      const matchedStream = enrichedStreams.find(s => s.url === r.url.href);
      if (matchedStream) {
        if (matchedStream._countryCodes) r.meta.countryCodes = matchedStream._countryCodes;
        if (matchedStream._serverName) r.meta.serverName = matchedStream._serverName;
        if (matchedStream._isDownload) {
          if (matchedStream._sourceType) r.meta.sourceType = matchedStream._sourceType;
          if (matchedStream._codec) r.meta.codec = matchedStream._codec;
          if (matchedStream._fileSize) r.meta.bytes = matchedStream._fileSize;
        }
      }
    }

    console.log(`[stellar] ${results.length} playable stream(s)`);
    return results;
  }
}
