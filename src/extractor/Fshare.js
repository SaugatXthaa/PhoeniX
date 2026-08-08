// src/extractor/Fshare.js
// FshareTV extractor — 3-step fetch chain to extract direct stream URLs.
//
// Flow:
//   1. GET /movie/{imdbId}        → find /w/{watchPath} link in HTML
//   2. GET /w/{watchPath}         → extract source_id via multiple regex patterns
//   3. GET /api/file/{sourceId}/source → JSON with stream_urls
//
// Movies only.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

const BASE_URL = 'https://fsharetv.cc';
const TRAILER = 'Png81APqcxU';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: BASE_URL,
};

const API_HEADERS = {
  ...HEADERS,
  Accept: 'application/json, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
};

const SOURCE_ID_PATTERNS = [
  /Movie\.setSource\("([^"]+)"/,
  /setSource\("([^"]+)"/,
  /setSource\('([^']+)'/,
  /"source_id"\s*:\s*"([^"]+)"/,
  /source_id\s*=\s*"([^"]+)"/,
  /file_id\s*=\s*"([^"]+)"/,
  /"file_id"\s*:\s*"([^"]+)"/,
];

function inferFormat(url) {
  const clean = url.toLowerCase().split('?')[0];
  if (clean.endsWith('.m3u8')) return Format.hls;
  if (clean.endsWith('.mp4')) return Format.mp4;
  if (clean.endsWith('.mkv')) return Format.mp4;
  if (clean.endsWith('.webm')) return Format.mp4;
  // Fshare /api/media/{hash} URLs serve direct MP4/MKV files (verified
  // via Content-Type: video/mp4). Default to mp4 so Stremio plays them
  // directly instead of trying HLS parsing.
  return Format.mp4;
}

function qualityToHeight(quality) {
  if (!quality) return 0;
  const q = String(quality).toLowerCase();
  const numMatch = q.match(/(\d{3,4})/);
  return numMatch ? parseInt(numMatch[1], 10) : 0;
}

export class Fshare extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'fshare';
    this.label = 'FshareTV';
    this.ttl = 3600000; // 1h
  }

  supports(_ctx, url) {
    return url.host === 'fsharetv.cc' || url.host.endsWith('.fsharetv.cc');
  }

  async extractInternal(ctx, url, meta) {
    // Step 1: fetch /movie/{imdbId} page, find /w/{watchPath}
    const watchPageHtml = await this.fetcher.text(ctx, url, { headers: HEADERS });
    const watchPathMatch = watchPageHtml.match(/href="(\/w\/[^"]+)"/);
    if (!watchPathMatch) {
      this.logger.warn('Fshare: no /w/ link found on movie page');
      return [];
    }
    const watchPath = watchPathMatch[1];

    // Step 2: fetch /w/{watchPath}, extract source_id
    const watchUrl = new URL(watchPath, BASE_URL);
    const watchHtml = await this.fetcher.text(ctx, watchUrl, { headers: HEADERS });

    let sourceId = null;
    for (const pattern of SOURCE_ID_PATTERNS) {
      const m = watchHtml.match(pattern);
      if (m) { sourceId = m[1]; break; }
    }
    if (!sourceId) {
      this.logger.warn('Fshare: source_id not found in /w/ page');
      return [];
    }

    // Step 3: fetch /api/file/{sourceId}/source
    const apiUrl = new URL(`/api/file/${sourceId}/source?trailer=${TRAILER}&type=watch`, BASE_URL);
    let json;
    try {
      json = await this.fetcher.json(ctx, apiUrl, { headers: { ...API_HEADERS, Referer: `${BASE_URL}/` } });
    } catch (e) {
      this.logger.warn(`Fshare API fetch failed: ${e?.constructor?.name}: ${e?.message || e}`);
      return [];
    }

    if (!json || json.status !== 'ok' || !json.data?.file) {
      this.logger.warn(`Fshare API non-ok status: ${json?.status}`);
      return [];
    }

    const file = json.data.file;
    const allSources = [
      ...(file.sources || []),
      ...(file.backups || []),
      ...((file.alternatives || []).flat()),
    ];

    // Dedupe by src
    const seen = new Set();
    const unique = [];
    for (const s of allSources) {
      if (!s?.src || seen.has(s.src)) continue;
      seen.add(s.src);
      unique.push(s);
    }

    // Sort by quality desc (numeric)
    unique.sort((a, b) => (Number(b.quality) || 0) - (Number(a.quality) || 0));

    const results = [];
    for (const s of unique) {
      const rawUrl = s.src.startsWith('http') ? s.src : `${BASE_URL}${s.src}`;
      let parsed;
      try { parsed = new URL(rawUrl); } catch { continue; }
      if (!parsed) continue;

      const height = qualityToHeight(s.label || s.quality);
      results.push({
        url: parsed,
        format: inferFormat(rawUrl),
        label: this.label,
        meta: {
          ...meta,
          ...(height && { height }),
          title: s.label || meta.title,
        },
        requestHeaders: { Referer: `${BASE_URL}/` },
      });
    }

    return results;
  }
}
