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
import bytes from 'bytes';
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
        new Promise(r => setTimeout(() => r(null), 25000)),
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
    // The scraper returns two types of streams:
    //
    //   HLS streams (Orbit/Valenox):
    //     name: "Stellar - Orbit"
    //     quality: "1080p" or "2160p"
    //     type: "application/vnd.apple.mpegurl"
    //     subtitles: [...]
    //
    //   Download files (DL — direct MKV/MP4 URLs):
    //     name: "Stellar - DL 1080p HDR" or "Stellar - DL 2160p ⚠"
    //     quality: "1080p" or "2160p"
    //     type: "video/x-matroska"
    //     behaviorHints: { filename: "Movie.2010.1080p.BluRay.REMUX.mkv" }
    //     title: "Movie (2010) [Stellar DL 1080p REMUX HDR] (65.95 GB)"
    //
    // We build a STREAM title (without the movie title — buildStreamResults
    // prepends it automatically). enrichMeta parses quality, sourceType,
    // codec, HDR, audio from the title.
    const enrichedStreams = directStreams.map(s => {
      const serverName = (s.name || '').replace(/^Stellar\s*-\s*/, '').trim();
      const height = parseHeight(s.quality) || 1080;
      const isDownload = s.type === 'video/x-matroska' || s.type === 'video/mp4' || (s.name || '').includes('DL ');
      const subtitles = Array.isArray(s.subtitles) ? s.subtitles.map(sub => ({
        id: sub.id || sub.lang || sub.language || 'en',
        url: sub.url,
        lang: sub.lang || sub.language || sub.label || 'English',
      })) : [];

      // Detect codec + source type from stream name/title
      // Download files have labels like "Inception (1080p BluRay DV HDR H265)"
      // HLS streams are typically WebDL
      const labelText = ((s.name || '') + ' ' + (s.title || '')).toLowerCase();
      let codec = 'x264';
      let sourceType = 'WebDL';

      if (labelText.includes('h265') || labelText.includes('hevc') || labelText.includes('x265')) {
        codec = 'HEVC';
      } else if (labelText.includes('remux')) {
        codec = 'AVC'; // REMUX is typically AVC/H264
      }

      if (labelText.includes('bluray') || labelText.includes('remux') || labelText.includes('bdrip')) {
        sourceType = labelText.includes('remux') ? 'BluRay Remux' : 'BluRay';
      } else if (labelText.includes('web-dl') || labelText.includes('webdl') || labelText.includes('webrip')) {
        sourceType = 'WebDL';
      }

      // Detect HDR/DV
      let hdrInfo = '';
      if (labelText.includes('dolby vision') || labelText.includes(' dv ')) {
        hdrInfo = ' DolbyVision';
      } else if (labelText.includes('hdr10+')) {
        hdrInfo = ' HDR10+';
      } else if (labelText.includes('hdr')) {
        hdrInfo = ' HDR';
      }

      // Parse file size from title (e.g. "(65.95 GB)")
      let fileSize = undefined;
      const sizeMatch = (s.title || '').match(/([\d.]+)\s*(GB|MB|TB)/i);
      if (sizeMatch) {
        const val = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        if (unit === 'GB') fileSize = Math.round(val * 1024 * 1024 * 1024);
        else if (unit === 'MB') fileSize = Math.round(val * 1024 * 1024);
        else if (unit === 'TB') fileSize = Math.round(val * 1024 * 1024 * 1024 * 1024);
      }

      const audioLabel = isAnime ? 'Japanese' : 'English';
      const streamType = isDownload ? sourceType : 'WEB-DL';

      // Build enriched STREAM title (WITHOUT movie title — buildStreamResults
      // prepends it). Format: "[Stellar {server}] {quality} {type} {codec} {hdr} {audio}"
      const enrichedTitle = `[Stellar ${serverName}] ${height}p ${streamType} ${codec}${hdrInfo} ${audioLabel}`;

      return {
        url: s.url,
        quality: s.quality || (height + 'p'),
        title: enrichedTitle,
        name: 'Stellar - ' + serverName,
        size: fileSize ? bytes(fileSize) : undefined,
        subtitles: subtitles.length > 0 ? subtitles : undefined,
        // Internal flags — used to inject per-stream meta into buildStreamResults
        _countryCodes: baseCountryCodes,
        _serverName: serverName,
        _isDownload: isDownload,
        _fileSize: fileSize,
        _sourceType: sourceType,
        _codec: codec,
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

    // Override per-stream meta (buildStreamResults uses source-level defaults)
    // — set serverName so StreamResolver shows "Stellar · Orbit" instead of
    //   "Stellar · Nuvio" (the NuvioExtractor's label)
    // — set countryCodes for anime detection
    // — set sourceType/codec/bytes for download files (BluRay REMUX, HDR, etc.)
    for (const r of results) {
      const matchedStream = enrichedStreams.find(s => s.url === r.url.href);
      if (matchedStream) {
        if (matchedStream._countryCodes) {
          r.meta.countryCodes = matchedStream._countryCodes;
        }
        if (matchedStream._serverName) {
          r.meta.serverName = matchedStream._serverName;
        }
        // Override sourceType + codec for download files (buildStreamResults
        // would otherwise detect WebDL from the URL, but download files are
        // actually BluRay REMUX rips)
        if (matchedStream._isDownload) {
          if (matchedStream._sourceType) r.meta.sourceType = matchedStream._sourceType;
          if (matchedStream._codec) r.meta.codec = matchedStream._codec;
          if (matchedStream._fileSize) r.meta.bytes = matchedStream._fileSize;
        }
      }
    }

    console.log(`[stellar] ${results.length} playable stream(s) (filtered out ${streams.length - directStreams.length} iframe)`);

    return results;
  }
}
