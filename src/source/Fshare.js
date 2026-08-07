// src/source/Fshare.js
// fsharetv.cc — movies-only direct stream provider
//
// Ported from cinepro-org/core/src/providers/fshare
// FshareTV serves movies via a 3-step flow:
//   1. GET /movie/{imdbId}           → HTML page, find /w/{watchPath} link
//   2. GET /w/{watchPath}            → HTML page, extract source_id (multiple regex patterns)
//   3. GET /api/file/{sourceId}/source → JSON with stream_urls (m3u8 + mp4 backups)
//
// Movies only — no TV support (cinepro provider explicitly returns empty for TV).
//
// The Fshare source returns the watch-page URL; the Fshare extractor
// performs the 3-step fetch chain.

import { CountryCode } from '../types.js';
import { getImdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://fsharetv.cc';

export class Fshare extends Source {
  constructor(fetcher) {
    super();
    this.id = 'fshare';
    this.label = 'FshareTV';
    this.contentTypes = ['movie'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    // Fshare needs an IMDb ID for the watch-page URL.
    const imdbIdObj = await getImdbId(this.fetcher, ctx, id);
    if (!imdbIdObj?.id) return [];

    const url = new URL(`/movie/${imdbIdObj.id}`, BASE_URL);

    return [{
      url,
      meta: {
        countryCodes: [CountryCode.multi],
        title: `FshareTV`,
      },
    }];
  }
}
