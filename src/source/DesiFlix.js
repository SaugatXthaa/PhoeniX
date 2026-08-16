// src/source/DesiFlix.js
// desiflix — movies, TV series, and anime with multi-audio HLS streams
//
// Uses the Nuvio provider (src/nuvio/desiflix.cjs) which fetches streams from
// manifest.desitvhub.eu.org. Returns HLS URLs from various CDNs
// (moon.ironwallnet.net, cdn6.streamraiwind.stream, vixsrc.to) and MP4 URLs
// from flixsix.com.
//
// The scraper uses native fetch() which times out on Render. We override
// globalThis.fetch with got-scraping before calling getStreams, then restore it.
//
// Stream URL routing:
//   - vixsrc.to: HLS, no Referer needed (DirectStream handles it)
//   - cdn*.streamraiwind.stream: HLS, needs Referer: manifest.desitvhub.eu.org
//   - flixsix.com: MP4, no Referer needed
//   - pixeldrain.com: MP4, NO Referer (returns 403 with Referer)

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'desiflix.cjs');

// Cache the scraper module — it's immutable, safe to cache
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    delete require_.cache[require_.resolve(PROVIDER_PATH)];
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[desiflix] failed to load scraper: ${e?.message || e}`);
  }
  return _scraperMod;
}

// Cache the got-scraping fetch override
let _gotFetch = null;
async function getGotFetch() {
  if (_gotFetch) return _gotFetch;
  try {
    const { gotScraping } = await import('got-scraping');
    _gotFetch = async (url, options = {}) => {
      const res = await gotScraping(url, {
        timeout: { request: 15000 },
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

    // Load the scraper module (cached)
    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

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
      streams = await Promise.race([
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season || null, tmdbId.episode || null),
        new Promise(r => setTimeout(() => r(null), 25000)),
      ]);
    } catch (e) {
      console.error(`[desiflix] getStreams error: ${e?.message || e}`);
      streams = null;
    } finally {
      // Always restore the original fetch
      globalThis.fetch = originalFetch;
    }

    if (!Array.isArray(streams)) return [];

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
