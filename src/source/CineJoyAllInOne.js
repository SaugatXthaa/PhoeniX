// src/source/CineJoyAllInOne.js
// cinejoy.pk (was cinejoy.to) — movies, TV series, anime (sub+dub) with HLS streams up to 4K
//
// Uses the all-in-one cinejoy scraper (src/nuvio/cinejoy_all_in_one.cjs) which
// implements the lumen-gate-v2 Noise protocol with embedded crush.wasm.
// Returns HLS m3u8 and direct file URLs from 7 servers:
//   Lisbon (4K HDR), Solara (multi-quality), Athens/Castle (synthetic HLS),
//   Joy, Sakura (anime), Canaias (multi-quality MP4)
//
// Stream URLs from movieboxnoob.cc and shegu.st require:
//   Referer: https://cinejoy.pk/
//   Origin: https://cinejoy.pk
// These are passed via meta.nuvioReferer so NuvioExtractor routes through /proxy.
// (2026-09-17: site migrated cinejoy.to → cinejoy.pk; backend api.shegu.st →
//  api.wing.st — both now handled inside cinejoy_all_in_one.cjs)
//
// The upstream API wraps stream URLs through its own URL-wrapper host — we
// unwrap them and route them through the addon's own playback paths.
// (The wrapper path is host-agnostic: /hls/cinejoy/resource/{base64url}/…)
// through our own /proxy endpoint instead.

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { buildStreamResults } from './nuvioHelpers.js';
import { TMDB_PRIMARY } from '../utils/site-secrets.cjs'; // central site-secret registry (env-overridable)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'cinejoy_all_in_one.cjs');
const require_ = createRequire(import.meta.url);

// Cache the scraper module — it has WASM initialization that we don't want to repeat
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    const fs = require_('fs');
    const code = fs.readFileSync(PROVIDER_PATH, 'utf8');
    const moduleObj = { exports: {} };
    // The .cjs file uses module.exports — eval in a sandbox
    // The .cjs file does `const crypto = require('crypto')` internally
    // We pass crypto module as a parameter to avoid redeclaration
    const fn = new Function('module', 'exports', 'require', code);
    fn(moduleObj, moduleObj.exports, require_);
    _scraperMod = moduleObj.exports;
  } catch (e) {
    console.error(`[cinejoy-aio] failed to load scraper: ${e?.message || e}`);
  }
  return _scraperMod;
}

// Unwrap the site's proxy URL to get the original URL + headers
function unwrapSiteProxy(url) {
  if (!url || !url.includes('/hls/cinejoy/resource/')) return { url, referer: 'https://cinejoy.pk/' };
  try {
    // <wrapper-host>/hls/cinejoy/resource/{base64url}/media.m3u8
    const match = url.match(/\/resource\/([^/]+)/);
    if (match) {
      const decoded = Buffer.from(match[1], 'base64url').toString('utf8');
      const data = JSON.parse(decoded);
      return {
        url: data.url || url,
        referer: data.headers?.Referer || 'https://cinejoy.pk/',
      };
    }
  } catch {}
  return { url, referer: 'https://cinejoy.pk/' };
}

// Parse quality string to height
function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('2160') || s.includes('4k') || s.includes('uhd')) return 2160;
  const m = s.match(/(\d{3,4})p/);
  return m ? parseInt(m[1]) : undefined;
}

