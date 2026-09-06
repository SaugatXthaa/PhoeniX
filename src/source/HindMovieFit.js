// src/source/HindMovieFit.js
// hindmovie.fit — movies/TV/anime with download links (up to 4K)
//
// HindMovie.fit is a WordPress site that provides download links via
// mvlink.blog → hshare.ink (file-host aggregator).
//
// Flow:
//   1. Search: GET /wp-json/wp/v2/posts?search={query}&_fields=link,title,slug
//   2. Fetch movie page → extract:
//      - <a class="maxbutton-download" href="https://mvlink.blog/{ID}"> links
//      - Quality info from surrounding context (480p, 720p, 1080p, 4K, HEVC, etc.)
//   3. For each mvlink.blog URL: GET https://mvlink.blog/wp-json/wp/v2/posts/{ID}
//      → Returns post content with hshare.ink/?id={filename} URL
//   4. POST https://mvlink.blog/wp-admin/admin-ajax.php
//      Body: action=hindshare_sign&d={base64_filename}
//      → Returns signed r.php URL on hshare.ink
//   5. GET hshare.ink/r.php → 302 → hshare.ink/f.php → direct download URL
//      (hshare.ink is Cloudflare-protected — uses got-scraping for bypass)
//
// STREAM RESOLUTION:
//   The hshare.ink r.php → f.php chain returns the actual download URL
//   (typically a workers.dev or googleusercontent.com URL).
//   These are returned as direct playable streams.
//   If hshare.ink is fully CF-blocked, falls back to external URL.
//
// ENRICHED METADATA:
//   - height: 480/720/1080/2160 (from page context)
//   - codec: HEVC (x265) / x264 (from filename)
//   - sourceType: WEB-DL / BluRay / HDRip (from filename)
//   - audioLabel: Dual Audio / Hindi / English / Japanese (anime)
//   - fileSize: from filename
//
// ANIME SUPPORT:
//   - Detects anime via TMDB genres (Animation=16) or original_language=ja
//   - Anime files have "Dual Audio Hindi-Japanese" or "Multi Audio"

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://hindmovie.fit';
const MVLINK_API = 'https://mvlink.blog/wp-json/wp/v2/posts';
const MVLINK_AJAX = 'https://mvlink.blog/wp-admin/admin-ajax.php';
const HSHARE_BASE = 'https://hshare.ink';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let _gotScraping = null;
async function getGot() {
  if (_gotScraping) return _gotScraping;
  try {
    const mod = await import('got-scraping');
    _gotScraping = mod.gotScraping;
  } catch (e) {
    console.error('[hindmovie-fit] Failed to load got-scraping:', e.message);
  }
  return _gotScraping;
}

async function gotGet(url, headers = {}, timeoutMs = 15000) {
  const got = await getGot();
  if (!got) throw new Error('got-scraping unavailable');
  return got(url, {
    headers: { 'User-Agent': UA, ...headers },
    timeout: { request: timeoutMs },
    throwHttpErrors: false,
    followRedirect: true,
    http2: true,
  });
}

async function gotPost(url, body, headers = {}, timeoutMs = 15000) {
  const got = await getGot();
  if (!got) throw new Error('got-scraping unavailable');
  return got.post(url, {
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body,
    timeout: { request: timeoutMs },
    throwHttpErrors: false,
    http2: true,
  });
}

