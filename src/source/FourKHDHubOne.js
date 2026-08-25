// src/source/FourKHDHubOne.js
// 4khdhub.one — movies & TV series with HubCloud/HubDrive download links (up to 4K)
//
// Separate from the existing FourKHDHub.js source (which uses 4khdhub.link).
// This source uses 4khdhub.one which has a different site structure.
//
// Flow:
//   1. Search via /?s={title} (HTML, no CF challenge)
//   2. Match by title + year (movies) or season (TV)
//   3. For movies: extract hubcloud.ist / hubdrive.tips links with quality
//   4. For series: filter by season+episode, extract links
//   5. HubExtractor resolves hubcloud/hubdrive → direct CDN URLs
//
// Enriched metadata (like 4KHDHub):
//   - height: 480, 720, 1080, 2160 (from quality badge)
//   - sourceType: 'BluRay' or 'WebDL' (from quality text)
//   - bytes: file size (from badge)
//   - countryCodes: [multi, hi, en] (dual audio content)
//   - title: movie/show title with quality + host label

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import bytes from 'bytes';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', '4khdhub_one.cjs');
const HUB_EXTRACTOR_PATH = path.join(__dirname, '..', 'nuvio', 'hub_extractor.cjs');

// Cache the scraper module
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try { _scraperMod = require_(PROVIDER_PATH); }
  catch (e) { console.error(`[4khdhubone] failed to load scraper: ${e?.message || e}`); }
  return _scraperMod;
}

// Cache the hub_extractor (CommonJS — resolves hubcloud → googleusercontent)
let _hubExt = null;
function getHubExtractor() {
  if (_hubExt) return _hubExt;
  try { _hubExt = require_(HUB_EXTRACTOR_PATH); }
  catch (e) { console.error(`[4khdhubone] failed to load hub_extractor: ${e?.message || e}`); }
  return _hubExt;
}

function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('2160') || s.includes('4k') || s.includes('uhd')) return 2160;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : undefined;
}

function parseSize(size) {
  if (!size || typeof size !== 'string') return undefined;
  try { return bytes.parse(size) || undefined; } catch { return undefined; }
}

function detectSourceType(text) {
  const lower = (text || '').toLowerCase();
  if (lower.includes('bluray') || lower.includes('remux') || lower.includes('bdrip')) return 'BluRay Remux';
  if (lower.includes('web-dl') || lower.includes('webdl') || lower.includes('webrip')) return 'WebDL';
  return 'BluRay';
}

export class FourKHDHubOne extends Source {
  constructor(fetcher) {
    super();
    this.id = 'fourkhdhubone';
    this.label = '4KHDHub.one';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://4khdhub.one';
    this.fetcher = fetcher;
    this.ttl = 30 * 60 * 1000; // 30min
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
        mod.getStreams(tmdbId.id, mediaType, tmdbId.season, tmdbId.episode),
        new Promise(r => setTimeout(() => r(null), 28000)),
      ]);
    } catch (e) {
      console.error(`[4khdhubone] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    const results = [];
    const seenUrls = new Set();

    // Resolve hubcloud URLs to direct googleusercontent (10Gbps) URLs.
    // This bypasses the ESM HubExtractor→HubCloud→StreamResolver pipeline
    // which filters out pixel.hubcloud.cx / gpdl.hubcloud.cx (the 10Gbps
    // CDN redirect URLs). hub_extractor.resolveHubcloudUrl() follows the
    // full chain and returns the direct googleusercontent.com URL.
    const hubExt = getHubExtractor();
    if (!hubExt) return [];

    for (const s of streams) {
      if (!s || !s.url || typeof s.url !== 'string') continue;
      if (!s.url.startsWith('http')) continue;
      if (seenUrls.has(s.url)) continue;

      // Resolve hubcloud → googleusercontent (the 10Gbps stream)
      let gdriveUrl;
      try {
        gdriveUrl = await hubExt.resolveHubcloudUrl(s.url);
      } catch { continue; }
      if (!gdriveUrl) continue;
      seenUrls.add(s.url);

      let url;
      try { url = new URL(gdriveUrl); } catch { continue; }

      const height = parseHeight(s.quality);
      const fileSize = parseSize(s.size);
      const sourceType = detectSourceType(s.quality + ' ' + s.name);

      // Build display title like 4KHDHub format
      const qualityLabel = s.quality || (height ? `${height}p` : 'Download');
      const sizeLabel = s.size ? ` [${s.size}]` : '';
      const hostLabel = s.host || s.text?.replace('Download ', '') || '';
      const displayTitle = `${title} (4KHDHub.one ${qualityLabel} ${hostLabel})${sizeLabel}`;

      results.push({
        url,
        format: Format.mp4,
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          ...(height && { height }),
          sourceType,
          ...(fileSize && { bytes: fileSize }),
          ...(hostLabel && { subSource: hostLabel }),
        },
      });
    }

    return results;
  }
}
