// src/source/Peckle.js
// 2peckle / ShowBox — movies/series via ShowBox → FebBox with cookie
//
// Architecture:
//   1. TMDB → ShowBox ID via id-mapping-api-showbox-proxy.hf.space
//   2. ShowBox ID → FebBox share code via showbox.media/index/share_link
//   3. List files in FebBox share (anonymous) — non-recursive (top-level only)
//   4. For each video file, fetch video_quality_list with FEBBOX_COOKIE
//      → returns HLS URLs (ORG/4K/1080p/720p/360p) from hls.shegu.net
//
// REQUIRES: FEBBOX_COOKIE env var (FebBox JWT cookie)
// Without cookie: returns 0 streams (can't resolve download URLs)
//
// Stream URL patterns:
//   ORG:  https://usa7-as05.shegu.net/vip/.../movie.mkv?KEY1=... (direct MKV)
//   HLS:  https://hls.shegu.net/{id}.m3u8?sign=...&t=... (transcoded HLS)
//
// HLS URLs play directly without Referer. ORG (MKV) may need cookie.

import * as cheerio from 'cheerio';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const SHOWBOX_BASE = 'https://showbox.media';
const FEBBOX_BASE = 'https://www.febbox.com';
const PROXY_BASE = 'https://id-mapping-api-showbox-proxy.hf.space/api/media';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

// Load FebBox cookie from env — check multiple possible env var names
function getCookie() {
  const raw = process.env.FEBBOX_COOKIES || process.env.FEBBOX_COOKIE ||
              process.env.FEBBOX_API_KEY || process.env.FEBBOX_JWT || '';
  const jwt = raw.split(',').map(c => c.trim()).filter(Boolean)[0];
  return jwt ? (jwt.startsWith('ui=') ? jwt : `ui=${jwt}`) : null;
}

// Parse size string to bytes
function parseSize(s) {
  if (!s) return undefined;
  const m = String(s).match(/([\d.]+)\s*(GB|MB)/i);
  if (!m) return undefined;
  const val = parseFloat(m[1]);
  return m[2].toUpperCase() === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
}

// Parse quality string to height
function parseHeight(q) {
  if (!q) return undefined;
  const ql = String(q).toLowerCase();
  if (ql.includes('org')) return undefined;
  if (ql.includes('4k') || ql.includes('2160')) return 2160;
  if (ql.includes('1080')) return 1080;
  if (ql.includes('720')) return 720;
  if (ql.includes('480')) return 480;
  if (ql.includes('360')) return 360;
  return undefined;
}

const VIDEO_EXT = /\.(mkv|mp4|m4v|mov|avi|ts|webm)$/i;

// Match episode by SxxExx pattern
function matchEpisode(name, wantSeason, wantEpisode) {
  const m = name.match(/[._\s-]s(\d{1,2})e(\d{1,3})[._\s-]/i);
  if (!m) return null;
  const s = parseInt(m[1]), e = parseInt(m[2]);
  if (wantSeason != null && s !== wantSeason) return null;
  if (wantEpisode != null && e !== wantEpisode) return null;
  return true;
}

// Fetch JSON from ShowBox proxy
async function fetchProxy(tmdbId, mediaType, season, episode) {
  let url;
  if (mediaType === 'tv' && season && episode) {
    url = `${PROXY_BASE}/tv/${tmdbId}/${season}/${episode}`;
  } else {
    url = `${PROXY_BASE}/movie/${tmdbId}`;
  }
  try {
    const res = await gotScraping.get(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      timeout: { request: 10000 }, throwHttpErrors: false,
    });
    if (res.statusCode !== 200) return null;
    return JSON.parse(res.body);
  } catch { return null; }
}

// Get share code from ShowBox
async function getShareCode(showboxId, type) {
  try {
    const url = new URL(`${SHOWBOX_BASE}/index/share_link`);
    url.searchParams.set('id', showboxId);
    url.searchParams.set('type', type);
    const res = await gotScraping.get(url.href, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'User-Agent': UA, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Referer': `${SHOWBOX_BASE}/` },
      timeout: { request: 8000 }, throwHttpErrors: false,
    });
    if (res.statusCode !== 200) return null;
    const data = JSON.parse(res.body);
    if (data.code !== 1 || !data.data?.link) return null;
    const link = data.data.link.replace(/\/$/, '');
    return { code: link.split('/').pop(), link };
  } catch { return null; }
}

