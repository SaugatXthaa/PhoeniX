// src/source/DesiFlix.js
// desiflix — movies, TV series, and anime with multi-audio HLS streams
//
// Uses the Nuvio provider (src/nuvio/desiflix.cjs) which fetches streams from
// manifest.desitvhub.eu.org. Returns HLS URLs from various CDNs
// (moon.ironwallnet.net, cdn6.streamraiwind.stream, vixsrc.to) and MP4 URLs
// from flixsix.com.
//
// The scraper uses native fetch() which times out on Render. We override
// globalThis.fetch with got-scraping before loading the scraper to fix this.
//
// Stream URL routing:
//   - vixsrc.to: HLS, no Referer needed (DirectStream handles it)
//   - cdn*.streamraiwind.stream: HLS, needs Referer: manifest.desitvhub.eu.org
//   - flixsix.com: MP4, no Referer needed
//   - pixeldrain.com: MP4, NO Referer (returns 403 with Referer)

import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults, callNuvioProvider } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'desiflix.cjs');

// Cache the got-scraping fetch override
let _gotFetch = null;
async function getGotFetch() {
  if (_gotFetch) return _gotFetch;
  try {
    const { gotScraping } = await import('got-scraping');
    _gotFetch = async (url, options = {}) => {
      const res = await gotScraping(url, {
        timeout: { request: options.timeout || 15000 },
        throwHttpErrors: false,
        headers: options.headers || {},
        method: options.method || 'GET',
        followRedirect: true,
      });
      return {
        ok: res.statusCode < 400,
        status: res.statusCode,
        statusText: res.statusMessage,
        json: async () => JSON.parse(res.body),
        text: async () => res.body,
      };
    };
  } catch (e) {
    console.error('[desiflix] Failed to load got-scraping for fetch override:', e.message);
  }
  return _gotFetch;
}

export class DesiFlix extends Source {
  constructor(fetcher) {
    super();
    this.id = 'desiflix';
    this.label = 'DesiFlix';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://manifest.desitvhub.eu.org';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Override globalThis.fetch with got-scraping for the DesiFlix scraper.
    // The scraper uses native fetch() which times out on Render due to TLS/DNS
    // issues with manifest.desitvhub.eu.org. got-scraping handles TLS better.
    const originalFetch = globalThis.fetch;
    const gotFetch = await getGotFetch();
    if (gotFetch) {
      globalThis.fetch = gotFetch;
    }

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      streams = await callNuvioProvider(PROVIDER_PATH, {
        tmdbId: tmdbId.id,
        mediaType,
        season: tmdbId.season || null,
        episode: tmdbId.episode || null,
        timeoutMs: 25000,
      });
    } finally {
      // Always restore the original fetch
      globalThis.fetch = originalFetch;
    }

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
