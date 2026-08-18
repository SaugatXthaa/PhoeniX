// src/source/FourKHDHubOne.js
// 4khdhub.one — movies & TV series with direct playable CDN streams (up to 4K)
//
// Separate from the existing FourKHDHub.js source (which uses 4khdhub.link).
// This source resolves hubdrive.tips URLs itself (bypasses HubExtractor
// to avoid cache conflicts with the existing 4KHDHub source).

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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Resolve hubdrive.tips URL to direct playable CDN URL using the Fetcher
// (which handles cookies and redirects properly).
// Chain: hubdrive.tips → hubcloud.cx → pixel.hubcloud.cx → workers.dev
async function resolveHubdrive(fetcher, ctx, url) {
  try {
    // Step 1: Fetch hubdrive.tips page
    const html1 = await fetcher.text(ctx, url, { headers: { 'User-Agent': UA } });
    // Find hubcloud link
    const hubcloudMatch = html1.match(/https:\/\/hubcloud\.[a-z]+\/drive\/[a-zA-Z0-9_]+/);
    if (!hubcloudMatch) return null;

    // Step 2: Fetch hubcloud.cx page
    const html2 = await fetcher.text(ctx, new URL(hubcloudMatch[0]), {
      headers: { 'User-Agent': UA, 'Referer': 'https://hubdrive.tips/' }
    });

    // Find pixel.hubcloud.cx URL
    const pixelMatch = html2.match(/https:\/\/pixel\.hubcloud\.cx\/\?id=[^"'\s<>]+/);
    if (pixelMatch) {
      // Follow pixel.hubcloud.cx redirect to get workers.dev URL
      const res = await fetch(pixelMatch[0], {
        headers: { 'Referer': 'https://hubcloud.cx/' },
        redirect: 'manual',
      });
      const location = res.headers.get('location');
      if (location) return location;
    }

    // Try finding any workers.dev URL
    const workersMatch = html2.match(/https:\/\/[a-z0-9-]+\.workers\.dev\/[a-zA-Z0-9_/-]+/);
    if (workersMatch) return workersMatch[0];

    return null;
  } catch (e) {
    console.error(`[4khdhubone] resolveHubdrive error: ${e.message}`);
    return null;
  }
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
    this.ttl = 30 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Load the scraper module
    let mod;
    try {
      delete require_.cache[require_.resolve(PROVIDER_PATH)];
      mod = require_(PROVIDER_PATH);
    } catch (e) {
      console.error(`[4khdhubone] failed to load scraper: ${e?.message || e}`);
      return [];
    }
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

    // Resolve hubdrive.tips URLs to direct CDN URLs using the Fetcher
    // (bypasses HubExtractor to avoid cache conflicts with existing 4KHDHub source)
    const resolved = await Promise.all(streams.map(async (s) => {
      if (!s.url || !s.url.includes('hubdrive.tips')) return s;
      const directUrl = await resolveHubdrive(this.fetcher, ctx, new URL(s.url));
      if (!directUrl) return null;
      return { ...s, resolvedUrl: directUrl };
    }));

    const valid = resolved.filter(r => r !== null);
    console.log(`[4khdhubone] Resolved ${valid.length}/${streams.length} URLs`);

    const results = [];
    const seenUrls = new Set();

    for (const s of valid) {
      const urlStr = s.resolvedUrl || s.url;
      if (seenUrls.has(urlStr)) continue;
      seenUrls.add(urlStr);

      let url;
      try { url = new URL(urlStr); } catch { continue; }

      const height = parseHeight(s.quality);
      const fileSize = parseSize(s.size);
      const sourceType = detectSourceType(s.quality + ' ' + s.name);
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
