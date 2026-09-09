// src/source/Cinevood.js
// cinevood.love — movies/TV/anime with download links (up to 4K)
//
// Cinevood is a WordPress site (NexDrive/CineVood theme) that provides
// download links via mobilejsr.rest (file-host aggregator).
//
// Flow:
//   1. Search: GET /?s={title}
//   2. Parse results for /download-{slug}/ URLs
//   3. Fetch movie page → extract:
//      - <h3 class="mfx-quality-title"> → quality, codec, size, language
//      - <a class="mfx-download-link" href="https://mobilejsr.rest/genx{ID}/">
//   4. Return mobilejsr.rest URLs as external streams with enriched metadata
//
// The mobilejsr.rest URLs are download pages (not direct streams).
// They're returned as external URLs — Stremio opens them in browser
// where the user can access multiple file hosts (GDToT, HubCloud, etc.)
//
// ENRICHED METADATA (from quality titles):
//   - height: 480/720/1080/2160 (from title)
//   - codec: HEVC (x265) / x264 / H.264 (from title)
//   - sourceType: WEB-DL / BluRay / HDRip / HDTc (from title)
//   - audioLabel: Hindi / English / Dual Audio / Multi Audio (from title)
//   - fileSize: from title (e.g. [300MB], [12.7GB])

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { execFile } from 'child_process';

const BASE_URL = 'https://cinevood.love';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let _gotScraping = null;
async function getGot() {
  if (_gotScraping) return _gotScraping;
  try {
    const mod = await import('got-scraping');
    _gotScraping = mod.gotScraping;
  } catch (e) {
    console.error('[cinevood] Failed to load got-scraping:', e.message);
  }
  return _gotScraping;
}

// Cinevood.love is behind Cloudflare's "Just a moment..." challenge.
// Neither got-scraping nor native fetch can bypass it (both get 403).
// curl works because it sends a different TLS fingerprint. We use curl
// with a cookie jar to handle the CF challenge cookies.
const COOKIE_FILE = '/tmp/cinevood_cookies.txt';
function fetchViaCurl(url, referer) {
  return new Promise((resolve, reject) => {
    const args = [
      '-sSk', '--max-time', '20', '-L', '--compressed',
      '-c', COOKIE_FILE, '-b', COOKIE_FILE,
      '-A', UA,
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H', 'Accept-Language: en-US,en;q=0.5',
    ];
    if (referer) args.push('-H', `Referer: ${referer}`);
    args.push(url);
    execFile('curl', args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 25000,
      windowsHide: true,
    }, (err, stdout) => {
      if (err) { reject(new Error(`curl failed: ${err.message}`)); return; }
      resolve(stdout || '');
    });
  });
}

async function fetchText(url, referer) {
  // Try curl first — it bypasses Cloudflare on this site
  try {
    const body = await fetchViaCurl(url, referer);
    if (body && body.length > 50 && !body.includes('Just a moment')) {
      return body;
    }
  } catch (e) {
    console.log(`[cinevood] curl failed: ${e.message.slice(0, 60)}`);
  }
  // Fallback: got-scraping (Chrome TLS fingerprint)
  const got = await getGot();
  if (got) {
    try {
      const res = await got(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
        timeout: { request: 15000 },
        throwHttpErrors: false,
        followRedirect: true,
      });
      if (res.statusCode === 200 && res.body && !res.body.includes('Just a moment')) {
        return res.body;
      }
    } catch (e) {
      console.log(`[cinevood] got-scraping failed: ${e.message.slice(0, 60)}`);
    }
  }
  throw new Error(`HTTP 403 (Cloudflare challenge)`);
}

