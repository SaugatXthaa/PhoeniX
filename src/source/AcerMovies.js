// src/source/AcerMovies.js
// acermovies.fun — movies (direct GDrive CDN URLs)
//
// Flow:
//   1. POST https://api2.acermovies.fun/api/search  { searchQuery: title }
//      → { searchResult: [{ title, url, image }] }
//   2. POST https://api2.acermovies.fun/api/sourceQuality  { url }
//      → { sourceQualityList: [{ title, url, quality, episodesUrl, batchUrl }], meta }
//   3. For movie (url is non-empty): POST https://api2.acermovies.fun/api/sourceUrl  { url, seriesType: "movie" }
//      → { sourceUrl: "https://video-downloads.googleusercontent.com/..." }
//
// The final sourceUrl is a direct GDrive CDN MP4/MKV — same pattern as
// HubCloud's HubCDN streams. No extractor needed; the URL plays directly.
//
// Movies only. Series return episodesUrl which leads to a multi-stage
// redirect chain through cloud.unblockedgames.world (CF-protected blog
// with JS auto-submit) — not resolvable server-side without a browser.
//
// Search returns results from moviesmod.zone — Hindi/English dual audio
// focused, but covers Hollywood, Korean, and anime movies too.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const API_BASE = 'https://api2.acermovies.fun';
const ORIGIN = 'https://acermovies.fun';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Origin': ORIGIN,
  'Referer': `${ORIGIN}/`,
};

// Parse quality string ("480p", "720p", "1080p", "1080p 10Bit HEVC") → height
function parseHeight(quality) {
  if (!quality) return undefined;
  const m = String(quality).match(/(\d{3,4})p?/i);
  return m ? parseInt(m[1], 10) : undefined;
}

// Detect language flags from title (e.g. "Dual Audio (Hindi-English)" → hi, en)
function countryCodesFromTitle(title) {
  if (!title) return [CountryCode.multi];
  const t = String(title).toLowerCase();
  const codes = new Set();
  if (t.includes('hindi') || t.includes('hin')) codes.add(CountryCode.hi);
  if (t.includes('english') || t.includes('eng')) codes.add(CountryCode.en);
  if (t.includes('tamil') || t.includes('tam')) codes.add(CountryCode.ta);
  if (t.includes('telugu') || t.includes('tel')) codes.add(CountryCode.te);
  if (t.includes('korean') || t.includes('kor')) codes.add(CountryCode.ko);
  if (t.includes('japanese') || t.includes('jpn') || t.includes('anime')) codes.add(CountryCode.ja);
  if (t.includes('chinese') || t.includes('chi')) codes.add(CountryCode.zh);
  if (codes.size === 0) codes.add(CountryCode.multi);
  return [...codes];
}

export class AcerMovies extends Source {
  constructor(fetcher) {
    super();
    this.id = 'acermovies';
    this.label = 'AcerMovies';
    this.contentTypes = ['movie'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = ORIGIN;
    this.fetcher = fetcher;
    this.ttl = 3600000; // 1h — sourceUrl is short-lived but Stremio caches the resolved URL
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Series not supported — episodes go through CF-protected blog chain
    if (tmdbId.season) return [];

    // Step 1: search by name (+ year for disambiguation)
    const searchQuery = year ? `${name} ${year}` : name;
    const searchUrl = new URL('/api/search', API_BASE);
    let searchJson;
    try {
      searchJson = await this.fetcher.textPost(ctx, searchUrl, JSON.stringify({ searchQuery }), { headers: HEADERS });
    } catch { return []; }

    let searchResult;
    try { searchResult = JSON.parse(searchJson); } catch { return []; }
    const searchResults = Array.isArray(searchResult?.searchResult) ? searchResult.searchResult : [];
    if (searchResults.length === 0) return [];

    // Find best match — prefer one whose title contains the name (case-insensitive)
    const nameLower = name.toLowerCase();
    let bestMatch = searchResults.find(r => r.title?.toLowerCase().includes(nameLower));
    if (!bestMatch) bestMatch = searchResults[0];
    if (!bestMatch?.url) return [];

    // Step 2: get quality options for the matched movie
    const qualityUrl = new URL('/api/sourceQuality', API_BASE);
    let qualityJson;
    try {
      qualityJson = await this.fetcher.textPost(ctx, qualityUrl, JSON.stringify({ url: bestMatch.url }), { headers: HEADERS });
    } catch { return []; }

    let qualityResult;
    try { qualityResult = JSON.parse(qualityJson); } catch { return []; }
    const qualityList = Array.isArray(qualityResult?.sourceQualityList) ? qualityResult.sourceQualityList : [];

    // Filter to movie entries (url is non-empty; series entries only have episodesUrl)
    const movieQualities = qualityList.filter(q => q?.url && !q.episodesUrl);
    if (movieQualities.length === 0) return [];

    // Step 3: resolve each quality to a direct GDrive URL (in parallel, bounded)
    // Deduplicate by quality string to avoid redundant calls
    const seenQualities = new Set();
    const uniqueQualities = movieQualities.filter(q => {
      const key = q.quality || q.title;
      if (seenQualities.has(key)) return false;
      seenQualities.add(key);
      return true;
    });

    const results = [];
    const resolveOne = async (q) => {
      try {
        const srcUrl = new URL('/api/sourceUrl', API_BASE);
        const body = JSON.stringify({ url: q.url, seriesType: 'movie' });
        const resp = await this.fetcher.textPost(ctx, srcUrl, body, { headers: HEADERS, timeout: 15000 });
        const parsed = JSON.parse(resp);
        const directUrl = parsed?.sourceUrl;
        if (!directUrl) return null;
        let parsedUrl;
        try { parsedUrl = new URL(directUrl); } catch { return null; }
        if (!parsedUrl) return null;

        const height = parseHeight(q.quality);
        const countryCodes = countryCodesFromTitle(q.title);

        return {
          url: parsedUrl,
          format: Format.mp4, // GDrive CDN serves MP4/MKV directly — Stremio plays both as mp4
          meta: {
            countryCodes,
            ...(height && { height }),
            title: `${title} (${q.quality || 'MP4'})`,
            sourceId: this.id,
            sourceLabel: this.label,
          },
        };
      } catch { return null; }
    };

    // Resolve in parallel — Promise.all with bounded concurrency
    const resolved = await Promise.all(uniqueQualities.map(resolveOne));
    for (const r of resolved) {
      if (r) results.push(r);
    }

    return results;
  }
}