// Detect anime via TMDB genres + original language
async function isAnimeContent(fetcher, ctx, tmdbId) {
  try {
    const type = tmdbId.season ? 'tv' : 'movie';
    const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}`);
    url.searchParams.set('api_key', TMDB_API_KEY);
    const data = await fetcher.json(ctx, url);
    if (!data) return false;
    const genres = data.genres || [];
    if (genres.some(g => g.id === 16)) return true;
    if (data.original_language === 'ja') return true;
    return false;
  } catch { return false; }
}

// Parse quality from text
function parseHeight(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('2160') || t.includes('4k')) return 2160;
  if (t.includes('1080')) return 1080;
  if (t.includes('720')) return 720;
  if (t.includes('480')) return 480;
  return 1080;
}

function parseCodec(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('x265') || t.includes('h265') || t.includes('hevc')) return 'HEVC';
  if (t.includes('x264') || t.includes('h264') || t.includes('avc')) return 'x264';
  if (t.includes('2160') || t.includes('4k')) return 'HEVC';
  return 'x264';
}

function parseSourceType(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('remux')) return 'BluRay Remux';
  if (t.includes('bluray') || t.includes('bdrip') || t.includes('brrip')) return 'BluRay';
  if (t.includes('web-dl') || t.includes('webdl')) return 'WebDL';
  if (t.includes('webrip')) return 'WebRip';
  if (t.includes('hdtc')) return 'HDTC';
  if (t.includes('hdrip')) return 'HDRip';
  return 'WebDL';
}

function parseLanguage(text, isAnime) {
  const t = (text || '').toLowerCase();
  if (isAnime) {
    if (t.includes('dual') || (t.includes('hindi') && t.includes('japanese'))) return 'Dual Audio (Sub+Dub)';
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
  return 'Hindi';
}

function parseSize(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+)\s*(GB|MB)/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  return { raw: m[0], bytes: unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024 };
}

// Search hindmovie.fit via WP REST API
async function searchHindMovie(query) {
  const url = `${BASE_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&_fields=link,title,slug&per_page=10`;
  try {
    const res = await gotGet(url, { Accept: 'application/json' });
    if (res.statusCode !== 200) return [];
    const posts = JSON.parse(res.body);
    return posts.map(p => ({
      url: p.link,
      slug: p.slug || '',
      title: p.title?.rendered || '',
    }));
  } catch (e) {
    console.log(`[hindmovie-fit] Search failed: ${e.message}`);
    return [];
  }
}

// Extract mvlink.blog URLs + quality from movie page
function extractMvLinks(html) {
  const links = [];
  const re = /href="(https:\/\/mvlink\.blog\/(\d+))"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    const postId = m[2];
    // Get surrounding context for quality detection (500 chars before)
    const start = Math.max(0, m.index - 500);
    const context = html.substring(start, m.index + m[0].length);
    // Extract quality keywords from context
    const qualityText = context.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    if (!links.some(l => l.url === url)) {
      links.push({ url, postId, context: qualityText });
    }
  }
  return links;
}

// Get hshare.ink file ID from mvlink.blog post via WP REST API
async function getHshareId(mvlinkPostId) {
  try {
    const url = `${MVLINK_API}/${mvlinkPostId}`;
    const res = await gotGet(url, { Accept: 'application/json', Referer: 'https://mvlink.blog/' });
    if (res.statusCode !== 200) return null;
    const data = JSON.parse(res.body);
    const content = data.content?.rendered || '';
    // Find hshare.ink/?id=<filename> URL
    const match = content.match(/https:\/\/hshare\.ink\/\?id=([^"'\s<>]+)/i);
    if (match) return match[1];
    return null;
  } catch { return null; }
}

// Sign hshare.ink ID via mvlink.blog admin-ajax → get r.php URL
// The hshare ID must be base64-encoded (without padding) before sending
async function signHshareId(hshareId) {
  try {
    // Base64-encode the hshare ID (strip trailing = padding)
    const b64 = Buffer.from(hshareId).toString('base64').replace(/=+$/, '');
    const body = `action=hindshare_sign&d=${b64}`;
    const res = await gotPost(MVLINK_AJAX, body, {
      Referer: 'https://mvlink.blog/',
      Accept: '*/*',
    });
    if (res.statusCode !== 200) return null;
    const data = JSON.parse(res.body);
    if (data?.success && data?.data?.url) return data.data.url;
    return null;
  } catch { return null; }
}

// Resolve hshare.ink r.php → f.php → direct download URL
// hshare.ink is Cloudflare-protected — uses got-scraping for TLS fingerprint bypass
async function resolveHshareUrl(rphpUrl) {
  const got = await getGot();
  if (!got) return null;
  try {
    // Fetch r.php (follow redirects — r.php → f.php → final URL)
    const res = await got(rphpUrl, {
      headers: { 'User-Agent': UA, 'Referer': 'https://mvlink.blog/' },
      timeout: { request: 15000 },
      throwHttpErrors: false,
      followRedirect: true,
      http2: true,
    });

    if (res.statusCode !== 200 || !res.body) return null;

    // Check if it's a CF challenge page
    if (res.body.includes('One moment') || res.body.includes('challenge-platform')) {
      console.log('[hindmovie-fit]   hshare.ink CF challenge — cannot bypass');
      return null;
    }

    // Look for direct download URLs in the response
    // hshare.ink f.php returns a page with the actual download URL
    const workersMatch = res.body.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\/[^"'\s<>]+/i);
    if (workersMatch) return { url: workersMatch[0], type: 'workers' };

    const gdriveMatch = res.body.match(/https:\/\/[a-z0-9.-]*googleusercontent\.com\/[^"'\s<>]+/i);
    if (gdriveMatch) return { url: gdriveMatch[0], type: 'gdrive' };

    const pixeldrainMatch = res.body.match(/https:\/\/pixeldrain\.[a-z]+\/[^"'\s<>]+/i);
    if (pixeldrainMatch) return { url: pixeldrainMatch[0], type: 'pixeldrain' };

    // Look for any direct video URL (.mkv, .mp4)
    const mkvMatch = res.body.match(/https?:\/\/[^"'\s<>]+\.mkv[^"'\s<>]*/i);
    if (mkvMatch) return { url: mkvMatch[0], type: 'mkv' };

    const mp4Match = res.body.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
    if (mp4Match) return { url: mp4Match[0], type: 'mp4' };

    // Look for meta refresh redirect
    const metaRefresh = res.body.match(/url=([^"'>\s]+)/i);
    if (metaRefresh && metaRefresh[1].startsWith('http')) {
      return { url: metaRefresh[1], type: 'redirect' };
    }

    return null;
  } catch (e) {
    console.log(`[hindmovie-fit]   hshare resolve error: ${e.message}`);
    return null;
  }
}

export class HindMovieFit extends Source {
  constructor(fetcher) {
    super();
    this.id = 'hindmoviefit';
    this.label = 'HindMovie';
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

    // Search hindmovie.fit
    const cleanTitle = name.replace(/[':;,.!?()]/g, ' ').replace(/\s+/g, ' ').trim();
    const searchQuery = cleanTitle.split(/\s+/).slice(0, 4).join(' ');
    console.log(`[hindmovie-fit] Searching for: "${searchQuery}"`);
    const searchResults = await searchHindMovie(searchQuery);
    if (searchResults.length === 0) {
      console.log('[hindmovie-fit] No search results');
      return [];
    }
    console.log(`[hindmovie-fit] Found ${searchResults.length} result(s)`);

    // Pick best match
    const titleWords = cleanTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let best = null;
    let bestScore = 0;
    for (const r of searchResults) {
      const slugLower = r.slug.toLowerCase();
      let score = 0;
      for (const word of titleWords) {
        if (slugLower.includes(word)) score += 1;
      }
      if (year && slugLower.includes(year)) score += 1;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (!best || bestScore < 1) best = searchResults[0];
    console.log(`[hindmovie-fit] Best match: ${best.title.slice(0, 60)} [score: ${bestScore}]`);

    // Fetch movie page
    let pageHtml;
    try {
      const res = await gotGet(best.url, { Referer: BASE_URL + '/' });
      pageHtml = res.body;
    } catch (e) {
      console.log(`[hindmovie-fit] Failed to fetch page: ${e.message}`);
      return [];
    }

    // Extract mvlink.blog URLs with quality context
    const mvLinks = extractMvLinks(pageHtml);
    if (mvLinks.length === 0) {
      console.log('[hindmovie-fit] No mvlink.blog URLs found');
      return [];
    }
    console.log(`[hindmovie-fit] Found ${mvLinks.length} mvlink.blog URL(s)`);

    // Process each mvlink URL: get hshare ID → sign → resolve
    const results = [];
    const seenQualities = new Set();

    for (const mv of mvLinks) {
      const contextText = mv.context || '';
      const height = parseHeight(contextText);
      const codec = parseCodec(contextText);
      const sourceType = parseSourceType(contextText);
      const language = parseLanguage(contextText, isAnime);

      // Skip duplicate qualities
      const qKey = `${height}_${codec}`;
      if (seenQualities.has(qKey)) continue;
      seenQualities.add(qKey);

      // Pre-compute metadata used in both direct and external stream results
      const countryCodes = isAnime
        ? [CountryCode.multi, CountryCode.ja, CountryCode.en]
        : [CountryCode.multi, CountryCode.hi, CountryCode.en];
      const audioTag = isAnime ? ' [SUB+DUB]' : '';

      console.log(`[hindmovie-fit] Processing ${height}p ${codec} ${language} (mvlink/${mv.postId})`);

      // Step 1: Get hshare.ink file ID from mvlink.blog WP API
      const hshareId = await getHshareId(mv.postId);
      if (!hshareId) {
        console.log('[hindmovie-fit]   No hshare ID found');
        continue;
      }
      console.log(`[hindmovie-fit]   hshare ID: ${hshareId.slice(0, 50)}...`);

      // Step 2: Sign the hshare ID → get r.php URL
      const rphpUrl = await signHshareId(hshareId);
      if (!rphpUrl) {
        console.log('[hindmovie-fit]   Sign failed');
        continue;
      }

      // Step 3: Resolve r.php → direct download URL
      const resolved = await resolveHshareUrl(rphpUrl);
      if (!resolved) {
        console.log('[hindmovie-fit]   hshare.ink CF-blocked — returning mvlink URL as external');
        // Fallback: return the mvlink.blog URL as external stream
        results.push({
          url: new URL(mv.url),
          format: 'iframe',
          isExternal: true,
          meta: {
            countryCodes,
            title: `${title} — [HindMovie ${height}p ${sourceType} ${codec} ${language}]${audioTag}`,
            sourceId: this.id,
            sourceLabel: this.label,
            height,
            sourceType,
            codec,
            serverName: 'mvlink',
            audioLabel: language,
            isMultiAudio: /multi|dual/i.test(language),
            ...(isAnime && { isMultiAudio: true }),
          },
        });
        continue;
      }

      console.log(`[hindmovie-fit]   ✓ Resolved: ${resolved.url.slice(0, 80)}...`);

      // Parse file size from hshare filename
      const sizeInfo = parseSize(hshareId);

      // Build stream result
      let streamUrl;
      try { streamUrl = new URL(resolved.url); } catch { continue; }

      const sizeTag = sizeInfo ? ` [${sizeInfo.raw}]` : '';

      // Check if URL needs /range-proxy (googleusercontent) or /proxy (workers.dev)
      const isGoogle = streamUrl.hostname.includes('googleusercontent.com');
      const isWorkers = streamUrl.hostname.includes('workers.dev');

      let finalUrl = streamUrl;
      let format = Format.mp4;

      if (isGoogle) {
        // googleusercontent doesn't support Range — route through /range-proxy
        const proxyUrl = new URL('/range-proxy', ctx.hostUrl);
        proxyUrl.searchParams.set('url', streamUrl.href);
        finalUrl = proxyUrl;
      } else if (isWorkers) {
        // workers.dev may need Referer — route through /proxy
        const proxyUrl = new URL('/proxy', ctx.hostUrl);
        proxyUrl.searchParams.set('url', streamUrl.href);
        proxyUrl.searchParams.set('referer', HSHARE_BASE + '/');
        finalUrl = proxyUrl;
      }

      results.push({
        url: finalUrl,
        format,
        meta: {
          countryCodes,
          title: `${title} — [HindMovie ${height}p ${sourceType} ${codec} ${language}]${sizeTag}${audioTag}`,
          sourceId: this.id,
          sourceLabel: this.label,
          height,
          sourceType,
          codec,
          serverName: resolved.type || 'hshare',
          audioLabel: language,
          isMultiAudio: /multi|dual/i.test(language),
          ...(isAnime && { isMultiAudio: true }),
          ...(sizeInfo && { bytes: sizeInfo.bytes }),
        },
      });
    }

    // Sort by quality (4K first)
    results.sort((a, b) => (b.meta?.height || 0) - (a.meta?.height || 0));

    console.log(`[hindmovie-fit] ${results.length} stream(s)${isAnime ? ' [anime]' : ''}`);
    return results;
  }
}