// List files in FebBox share (anonymous) — non-recursive, returns all files
// including those in subdirectories by fetching with parent_id if needed.
async function listShareFiles(shareCode, parentId) {
  try {
    const url = new URL(`${FEBBOX_BASE}/file/file_share_list`);
    url.searchParams.set('share_key', shareCode);
    if (parentId) url.searchParams.set('parent_id', parentId);
    const res = await gotScraping.get(url.href, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'User-Agent': UA, 'Accept': 'application/json', 'Referer': `${FEBBOX_BASE}/share/${shareCode}` },
      timeout: { request: 10000 }, throwHttpErrors: false,
    });
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    if (data.code !== 1) return [];
    return data.data?.file_list || [];
  } catch { return []; }
}

// Walk share — fetch top-level, then recursively fetch subdirs in parallel
// (bounded to 3 concurrent dir fetches to avoid overwhelming FebBox)
async function walkShare(shareCode) {
  const topItems = await listShareFiles(shareCode);
  const files = [];
  const dirs = [];

  for (const it of topItems) {
    if (it.is_dir === 1 || it.is_dir === '1') {
      dirs.push(it);
    } else {
      files.push(it);
    }
  }

  // Fetch subdirs in parallel (max 3 at a time)
  const dirResults = await Promise.all(
    dirs.slice(0, 5).map(d => listShareFiles(shareCode, d.fid))
  );
  for (const subItems of dirResults) {
    for (const it of subItems) {
      if (it.is_dir !== 1 && it.is_dir !== '1') {
        files.push(it);
      }
      // Don't recurse deeper — 2 levels is enough for most shares
    }
  }

  return files;
}

// Fetch video qualities (HLS URLs) using cookie
async function getVideoQualities(shareCode, fid, cookieHeader) {
  try {
    const url = new URL(`${FEBBOX_BASE}/console/video_quality_list`);
    url.searchParams.set('fid', fid);
    url.searchParams.set('share_key', shareCode);
    const res = await gotScraping.get(url.href, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'User-Agent': UA, 'Accept': 'application/json', 'Cookie': cookieHeader, 'Referer': `${FEBBOX_BASE}/share/${shareCode}` },
      timeout: { request: 8000 }, throwHttpErrors: false,
    });
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    if (data.code !== 1 || !data.html) return [];
    const $ = cheerio.load(data.html);
    const qualities = [];
    $('div.file_quality').each((_, el) => {
      qualities.push({
        url: $(el).attr('data-url'),
        quality: $(el).attr('data-quality'),
        size: $(el).find('.size').text().trim(),
      });
    });
    return qualities;
  } catch { return []; }
}

