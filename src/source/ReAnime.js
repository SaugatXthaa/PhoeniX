// src/source/ReAnime.js
// reanime.to — anime with sub+dub direct playable HLS via FlixCloud CDN
//
// Uses the scraper (src/nuvio/reanime.cjs) which:
//   1. Searches reanime.to via /api/v1/search?q=<title>
//   2. Gets FlixCloud server list via /api/flix/<anilist_id>/<ep>
//   3. Resolves FlixCloud encryption chain (WASM + XOR)
//   4. Returns master.m3u8 URLs + XOR keys for decryption
//
// The m3u8 content is XOR-encrypted and segments have fake headers (WebP/PNG)
// so streams MUST go through /reanime-proxy endpoint for decryption.
//
// The source returns URLs like:
//   /reanime-proxy/playlist.m3u8?url=<master.m3u8>&key=<xor_key_b64>
//
// Both SUB (Japanese audio) and DUB (English audio) are supported.

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'reanime.cjs');
const require_ = createRequire(import.meta.url);

let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try { _scraperMod = require_(PROVIDER_PATH); }
  catch (e) { console.error(`[reanime] failed to load scraper: ${e?.message || e}`); }
  return _scraperMod;
}

export class ReAnime extends Source {
  constructor(fetcher) {
    super();
    this.id = 'reanime';
    this.label = 'ReAnime';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = 'https://reanime.to';
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min — stream tokens expire
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
      console.error(`[reanime] error: ${e?.message || e}`);
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

      // Build /reanime-proxy URL for XOR decryption
      const proxyUrl = new URL('/reanime-proxy/playlist.m3u8', ctx.hostUrl);
      proxyUrl.searchParams.set('url', s.url);
      if (s.reanime?.xorKeyB64) {
        proxyUrl.searchParams.set('key', s.reanime.xorKeyB64);
      }

      const isDub = (s.language || s.lang || '').toLowerCase().includes('dub');
      const audioLabel = isDub ? 'English (Dub)' : 'Japanese (Sub)';
      const countryCodes = isDub
        ? [CountryCode.multi, CountryCode.en, CountryCode.ja]
        : [CountryCode.multi, CountryCode.ja, CountryCode.en];

      const serverName = s.source || s.serverName || s.name || 'ReAnime';
      const height = parseInt((s.quality || '1080p').match(/(\d{3,4})/)?.[1] || '1080', 10);

      results.push({
        url: proxyUrl,
        format: Format.hls,
        meta: {
          countryCodes,
          title: `${title} — [ReAnime ${serverName}] ${audioLabel}`,
          sourceId: this.id,
          sourceLabel: this.label,
          height,
          sourceType: 'WebDL',
          codec: 'x264',
          serverName: `${serverName} ${isDub ? 'DUB' : 'SUB'}`,
          audioLabel: isDub ? 'English' : 'Japanese',
          isMultiAudio: true,
        },
      });
    }

    console.log(`[reanime] ${results.length} playable stream(s) [anime]`);
    return results;
  }
}