// Detect anime via TMDB genres + original language
async function isAnimeContent(fetcher, ctx, tmdbId) {
  try {
    const type = tmdbId.season ? 'tv' : 'movie';
    const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}`);
    url.searchParams.set('api_key', process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c');
    const data = await fetcher.json(ctx, url);
    if (!data) return false;
    const genres = data.genres || [];
    if (genres.some(g => g.id === 16)) return true;
    if (data.original_language === 'ja') return true;
    return false;
  } catch { return false; }
}

// Parse quality from title text
function parseQuality(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('2160') || t.includes('4k') || t.includes('uhd')) return 2160;
  if (t.includes('1080')) return 1080;
  if (t.includes('720')) return 720;
  if (t.includes('480')) return 480;
  if (t.includes('360')) return 360;
  return 1080;
}

function parseCodec(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('x265') || t.includes('h265') || t.includes('hevc') || t.includes('h.265')) return 'HEVC';
  if (t.includes('x264') || t.includes('h264') || t.includes('h.264') || t.includes('avc')) return 'x264';
  if (t.includes('av1')) return 'AV1';
  // 4K typically uses HEVC
  if (t.includes('2160') || t.includes('4k')) return 'HEVC';
  return 'x264';
}

function parseSourceType(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('remux')) return 'BluRay Remux';
  if (t.includes('bluray') || t.includes('bdrip') || t.includes('brrip') || t.includes('blu-ray')) return 'BluRay';
  if (t.includes('web-dl') || t.includes('webdl') || t.includes('web dl')) return 'WebDL';
  if (t.includes('webrip')) return 'WebRip';
  if (t.includes('hdtc')) return 'HDTC';
  if (t.includes('hdrip')) return 'HDRip';
  if (t.includes('hdtv')) return 'HDTV';
  return 'WebDL';
}

function parseLanguage(text, isAnime) {
  const t = (text || '').toLowerCase();
  if (isAnime) {
    if (t.includes('multi') || (t.includes('japanese') && (t.includes('hindi') || t.includes('english')))) return 'Multi Audio (Sub+Dub)';
    if (t.includes('japanese')) return 'Japanese (Sub)';
    if (t.includes('english') || t.includes('dub')) return 'English (Dub)';
    return 'Japanese';
  }
  if (t.includes('dual') || (t.includes('hindi') && t.includes('english'))) return 'Dual Audio';
  if (t.includes('multi')) return 'Multi Audio';
  if (t.includes('hindi')) return 'Hindi';
  if (t.includes('english')) return 'English';
  if (t.includes('tamil')) return 'Tamil';
  if (t.includes('telugu')) return 'Telugu';
  if (t.includes('malayalam') || t.includes('malyalam')) return 'Malayalam';
  return 'Hindi';
}

function parseSize(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+)\s*(GB|MB)/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  return {
    raw: m[0],
    bytes: unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024,
  };
}

function detectHdr(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('dolby vision') || t.includes(' dv ')) return 'DolbyVision';
  if (t.includes('hdr10+')) return 'HDR10+';
  if (t.includes('hdr')) return 'HDR';
  return '';
}

// Search cinevood.love for a title
async function searchCinevood(query) {
  const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
  try {
    const html = await fetchText(searchUrl, BASE_URL + '/');
    const results = [];
    // Find /download-{slug}/ URLs
    const re = /href="(https:\/\/cinevood\.love\/download-[^"]+)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const url = m[1];
      const slug = url.match(/\/download-([^/]+)/)?.[1] || '';
      const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      if (!results.some(r => r.url === url)) {
        results.push({ url, slug, title });
      }
    }
    return results;
  } catch (e) {
    console.log(`[cinevood] Search failed: ${e.message}`);
    return [];
  }
}

// Extract download links + quality titles from a movie page
function extractDownloadLinks(html) {
  const links = [];

  // Find all <h3 class="mfx-quality-title"> elements followed by download links
  // Pattern: <h3 class="mfx-quality-title">Title Text</h3> ... <a class="mfx-download-link" href="URL">
  const qualityTitles = [];
  const titleRe = /<h3\s+class="mfx-quality-title"[^>]*>([^<]*)<\/h3>/gi;
  let m;
  while ((m = titleRe.exec(html)) !== null) {
    qualityTitles.push({ text: m[1].trim(), index: m.index });
  }

  // Find all download links
  const dlLinks = [];
  const dlRe = /<a\s+class="mfx-download-link"\s+href="([^"]+)"/gi;
  while ((m = dlRe.exec(html)) !== null) {
    dlLinks.push({ url: m[1], index: m.index });
  }

  // Match each download link with the nearest preceding quality title
  for (const dl of dlLinks) {
    let bestTitle = null;
    let bestDist = Infinity;
    for (const qt of qualityTitles) {
      if (qt.index < dl.index) {
        const dist = dl.index - qt.index;
        if (dist < bestDist) {
          bestDist = dist;
          bestTitle = qt.text;
        }
      }
    }
    links.push({
      url: dl.url,
      qualityTitle: bestTitle || '',
    });
  }

  return links;
}

export class Cinevood extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinevood';
    this.label = 'Cinevood';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const isAnime = await isAnimeContent(this.fetcher, ctx, tmdbId);

    // Search cinevood.love
    const cleanTitle = name.replace(/[':;,.!?()]/g, ' ').replace(/\s+/g, ' ').trim();
    const searchQuery = cleanTitle.split(/\s+/).slice(0, 4).join(' ');
    console.log(`[cinevood] Searching for: "${searchQuery}"`);
    const searchResults = await searchCinevood(searchQuery);
    if (searchResults.length === 0) {
      console.log('[cinevood] No search results');
      return [];
    }
    console.log(`[cinevood] Found ${searchResults.length} search result(s)`);

    // Pick best match — prefer slug containing title keywords
    const titleWords = cleanTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let best = null;
    let bestScore = 0;
    for (const r of searchResults) {
      const slugLower = r.slug.toLowerCase();
      let score = 0;
      for (const word of titleWords) {
        if (slugLower.includes(word)) score += 1;
      }
      // Bonus for matching year
      if (year && slugLower.includes(year)) score += 1;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (!best || bestScore < 1) best = searchResults[0];
    console.log(`[cinevood] Best match: ${best.title.slice(0, 60)} [score: ${bestScore}]`);

    // Fetch the movie page
    let pageHtml;
    try {
      pageHtml = await fetchText(best.url, BASE_URL + '/');
    } catch (e) {
      console.log(`[cinevood] Failed to fetch page: ${e.message}`);
      return [];
    }

    // Extract download links with quality titles
    const downloadLinks = extractDownloadLinks(pageHtml);
    if (downloadLinks.length === 0) {
      console.log('[cinevood] No download links found');
      return [];
    }
    console.log(`[cinevood] Found ${downloadLinks.length} download link(s)`);

    // Build stream objects with enriched metadata
    const results = [];
    const seenQualities = new Set();

    for (const dl of downloadLinks) {
      if (!dl.url || !dl.url.startsWith('http')) continue;

      const qualityTitle = dl.qualityTitle || '';
      const height = parseQuality(qualityTitle);
      const codec = parseCodec(qualityTitle);
      const sourceType = parseSourceType(qualityTitle);
      const language = parseLanguage(qualityTitle, isAnime);
      const sizeInfo = parseSize(qualityTitle);
      const hdr = detectHdr(qualityTitle);

      // Skip duplicate qualities (keep first)
      const qualityKey = `${height}_${codec}`;
      if (seenQualities.has(qualityKey)) continue;
      seenQualities.add(qualityKey);

      const hdrTag = hdr ? ` ${hdr}` : '';
      const sizeTag = sizeInfo ? ` [${sizeInfo.raw}]` : '';
      const audioTag = isAnime ? ' [SUB+DUB]' : '';

      let url;
      try { url = new URL(dl.url); } catch { continue; }

      const countryCodes = isAnime
        ? [CountryCode.multi, CountryCode.ja, CountryCode.en]
        : [CountryCode.multi, CountryCode.hi, CountryCode.en];

      results.push({
        url,
        format: 'iframe', // External URL — Stremio opens in browser
        meta: {
          countryCodes,
          title: `${title} — [Cinevood ${height}p ${sourceType} ${codec}${hdrTag} ${language}]${sizeTag}${audioTag}`,
          sourceId: this.id,
          sourceLabel: this.label,
          height,
          sourceType,
          codec,
          serverName: 'mobilejsr',
          audioLabel: language,
          isMultiAudio: /multi|dual/i.test(language),
          ...(isAnime && { isMultiAudio: true }),
          ...(sizeInfo && { bytes: sizeInfo.bytes }),
        },
      });
    }

    // Sort by quality (4K first)
    results.sort((a, b) => (b.meta?.height || 0) - (a.meta?.height || 0));

    console.log(`[cinevood] ${results.length} stream(s)${isAnime ? ' [anime]' : ''}`);
    return results;
  }
}