export class Peckle extends Source {
  constructor(fetcher) {
    super();
    this.id = 'peckle';
    this.label = '2Peckle';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = SHOWBOX_BASE;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const cookieHeader = getCookie();
    if (!cookieHeader) return [];

    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const mediaType = tmdbId.season ? 'tv' : 'movie';
    const titleBase = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: TMDB → ShowBox ID (fetch in parallel with name lookup)
    const proxyData = await fetchProxy(tmdbId.id, mediaType, tmdbId.season, tmdbId.episode);
    if (!proxyData?.success || !proxyData.id) return [];
    const showboxId = proxyData.id;

    // Step 2: ShowBox ID → FebBox share code
    let sc = await getShareCode(showboxId, mediaType === 'tv' ? 2 : 1);
    if (!sc) sc = await getShareCode(showboxId, 1);
    if (!sc) return [];

    // Step 3: Walk share files (non-recursive + 1 level deep in parallel)
    const allFiles = await walkShare(sc.code);
    const videoFiles = allFiles.filter(f => VIDEO_EXT.test(f.file_name || ''));

    // For TV: filter by SxxExx
    let targetFiles = videoFiles;
    if (mediaType === 'tv' && tmdbId.season) {
      targetFiles = videoFiles.filter(f => matchEpisode(f.file_name, tmdbId.season, tmdbId.episode));
      if (targetFiles.length === 0) targetFiles = videoFiles;
    }

    if (targetFiles.length === 0) return [];

    // Step 4: Fetch video qualities for each file in parallel (max 3)
    const fileQualities = await Promise.all(
      targetFiles.slice(0, 5).map(f => getVideoQualities(sc.code, f.fid, cookieHeader))
    );

    const results = [];
    const seenUrls = new Set();

    for (let i = 0; i < targetFiles.length && i < 5; i++) {
      const file = targetFiles[i];
      const qualities = fileQualities[i] || [];
      const fileName = file.file_name || '';

      for (const q of qualities) {
        if (!q.url || seenUrls.has(q.url)) continue;
        seenUrls.add(q.url);

        let parsed;
        try { parsed = new URL(q.url); } catch { continue; }

        const height = parseHeight(q.quality);
        const bytes = parseSize(q.size);
        const isOrg = q.quality === 'ORG';
        const format = isOrg ? Format.mp4 : Format.hls;

        // Parse metadata from filename
        let codec;
        if (/hevc|x265|h\.?265/i.test(fileName)) codec = 'HEVC';
        else if (/x264|h264|avc/i.test(fileName)) codec = 'AVC';

        let sourceType;
        if (/remux/i.test(fileName)) sourceType = 'BluRay Remux';
        else if (/bluRay|bluray|bdrip/i.test(fileName)) sourceType = 'BluRay';
        else if (/web\s*dl|web-dl|webdl/i.test(fileName)) sourceType = 'WebDL';
        else if (/web\s*rip|webrip/i.test(fileName)) sourceType = 'WebRip';
        else if (/hd\s*rip|hdrip/i.test(fileName)) sourceType = 'HDRip';

        let hdr;
        if (/dolby\s*vision|\bdv\b/i.test(fileName)) hdr = 'Dolby Vision';
        else if (/hdr10\+/i.test(fileName)) hdr = 'HDR10+';
        else if (/\bhdr\b/i.test(fileName)) hdr = 'HDR';

        let bitDepth;
        if (/10\s*bit|10bit|10-bit/i.test(fileName)) bitDepth = '10-bit';

        let audioCodec;
        if (/truehd/i.test(fileName)) audioCodec = 'TrueHD';
        else if (/atmos/i.test(fileName)) audioCodec = 'Atmos';
        else if (/dd\+|ddp|eac3/i.test(fileName)) audioCodec = 'DD+';
        else if (/\bdd\b|\bac3\b/i.test(fileName)) audioCodec = 'DD';
        else if (/\bdts\b/i.test(fileName)) audioCodec = 'DTS';

        const countryCodes = new Set([CountryCode.multi]);
        if (/\bhindi\b|\bhin\b/i.test(fileName)) countryCodes.add('hi');
        if (/\benglish\b|\beng\b/i.test(fileName)) countryCodes.add('en');
        if (/\bjapanese\b|\bjpn\b/i.test(fileName)) countryCodes.add('ja');
        if (/\bkorean\b|\bkor\b/i.test(fileName)) countryCodes.add('ko');
        if (/\btamil\b|\btam\b/i.test(fileName)) countryCodes.add('ta');
        if (/\btelugu\b|\btel\b/i.test(fileName)) countryCodes.add('te');

        const qualityLabel = isOrg ? 'Original' : (q.quality || 'HD');

        results.push({
          url: parsed,
          format,
          meta: {
            countryCodes: [...countryCodes],
            title: `${titleBase} (2Peckle ${qualityLabel})`,
            sourceId: this.id,
            sourceLabel: this.label,
            ...(height && { height }),
            ...(bytes && { bytes }),
            ...(codec && { codec }),
            ...(sourceType && { sourceType }),
            ...(hdr && { hdr }),
            ...(bitDepth && { bitDepth }),
            ...(audioCodec && { audioCodec }),
          },
        });
      }
    }

    return results;
  }
}
