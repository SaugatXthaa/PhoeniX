// src/source/HDHub4u.js
// hdhub4u — movies/series with HubCloud/HubCDN/GDrive download links
//
// Uses the Nuvio provider (src/nuvio/hdhub4u.cjs) which searches new1.hdhub4u.af,
// parses quality headings (h3/h4/h5) with download links, and returns URLs
// for hubcdn.sbs, hubcloud.*, pixeldrain, and googleusercontent.
//
// The hub_extractor.js stub (passthrough) returns URLs as-is so the existing
// PhoeniX extractor pipeline handles resolution:
//   - hubcdn.sbs → HubExtractor → direct CDN URL
//   - hubcloud.* → HubCloud extractor → pixel.hubcloud.cx
//   - pixeldrain → DirectStream → direct playable URL
//   - googleusercontent → DirectStream → direct playable URL
//
// NOT in NUVIO_SOURCE_IDS — URLs flow through to HubExtractor/DirectStream
// naturally (NuvioExtractor would otherwise claim them and return directly).

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'hdhub4u.cjs');

export class HDHub4u extends Source {
  constructor(fetcher) {
    super();
    this.id = 'hdhub4u';
    this.label = 'HDHub4u';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://new1.hdhub4u.af';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    const streams = await callNuvioProvider(PROVIDER_PATH, {
      tmdbId: tmdbId.id,
      mediaType,
      season: tmdbId.season || null,
      episode: tmdbId.episode || null,
      timeoutMs: 25000,
    });

    return buildStreamResults({
      streams,
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: this.countryCodes,
      ctx,
    });
  }
}
