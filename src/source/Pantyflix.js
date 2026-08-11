// src/source/Pantyflix.js
// pantyflix.org — movies/series/anime with direct download streams
//
// Pantyflix is a Next.js frontend that aggregates download links from
// Bollyflix, UHDMovies, AnimeShrine, etc. via /api/streamrip/download.
//
// API flow (verified live):
//   1. GET https://pantyflix.org/api/streamrip/download?type={movie|tv}&id={tmdbId}
//        For TV: &season={s}&episode={e}
//   2. Response: { ok, title, type, season, episode, downloads: [{ quality, source, server, size, url }] }
//   3. If url contains 'fastdlserver', resolve the redirect chain:
//      curl fastdlserver → gdflix page → /cflare/ link → cloud-dl workers.dev direct URL
//      (got-scraping can't bypass CF on gdflix.io, so we use system curl)
//   4. Direct URLs (cloud-dl workers.dev, dl.animeshrine.xyz) play in Stremio
//
// The fastdlserver resolution uses execSync('curl ...') because got-scraping
// gets 404 on fastdlserver URLs — curl has a different TLS fingerprint that
// bypasses the block.

import { execSync } from 'child_process';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const BASE = 'https://pantyflix.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

function apiHeaders() {
  return {
    ...hg.getHeaders({ httpVersion: '2' }),
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Referer': `${BASE}/`,
    'Origin': BASE,
  };
}

// Parse size string ("31.4GB", "550MB") to bytes
function parseSize(sizeStr) {
  if (!sizeStr) return undefined;
  const m = String(sizeStr).match(/([\d.]+)\s*(GB|MB)/i);
  if (!m) return undefined;
  const val = parseFloat(m[1]);
  return m[2].toUpperCase() === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
}

// Parse quality ("2160", "1080", "720", "480") to height
function parseHeight(quality) {
  if (!quality) return undefined;
  const q = String(quality);
  if (q.includes('2160') || q.toLowerCase().includes('4k')) return 2160;
  if (q.includes('1080')) return 1080;
  if (q.includes('720')) return 720;
  if (q.includes('480')) return 480;
  if (q.includes('360')) return 360;
  const m = q.match(/(\d{3,4})/);
  return m ? parseInt(m[1]) : undefined;
}

// Infer audio languages from source/server name
function inferCountryCodes(name) {
  const n = (name || '').toLowerCase();
  const codes = new Set();
  if (n.includes('hindi') || n.includes('bolly')) { codes.add('hi'); codes.add('en'); }
  if (n.includes('english')) codes.add('en');
  if (n.includes('dual')) { codes.add('hi'); codes.add('en'); }
  if (n.includes('japanese') || n.includes('anime')) codes.add('ja');
  if (n.includes('korean')) codes.add('ko');
  if (n.includes('tamil')) codes.add('ta');
  if (n.includes('telugu')) codes.add('te');
  if (codes.size === 0) codes.add('multi');
  return [...codes];
}

// Resolve fastdlserver URL to direct playable URL using system curl.
// Chain: fastdlserver → gdflix page → /cflare/ → cloud-dl workers.dev
function resolveFastDlServer(url) {
  try {
    const html = execSync(
      `curl -sS -L --max-time 10 -A "${UA}" -H "Referer: ${BASE}/" "${url}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 12000 }
    );

    // Extract /cflare/ link
    const cflareMatch = html.match(/href="(\/cflare\/[^"]+)"/);
    if (!cflareMatch) {
      // Try direct cloud-dl URL
      const directMatch = html.match(/https:\/\/cloud-dl[^"'\s<>]+/i);
      if (directMatch) return directMatch[0];
      return null;
    }

    // Fetch cflare page
    const cflareUrl = `https://new3.gdflix.io${cflareMatch[1]}`;
    const html2 = execSync(
      `curl -sS -L --max-time 10 -A "${UA}" -H "Referer: https://new3.gdflix.io/" "${cflareUrl}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 12000 }
    );

    // Extract direct URL (cloud-dl workers.dev or busycdn)
    const cloudDlMatch = html2.match(/https:\/\/cloud-dl[^"'\s<>]+/i);
    if (cloudDlMatch) return cloudDlMatch[0];

    const busyCdnMatch = html2.match(/https:\/\/instant\.busycdn\.xyz[^"'\s<>]+/i);
    if (busyCdnMatch) return busyCdnMatch[0];

    return null;
  } catch {
    return null;
  }
}

export class Pantyflix extends Source {
  constructor(fetcher) {
    super();
    this.id = 'pantyflix';
    this.label = 'Pantyflix';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = BASE;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const mediaType = tmdbId.season ? 'tv' : 'movie';
    const titleBase = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Call /api/streamrip/download
    const apiUrl = new URL(`${BASE}/api/streamrip/download`);
    apiUrl.searchParams.set('type', mediaType);
    apiUrl.searchParams.set('id', String(tmdbId.id));
    if (mediaType === 'tv') {
      apiUrl.searchParams.set('season', String(tmdbId.season || 1));
      apiUrl.searchParams.set('episode', String(tmdbId.episode || 1));
    }

    const res = await gotScraping.get(apiUrl.href, {
      headers: apiHeaders(),
      timeout: { request: 15000 },
      throwHttpErrors: false,
      http2: true,
    });
    if (res.statusCode !== 200) return [];

    let data;
    try { data = JSON.parse(res.body); } catch { return []; }
    if (!data.ok || !Array.isArray(data.downloads)) return [];

    // Step 2: Resolve all download URLs in parallel (bounded concurrency)
    const results = [];
    const seenUrls = new Set();

    const resolveOne = async (d) => {
      if (!d.url) return null;
      let directUrl = d.url;

      // If it's a fastdlserver URL, resolve via curl.
      // If resolution fails, skip this stream — fastdlserver URLs don't play
      // directly in Stremio (they need the curl redirect chain).
      if (d.url.includes('fastdlserver')) {
        const resolved = resolveFastDlServer(d.url);
        if (!resolved) return null; // Skip unresolved fastdlserver URLs
        directUrl = resolved;
      }

      // Dedup by URL
      if (seenUrls.has(directUrl)) return null;
      seenUrls.add(directUrl);

      let parsed;
      try { parsed = new URL(directUrl); } catch { return null; }

      // Use server name (has audio info like "Bollyflix [Hindi-English]") 
      // instead of source name (just "Bollyflix") for richer metadata
      const sourceName = d.server || d.source || 'Unknown';
      const height = parseHeight(d.quality);
      const bytes = parseSize(d.size);
      const countryCodes = inferCountryCodes(sourceName);

      return {
        url: parsed,
        format: Format.mp4,
        meta: {
          countryCodes,
          title: `${titleBase} (${sourceName} ${d.quality ? `${d.quality}p` : 'HD'})`,
          sourceId: this.id,
          sourceLabel: this.label,
          ...(height && { height }),
          ...(bytes && { bytes }),
        },
      };
    };

    // Resolve with bounded concurrency (3 at a time to avoid overwhelming curl)
    const bounded = async (items, limit, fn) => {
      const out = [];
      let idx = 0;
      const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
        while (idx < items.length) {
          const cur = idx++;
          try { out[cur] = await fn(items[cur]); }
          catch { out[cur] = null; }
        }
      });
      await Promise.all(workers);
      return out;
    };

    const resolved = await bounded(data.downloads, 3, resolveOne);
    for (const r of resolved) {
      if (r) results.push(r);
    }

    return results;
  }
}
