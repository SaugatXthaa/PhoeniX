// src/source/AnimeSuge.js
// animesuge.at — anime with sub+dub HLS streams
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Search: GET /api/animesuge/anime/search?keyword={query}
//   3. Get anime page → extract data-id
//   4. Get servers: GET /api/animesuge/server/list?id={id}&episode={n}
//      → parse data-type (sub/dub), data-link (base64 megaplay.buzz URL)
//   5. Resolve megaplay.buzz stream → getSources API → HLS m3u8 URL
//   6. The m3u8 URL is on megap.akirax.buzz (or similar) — requires
//      Referer: https://megaplay.buzz/
//
// The AnimeDirect extractor already claims megap.* URLs and routes them
// through /proxy with the correct Referer. So this source just returns
// the original stream URL with meta.sourceId = 'animesuge'.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'animesuge.cjs');

export class AnimeSuge extends Source {
  constructor(fetcher) {
    super();
    this.id = 'animesuge';
    this.label = 'AnimeSuge';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = 'https://animesuge.at';
    this.fetcher = fetcher;
    this.ttl = 5 * 60 * 1000; // 5min — stream URLs have short-lived tokens
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Load the provider module (CommonJS)
    let provider;
    try {
      delete require_.cache[require_.resolve(PROVIDER_PATH)];
      provider = require_(PROVIDER_PATH);
    } catch (e) {
      console.error(`[animesuge] failed to load provider: ${e?.message || e}`);
      return [];
    }
    if (!provider || typeof provider.getStreams !== 'function') return [];

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await Promise.race([
        provider.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null),
        new Promise(r => setTimeout(() => r(null), 20000)),
      ]);
    } catch (e) {
      console.error(`[animesuge] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    const results = [];
    for (const s of streams) {
      if (!s || !s.url || typeof s.url !== 'string') continue;
      if (!s.url.startsWith('http')) continue;

      let url;
      try { url = new URL(s.url); } catch { continue; }

      // Determine sub/dub from the provider's meta.category or title
      const category = s.meta?.category || (s.title?.includes('DUB') ? 'dub' : 'sub');
      const audioLabel = category === 'dub' ? 'DUB' : 'SUB';
      const countryCodes = category === 'dub'
        ? [CountryCode.multi, CountryCode.en]
        : [CountryCode.multi, CountryCode.ja];

      // Parse quality
      let height = 1080;
      const q = String(s.quality || '').toLowerCase();
      if (q.includes('4k') || q.includes('2160')) height = 2160;
      else if (q.includes('720')) height = 720;
      else if (q.includes('480')) height = 480;
      else {
        const m = q.match(/(\d{3,4})/);
        if (m) height = parseInt(m[1]);
      }

      results.push({
        url,
        format: Format.hls,
        // Route through /proxy with Referer — kryntal.top needs Referer: https://megaplay.buzz/
        requestHeaders: { Referer: 'https://megaplay.buzz/' },
        meta: {
          countryCodes,
          title: `${title} (AnimeSuge ${audioLabel})`,
          sourceId: this.id,
          sourceLabel: this.label,
          height,
        },
      });
    }

    return results;
  }
}
