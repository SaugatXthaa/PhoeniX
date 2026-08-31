// src/source/HDHub4uV2.js
// new5.hdhub4u.cl + 4khdhub.one — movies/TV with direct download links (up to 4K)
//
// Uses the all-in-one scraper (src/nuvio/hdhub4u_v2.cjs) which:
//   1. Searches site sitemaps (post-sitemap*.xml)
//   2. Finds hubcloud.cx/drive/{id} + hubcdn.sbs/file/{id} + hdstream4u.com/file/{id} links
//   3. Resolves hubcloud → gamerxyt.com → GDrive (googleusercontent) or pixeldrain
//   4. Resolves hubcdn → base64 decode → GDrive URL
//   5. Resolves hdstream4u → Dean-Edwards JS unpack → HLS m3u8 URL
//
// Returns direct playable URLs (MKV from GDrive, HLS from acek-cdn/dramiyos-cdn).

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import bytes from 'bytes';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'hdhub4u_v2.cjs');
const require_ = createRequire(import.meta.url);

let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try { _scraperMod = require_(PROVIDER_PATH); }
  catch (e) { console.error(`[hdhub4u-v2] failed to load scraper: ${e?.message || e}`); }
  return _scraperMod;
}

function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('2160') || s.includes('4k')) return 2160;
  if (s.includes('1080')) return 1080;
  if (s.includes('720')) return 720;
  if (s.includes('480')) return 480;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : undefined;
}

export class HDHub4uV2 extends Source {
  constructor(fetcher) {
    super();
    this.id = 'hdhub4uv2';
    this.label = 'HDHub4u';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://new5.hdhub4u.cl';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

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
      console.error(`[hdhub4u-v2] error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    // Convert scraper streams to buildStreamResults format
    const enrichedStreams = streams.map(s => {
      const height = parseHeight(s.quality) || 1080;
      const isHls = s.type === 'application/vnd.apple.mpegurl' || (s.url || '').includes('.m3u8');
      const isGDrive = (s.url || '').includes('googleusercontent.com');
      const codec = height >= 2160 ? 'HEVC' : 'x264';

      // Parse file size from title if available
      let fileSize = undefined;
      const sizeMatch = (s.title || '').match(/([\d.]+)\s*(GB|MB)/i);
      if (sizeMatch) {
        const val = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        fileSize = unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
      }

      return {
        url: s.url,
        quality: height + 'p',
        title: `[HDHub4u ${height}p WEB-DL ${codec} Hindi-English]`,
        name: 'HDHub4u - ' + (s.quality || height + 'p'),
        size: fileSize ? bytes(fileSize) : undefined,
        headers: isGDrive ? { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' } : undefined,
      };
    });

    return buildStreamResults({
      streams: enrichedStreams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });
  }
}