export class CineJoyAllInOne extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinejoyaio';
    this.label = 'CineJoy';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en, CountryCode.ja];
    this.baseUrl = 'https://cinejoy.pk';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Detect anime for metadata enrichment
    let isAnime = false;
    if (tmdbId.season) {
      try {
        const tmdbUrl = `https://api.themoviedb.org/3/tv/${tmdbId.id}?api_key=${TMDB_PRIMARY}`;
        const { gotScraping } = await import('got-scraping');
        const r = await gotScraping.get(tmdbUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
          timeout: { request: 8000 }, throwHttpErrors: false, http2: false,
        });
        if (r.statusCode === 200) {
          const data = JSON.parse(r.body);
          isAnime = data.original_language === 'ja' &&
            (data.genres || []).some(g => g.id === 16);
        }
      } catch { /* best effort */ }
    }

    // Load scraper module (cached)
    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    let streams;
    try {
      // Task 49: NO internal race (Task 48 fix6 pattern) — the old 25s race
      // fired null on cold starts (bundle parse + handshake can exceed 25s
      // under Render contention) and DISCARDED the eventual result, keeping
      // the 15min cache empty. Scraper internals are bounded (8s/12s/20s
      // stage timeouts), so the uncapped await settles on its own.
      // Task 60: ONE empty-retry when the first attempt came back fast (<8s)
      // — the cold-boot crush.wasm download window (2×12s under contention)
      // produced empty results that then poisoned this source's 10min cache
      // ("CineJoy missing on refresh"). Atlantic.js EMPTY_RETRY pattern.
      const t0 = Date.now();
      let out = await mod.getStreams(String(tmdbId.id), mediaType, tmdbId.season || null, tmdbId.episode || null);
      if (Array.isArray(out) && out.length === 0 && Date.now() - t0 < 8000) {
        await new Promise(r => setTimeout(r, 1500));
        out = await mod.getStreams(String(tmdbId.id), mediaType, tmdbId.season || null, tmdbId.episode || null);
      }
      streams = out;
    } catch (e) {
      console.error(`[cinejoy-aio] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    // Convert scraper streams to our format — unwrap wrapped proxy URLs
    // and set Referer for NuvioExtractor routing
    const results = [];
    for (const s of streams) {
      if (!s || !s.url) continue;

      // Skip iframe streams (cinejoy.to embed pages) — they don't play in Stremio
      if (s.type === 'iframe' || s.behaviorHints?.notWebVideo) continue;

      // Unwrap the site's proxy wrapper to get original URL + Referer
      const { url: rawUrl, referer } = unwrapSiteProxy(s.url);
      if (!rawUrl || !rawUrl.startsWith('http')) continue;

      const height = parseHeight(s.quality);
      const isHls = s.type === 'application/vnd.apple.mpegurl' || rawUrl.includes('.m3u8');
      const serverName = s.name?.split(' - ')[1]?.split(' ')[0] || 'CineJoy';

      // Build enriched title with metadata markers
      let markers = [];
      if (s.quality) markers.push(s.quality);
      markers.push('WEB-DL');
      if (height === 2160) { markers.push('HEVC'); markers.push('HDR'); }
      else markers.push('x264');
      if (isAnime) markers.push('Japanese');
      else markers.push('English');

      const displayTitle = `${title} [${serverName}] ${markers.join(' ')}`;

      results.push({
        url: new URL(rawUrl),
        format: isHls ? Format.hls : Format.mp4,
        meta: {
          countryCodes: isAnime
            ? [CountryCode.multi, CountryCode.ja]
            : [CountryCode.multi, CountryCode.en],
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          ...(height && { height }),
          sourceType: 'WebDL',
          nuvioProvider: true,
          nuvioReferer: referer,
          ...(isHls && { nuvioForceHls: true }),
        },
      });
    }

    // Deduplicate by URL
    const seen = new Set();
    const deduped = results.filter(r => {
      const key = r.url.href;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Use buildStreamResults to convert to Source result format
    return buildStreamResults({
      streams: deduped.map(r => ({
        url: r.url.href,
        quality: r.meta.height ? r.meta.height + 'p' : '1080p',
        title: r.meta.title,
        name: this.label + ' - ' + (r.meta.title.match(/\[(\w+)\]/)?.[1] || 'Stream'),
        headers: { Referer: r.meta.nuvioReferer },
      })),
      title,
      sourceId: this.id,
      sourceLabel: this.label,
      countryCodes: isAnime
        ? [CountryCode.multi, CountryCode.ja]
        : [CountryCode.multi, CountryCode.en],
      ctx,
    });
  }
}
