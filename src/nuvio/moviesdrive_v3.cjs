// MoviesDrive — Direct Stream Extractor (4K playable, NO torrents)
// =========================================================================
// Reverse-engineered chain (v2 — works with new3.moviesdrive.christmas):
//
//   1. TMDB lookup → get IMDB ID + title (e.g. "Dune: Part Two" → tt15239678)
//   2. Search moviesdrive via /search.php (Typesense backend) → returns permalinks
//      URL: https://new3.moviesdrive.christmas/search.php?q=<title>&per_page=10
//      Returns JSON: { hits: [{ document: { imdb_id, post_title, permalink }}] }
//   3. Fetch movie page (e.g. /dune-part-two-2024/) → extract hubcloud URLs
//      Each quality (480p, 720p, 1080p, 2160p) has its own hubcloud URL with from_ac token
//      Format: https://hubcloud.foo/drive/search-recover.php?from_ac=<token>&q=<base64>
//   4. Visit hubcloud.cx page → get fresh FROM_AC_TOKEN from page HTML
//   5. Call hubcloud.cx API: ?api=search&q=<title>&page=1&from_ac=<token>
//      Returns JSON: { hits: [{ file_name, url, size, mimeType }] }
//      File URL format: https://hubcloud.cx/drive/<file_id>
//   6. Fetch /drive/<file_id> page → extract direct download URLs:
//        - https://gpdl.hubcloud.cx/?id=<encrypted_id>  (10Gbps server)
//        - https://pixeldrain.dev/u/<pixel_id>           (PixelDrain mirror)
//        - https://hubcloud.cx/tg/go?id=<encrypted_id>    (Telegram bot)
//   7. **PixelDrain is the playable URL**: https://pixeldrain.dev/api/file/<id>
//      Returns the actual MKV file with Range support and CORS headers.
//      Stremio, mpv, VLC, etc. can stream it directly.
//
// KEY DISCOVERY:
//   The hubcloud.cx search API does loose fuzzy matching. Searching for the
//   FULL title ("Download Dune: Part Two 2024 2160p") returns WRONG files.
//   Searching for just "<title> <quality>" (e.g. "Dune Part Two 2160p")
//   returns the CORRECT file.
//
// DOMAIN HISTORY:
//   - https://new2.moviesdrives.my        ← original (D3adlyRocket repo, DEAD)
//   - https://new1.moviesdrive.christmas  ← redirects to new3 (NuvioPlugin repo)
//   - https://new3.moviesdrive.christmas  ← CURRENT (working)
//   - https://moviesdrives.cfd            ← fake squatter site (NOT the real one)
//
// QUALITY SUPPORT:
//   ✅ 4K (2160p) SDR  — up to 19GB
//   ✅ 1080p WEB-DL    — 3.5GB
//   ✅ 720p            — 1.5GB
//   ✅ 480p            — 590MB
//   Languages: Hindi Dubbed (ORG 5.1), English, Dual Audio, Tamil, Telugu, etc.
//
// USAGE:
//   node moviesdrive_all_in_one.js <tmdbId> <movie|tv> [season] [episode]
//   node moviesdrive_all_in_one.js search "dune"

'use strict';

const https = require('https');
const http = require('http');

const PROVIDER_NAME = 'MoviesDrive';
const MAIN_URL = 'https://new3.moviesdrive.christmas';
const SEARCH_API = MAIN_URL + '/search.php';
const HUBCLOUD_BASE = 'https://hubcloud.cx';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─── HTTP helpers ──────────────────────────────────────────────────────────
function fetchText(url, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 15000;
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': UA,
      'Accept': opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    };
    if (opts.referer) headers['Referer'] = opts.referer;
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    if (opts.origin) headers['Origin'] = opts.origin;

    const req = https.get(url, { headers, rejectUnauthorized: false }, (res) => {
      // Follow up to 5 redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return resolve(fetchText(next, opts));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url.slice(0, 80)}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout after ${timeout}ms`)));
  });
}

async function fetchJson(url, opts) {
  const text = await fetchText(url, { ...opts, accept: 'application/json, text/javascript, */*; q=0.01' });
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON parse error: ${e.message}`);
  }
}

// ─── TMDB info ─────────────────────────────────────────────────────────────
async function getTMDBInfo(tmdbId, type) {
  const isTV = type === 'tv' || type === 'series';
  const url = `https://api.themoviedb.org/3/${isTV ? 'tv' : 'movie'}/${tmdbId}` +
              `?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return {
      title: (isTV ? j.name : j.title) || 'Unknown',
      year: ((isTV ? j.first_air_date : j.release_date) || '').slice(0, 4),
      imdbId: j.imdb_id || (j.external_ids && j.external_ids.imdb_id) || null,
      type, tmdbId: String(tmdbId),
    };
  } catch (e) {
    console.log(`[MoviesDrive] TMDB lookup failed: ${e.message}`);
    return null;
  }
}

// ─── Search MoviesDrive via Typesense-backed search.php ────────────────────
async function searchMoviesdrive(query, perPage) {
  perPage = perPage || 10;
  const url = `${SEARCH_API}?q=${encodeURIComponent(query)}&per_page=${perPage}`;
  try {
    const data = await fetchJson(url, { referer: MAIN_URL + '/' });
    if (!data || !data.hits) return [];
    return data.hits.map(h => {
      const doc = h.document || {};
      return {
        id: doc.id,
        imdbId: doc.imdb_id,
        title: doc.post_title || '',
        permalink: doc.permalink || '',
        thumbnail: doc.post_thumbnail || '',
        categories: doc.category || [],
        date: doc.post_date || '',
      };
    });
  } catch (e) {
    console.log(`[MoviesDrive] Search failed: ${e.message}`);
    return [];
  }
}

// ─── Quality detection ────────────────────────────────────────────────────
function detectQuality(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('2160') || t.includes('4k') || t.includes('uhd')) return '2160p';
  if (t.includes('1080')) return '1080p';
  if (t.includes('720'))  return '720p';
  if (t.includes('480'))  return '480p';
  return '1080p';
}

// ─── Detect audio language ────────────────────────────────────────────────
function detectLanguage(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('multi')) return 'Multi-Audio';
  if (t.includes('dual'))  return 'Dual-Audio';
  if (t.includes('hindi') && (t.includes('english') || t.includes('eng'))) return 'Dual-Audio';
  if (t.includes('hindi')) return 'Hindi';
  if (t.includes('english') || t.includes('eng')) return 'English';
  if (t.includes('tamil') || t.includes('tam')) return 'Tamil';
  if (t.includes('telugu') || t.includes('tel')) return 'Telugu';
  return 'Multi-Audio';
}

// ─── Get the hubcloud search query for a specific quality ──────────────────
// The moviesdrive page contains links like:
//   <a href="https://hubcloud.foo/drive/search-recover.php?from_ac=<token>&q=<base64>">
// The base64 decodes to "<movie_title> <quality>" e.g. "Download Dune: Part Two 2024 2160p"
// But the hubcloud.cx search API does loose fuzzy matching, so we extract just the
// movie title + quality (without "Download" prefix) for better results.
function buildSearchQuery(title, qualityLabel) {
  // Strip "Download" prefix and "Full Movie" suffix
  let clean = title
    .replace(/^Download\s+/i, '')
    .replace(/\s*\(?\d{4}\)?\s*/g, ' ')  // Remove year
    .replace(/\s*\[.*?\]\s*/g, ' ')      // Remove [brackets]
    .replace(/\s*\{.*?\}\s*/g, ' ')      // Remove {braces}
    .replace(/\s*(?:WEB-DL|BluRay|AMZN|WEBRip|HDRip|Dual Audio|Hindi Dubbed|English)\s.*/i, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:GB|MB)\b.*/i, '')
    .trim();
  // Add quality
  const qNum = qualityLabel.match(/\d+/)?.[0] || '';
  if (qNum) clean += ` ${qNum}p`;
  return clean;
}

// ─── Fetch movie page and extract download links ──────────────────────────
async function getDownloadLinks(permalink, season, episode) {
  const url = permalink.startsWith('http') ? permalink : (MAIN_URL + permalink);
  const html = await fetchText(url, { referer: MAIN_URL + '/' });

  // Decode HTML entities (e.g. &amp; → &)
  const decoded = html.replace(/&amp;/g, '&').replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
                      .replace(/&#039;/g, "'").replace(/&#x27;/g, "'")
                      .replace(/&nbsp;/g, ' ').replace(/&#8211;/g, '-')
                      .replace(/&ndash;/g, '-').replace(/&mdash;/g, '-');

  // Extract all hubcloud URLs from the page (movie format)
  // Format: https://hubcloud.foo/drive/search-recover.php?from_ac=<token>&q=<base64>
  const links = [];
  const re = /<a[^>]+href="(https:\/\/hubcloud\.[a-z]+\/drive\/search-recover\.php\?from_ac=[A-Za-z0-9_-]+(?:&q=[A-Za-z0-9+/=_-]+)?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(decoded)) !== null) {
    const url = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (text) links.push({ url, text, type: 'movie' });
  }

  // For TV shows: also extract mdrive.lol URLs (TV format)
  // Each mdrive.lol URL is a season+quality archive page
  // We need to find which mdrive.lol URL belongs to which season
  if (season) {
    // Walk through HTML and track season markers
    // Look for "Season N" anywhere in the document (multiple formats):
    //   - <span style="color: #ff0000;">Season 5</span>
    //   - Breaking Bad [Season 1]
    //   - Breaking Bad S02
    //   - SEASON 4 Complete
    const markers = [];
    // Comprehensive season regex — finds Season N anywhere
    const seasonRe = /(?:Season\s+(\d+)|S(\d{2})|SEASON\s+(\d+)|\[Season\s+(\d+)\])/gi;
    let sm;
    while ((sm = seasonRe.exec(decoded)) !== null) {
      const seasonNum = sm[1] || sm[2] || sm[3] || sm[4];
      if (seasonNum) {
        const num = parseInt(seasonNum);
        // Skip implausibly large season numbers (filter false positives)
        if (num >= 1 && num <= 50) {
          markers.push({ pos: sm.index, season: num });
        }
      }
    }
    // mdrive.lol URL markers
    const mdriveRe = /href="(https:\/\/mdrive\.lol\/archive\/\d+\/?)"[^>]*>([\s\S]{0,100}?)<\/a>/gi;
    let mm;
    while ((mm = mdriveRe.exec(decoded)) !== null) {
      const text = mm[2].replace(/<[^>]+>/g, '').trim();
      // Only "Single Episode" links (skip "Zip" archives)
      if (text.toLowerCase().includes('single episode')) {
        markers.push({
          pos: mm.index,
          url: mm[1],
          text,
          type: 'mdrive',
        });
      }
    }
    // Sort by position
    markers.sort((a, b) => a.pos - b.pos);

    // Assign each mdrive.lol URL to its most recent season
    // Use the LAST season seen before the URL (closest preceding season marker)
    let currentSeason = null;
    for (const marker of markers) {
      if (marker.season !== undefined) {
        currentSeason = marker.season;
      } else if (marker.type === 'mdrive' && currentSeason === parseInt(season)) {
        // Extract quality from text (e.g. "1080p Single Episode")
        const qMatch = marker.text.match(/(\d+)p/);
        const quality = qMatch ? `${qMatch[1]}p` : '720p';
        links.push({
          url: marker.url,
          text: marker.text,
          quality,
          type: 'tv',
          season: currentSeason,
        });
      }
    }
  }

  return links;
}

// ─── Resolve TV episode from mdrive.lol archive page ──────────────────────
async function resolveTvEpisode(mdriveUrl, season, episode, quality) {
  const html = await fetchText(mdriveUrl, { referer: MAIN_URL + '/' });

  // Decode HTML entities
  const decoded = html.replace(/&amp;/g, '&').replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>').replace('&quot;', '"')
                      .replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '-')
                      .replace(/&#8211;/g, '-');

  // Walk through HTML and assign hubcloud.cx URLs to episodes
  // Pattern: <span style="color: #ff0000;">Ep01</span> ... <a href="https://hubcloud.cx/drive/<id>">HubCloud</a>
  const markers = [];
  // Episode markers
  const epRe = /<span[^>]*color:\s*#ff0000[^>]*>(Ep\d+|Episode\s*\d+|E\d+)<\/span>/gi;
  let em;
  while ((em = epRe.exec(decoded)) !== null) {
    const epText = em[1];
    // Extract episode number
    const epNumMatch = epText.match(/(\d+)/);
    if (epNumMatch) {
      markers.push({ pos: em.index, episode: parseInt(epNumMatch[1]) });
    }
  }
  // hubcloud.cx URL markers
  const urlRe = /href="(https:\/\/hubcloud\.cx\/drive\/[A-Za-z0-9_]+)"/gi;
  let um;
  while ((um = urlRe.exec(decoded)) !== null) {
    markers.push({ pos: um.index, url: um[1], type: 'url' });
  }
  // Sort by position
  markers.sort((a, b) => a.pos - b.pos);

  // Walk through markers and find the URL for the requested episode
  let currentEp = null;
  for (const marker of markers) {
    if (marker.episode !== undefined) {
      currentEp = marker.episode;
    } else if (marker.type === 'url' && currentEp === parseInt(episode)) {
      // Found the right episode — return the file ID
      const fileId = marker.url.match(/\/drive\/([A-Za-z0-9_]+)/)?.[1];
      if (fileId) {
        return { fileId, fileUrl: marker.url, quality };
      }
    }
  }
  return null;
}

// ─── Get a fresh FROM_AC_TOKEN from the hubcloud.cx page ──────────────────
async function getFromAcToken(hubcloudUrl) {
  // IMPORTANT: hubcloud.foo is Cloudflare-protected and rejects Node.js TLS
  // fingerprint. But hubcloud.cx (the redirect target) accepts Node.js requests.
  // So we replace hubcloud.foo with hubcloud.cx directly to skip the redirect.
  const directUrl = hubcloudUrl.replace('hubcloud.foo', 'hubcloud.cx');
  const html = await fetchText(directUrl, { referer: MAIN_URL + '/' });
  const tokenMatch = html.match(/FROM_AC_TOKEN\s*=\s*"([^"]+)"/);
  if (!tokenMatch) {
    throw new Error('Could not extract FROM_AC_TOKEN from hubcloud page');
  }
  return tokenMatch[1];
}

// ─── Search hubcloud.cx API for the right file ────────────────────────────
async function searchHubcloud(token, query) {
  const pageUrl = `${HUBCLOUD_BASE}/drive/search-recover.php?from_ac=${token}`;
  const qEnc = encodeURIComponent(query);
  const apiUrl = `${HUBCLOUD_BASE}/drive/search-recover.php?api=search&q=${qEnc}&page=1&from_ac=${token}`;
  try {
    const data = await fetchJson(apiUrl, { referer: pageUrl });
    return data.hits || [];
  } catch (e) {
    console.log(`[MoviesDrive] Hubcloud search failed for "${query}": ${e.message}`);
    return [];
  }
}

// ─── Resolve hubcloud.cx/drive/<fileId> → direct download URLs ────────────
async function resolveFileUrl(fileId, fileName) {
  const fileUrl = `${HUBCLOUD_BASE}/drive/${fileId}`;
  const html = await fetchText(fileUrl, { referer: HUBCLOUD_BASE + '/' });

  // Look for the gamerxyt bridge URL (always present, format: var url = '...')
  let gamerUrl = null;
  const varUrlMatch = html.match(/var\s+url\s*=\s*'([^']+)'/);
  if (varUrlMatch) gamerUrl = varUrlMatch[1];
  if (!gamerUrl) {
    const aHrefMatch = html.match(/href="(https:\/\/gamerxyt\.com\/hubcloud\.php\?[^"]+)"/i);
    if (aHrefMatch) gamerUrl = aHrefMatch[1];
  }

  const result = { fileId };

  // Direct pixeldrain URL (some files have this)
  const pdMatch = html.match(/https:\/\/pixeldrain\.[a-z]+\/u\/([A-Za-z0-9]+)/i);
  if (pdMatch) {
    result.pixeldrainId = pdMatch[1];
    result.pixeldrainUrl = `https://pixeldrain.dev/api/file/${pdMatch[1]}`;
  }

  // Direct gpdl URL (10Gbps server — some files have this)
  const gpdlMatch = html.match(/https:\/\/gpdl\.hubcloud\.cx\/\?id=[A-Za-z0-9:]+/i);
  if (gpdlMatch) {
    result.gpdlUrl = gpdlMatch[0];
  }

  // File metadata
  const sizeMatch = html.match(/File Size[^<]*<i[^>]*>([^<]+)<\/i>/i);
  if (sizeMatch) result.size = sizeMatch[1].trim();
  const typeMatch = html.match(/File Type[^<]*<i[^>]*>([^<]+)<\/i>/i);
  if (typeMatch) result.mimeType = typeMatch[1].trim();

  // If we don't have a direct URL, fetch the gamerxyt bridge page
  if (!result.pixeldrainUrl && !result.gpdlUrl && gamerUrl) {
    console.log(`[MoviesDrive]     Following gamerxyt bridge...`);
    try {
      const gamerHtml = await fetchText(gamerUrl, { referer: HUBCLOUD_BASE + '/' });

      // Look for ANY Cloudflare worker download URL (multiple worker domains are used)
      // Pattern: https://<worker-name>.workers.dev/<encrypted_id>::<encrypted_id>/<size>/<filename>
      // Examples:
      //   hubcloud.downloadservers.workers.dev (4K files)
      //   fancy-mountain-7dfb.terapiyo232.workers.dev (1080p files)
      //   ...other worker domains
      const workerMatch = gamerHtml.match(
        /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/[A-Za-z0-9:_/-]+\/\d+\/[^"'\s<>]+/i
      );
      if (workerMatch) {
        let cleanUrl = workerMatch[0].replace(/&amp;/g, '&');
        result.workerUrl = cleanUrl;
      }

      // Also look for pixel.hubcloud.cx URL (alternative direct download)
      const pixelMatch = gamerHtml.match(/https:\/\/pixel\.hubcloud\.cx\/\?id=[A-Za-z0-9:_-]+/i);
      if (pixelMatch) {
        result.pixelUrl = pixelMatch[0];
      }

      // Also look for pixeldrain (sometimes appears on gamerxyt page too)
      if (!result.pixeldrainUrl) {
        const pdMatch2 = gamerHtml.match(/https:\/\/pixeldrain\.[a-z]+\/u\/([A-Za-z0-9]+)/i);
        if (pdMatch2) {
          result.pixeldrainId = pdMatch2[1];
          result.pixeldrainUrl = `https://pixeldrain.dev/api/file/${pdMatch2[1]}`;
        }
      }

      // Also look for gpdl (sometimes on gamerxyt page)
      if (!result.gpdlUrl) {
        const gpdlMatch2 = gamerHtml.match(/https:\/\/gpdl\.hubcloud\.cx\/\?id=[A-Za-z0-9:]+/i);
        if (gpdlMatch2) {
          result.gpdlUrl = gpdlMatch2[0];
        }
      }
    } catch (e) {
      console.log(`[MoviesDrive]     Gamerxyt fetch failed: ${e.message.slice(0, 60)}`);
    }
  }

  return result;
}

// ─── Verify a stream URL is actually playable (GET with Range, not HEAD) ───
// Cloudflare worker URLs return 403 on HEAD but 206 on GET with Range.
// So we use a small Range GET request to verify.
async function verifyPlayable(url) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'GET',
      timeout: 10000,
      headers: {
        'User-Agent': UA,
        'Range': 'bytes=0-99',
        'Referer': url.includes('pixeldrain') ? 'https://pixeldrain.dev/' : 'https://gamerxyt.com/',
      },
    }, (res) => {
      resolve({
        ok: (res.statusCode >= 200 && res.statusCode < 300) || res.statusCode === 206,
        status: res.statusCode,
        contentType: res.headers['content-type'],
        contentLength: res.headers['content-length'],
        contentRange: res.headers['content-range'],
      });
      res.resume();
    });
    req.on('error', () => resolve({ ok: false, error: 'request failed' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

// ─── Build Stremio stream object ──────────────────────────────────────────
function buildStream(url, info, quality, language, source, size) {
  const isHls = url.includes('.m3u8');
  const isMkv = url.includes('pixeldrain') || url.includes('matroska') || url.includes('.mkv');
  const titleSuffix = size ? ` [${size}]` : '';

  return {
    name: `${PROVIDER_NAME} | ${quality} | ${language} | ${source}`,
    title: `${info.title}${info.year ? ` (${info.year})` : ''}${titleSuffix} [MoviesDrive ${quality} ${language}]`,
    url,
    quality,
    type: isHls ? 'application/vnd.apple.mpegurl'
                : (isMkv ? 'video/x-matroska' : 'video/mp4'),
    behaviorHints: {
      bingeGroup: `moviesdrive-${quality.toLowerCase()}-${source}`,
      proxyHeaders: {
        request: {
          'User-Agent': UA,
          'Referer': url.includes('pixeldrain') ? 'https://pixeldrain.dev/' : HUBCLOUD_BASE + '/',
        },
      },
    },
  };
}

// ─── Main entry: get playable streams for a TMDB ID ────────────────────────
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isTV = type === 'tv' || type === 'series';
  console.log(`[MoviesDrive] Request: tmdb=${tmdbId} type=${type}` +
              (isTV ? ` S${season}E${episode}` : ''));

  // 1. Get TMDB info
  const info = await getTMDBInfo(tmdbId, type);
  if (!info) {
    console.log('[MoviesDrive] TMDB fetch failed');
    return [];
  }
  console.log(`[MoviesDrive] TMDB: ${info.title}${info.year ? ` (${info.year})` : ''}` +
              ` IMDB: ${info.imdbId || 'N/A'}`);

  // 2. Search MoviesDrive
  // IMPORTANT: Searching by IMDB ID returns wrong matches (Typesense fuzzy matching
  // matches "tt0903747" against "tt0093777" — different movie).
  // So search by TITLE first (more accurate), then verify IMDB ID.
  let searchResults = await searchMoviesdrive(info.title, 10);
  if (searchResults.length === 0 && info.imdbId) {
    // Fallback: search by IMDB ID
    searchResults = await searchMoviesdrive(info.imdbId, 10);
  }
  if (searchResults.length === 0) {
    console.log('[MoviesDrive] No search results');
    return [];
  }
  console.log(`[MoviesDrive] Found ${searchResults.length} search result(s)`);

  // Pick best match:
  // 1. Exact IMDB ID match (if available)
  // 2. Title contains the search query (loose match)
  let best = null;
  if (info.imdbId) {
    best = searchResults.find(r => r.imdbId === info.imdbId);
  }
  if (!best) {
    // Pick the result whose title contains our search query (case-insensitive)
    const titleLower = info.title.toLowerCase();
    const titleMatch = searchResults.find(r =>
      r.title.toLowerCase().includes(titleLower) ||
      titleLower.includes(r.title.toLowerCase().split(/\s+/)[0].toLowerCase())
    );
    best = titleMatch || searchResults[0];
  }
  console.log(`[MoviesDrive] Best match: ${best.title.slice(0, 60)} (${best.permalink})`);

  // 3. Fetch movie page and extract download links (one per quality)
  let downloadLinks;
  try {
    downloadLinks = await getDownloadLinks(best.permalink, season, episode);
  } catch (e) {
    console.log(`[MoviesDrive] Failed to fetch movie page: ${e.message}`);
    return [];
  }
  if (downloadLinks.length === 0) {
    console.log('[MoviesDrive] No download links found on movie page');
    return [];
  }
  console.log(`[MoviesDrive] Found ${downloadLinks.length} download link(s)`);

  // 4. For each quality link, resolve to a playable URL via hubcloud.cx
  const allStreams = [];
  const seenQualities = new Set();

  for (const link of downloadLinks) {
    const quality = link.quality || detectQuality(link.text);
    const language = detectLanguage(link.text + ' ' + best.title);

    if (seenQualities.has(quality)) continue;
    seenQualities.add(quality);

    console.log(`[MoviesDrive] Resolving ${quality} ${language}...`);
    try {
      let fileId = null;
      let fileName = '';

      if (link.type === 'tv') {
        // TV show: link.url is a mdrive.lol archive page
        console.log(`[MoviesDrive]   Resolving TV episode from mdrive.lol...`);
        const epInfo = await resolveTvEpisode(link.url, season, episode, quality);
        if (!epInfo) {
          console.log(`[MoviesDrive]   ✗ Could not find S${season}E${episode} on archive page`);
          continue;
        }
        fileId = epInfo.fileId;
        fileName = `S${season}E${episode} ${quality}`;
        console.log(`[MoviesDrive]   ✓ File ID: ${fileId}`);
      } else {
        // Movie: link.url is a hubcloud search-recover URL
        // Step 4a: Get FROM_AC_TOKEN by visiting the hubcloud URL
        const token = await getFromAcToken(link.url);
        console.log(`[MoviesDrive]   ✓ Token: ${token.slice(0, 30)}...`);

        // Step 4b: Search hubcloud.cx for the right file
        const titleClean = best.title
          .replace(/^Download\s+/i, '')
          .replace(/\s*\(?\d{4}\)?\s*/g, ' ')
          .replace(/\s*\[.*?\]\s*/g, ' ')
          .replace(/\s*\{.*?\}\s*/g, ' ')
          .replace(/\s*(?:WEB-DL|BluRay|AMZN|WEBRip|HDRip).*$/i, '')
          .trim();
        const qNum = quality.replace('p', '');
        const searchQ = `${titleClean} ${qNum}p`;
        console.log(`[MoviesDrive]   Searching hubcloud for: "${searchQ}"`);

        const hits = await searchHubcloud(token, searchQ);
        if (hits.length === 0) {
          console.log(`[MoviesDrive]   ✗ No files found in hubcloud search`);
          continue;
        }

        // Pick the best match (prefer the one with the right quality in the filename)
        const qualityHits = hits.filter(h =>
          (h.file_name || '').toLowerCase().includes(qNum) ||
          (quality === '2160p' && (h.file_name || '').toLowerCase().includes('4k'))
        );
        const target = qualityHits[0] || hits[0];
        console.log(`[MoviesDrive]   ✓ Found: ${(target.file_name || '').slice(0, 60)}`);

        fileId = target.url.match(/\/drive\/([A-Za-z0-9_]+)/)?.[1];
        fileName = target.file_name || '';
      }

      if (!fileId) {
        console.log(`[MoviesDrive]   ✗ Could not extract file ID`);
        continue;
      }

      // Step 4c: Resolve the file URL to direct download URLs
      const resolved = await resolveFileUrl(fileId, fileName);
      if (!resolved.pixeldrainUrl && !resolved.gpdlUrl && !resolved.workerUrl && !resolved.pixelUrl) {
        console.log(`[MoviesDrive]   ✗ No playable URL found on file page`);
        continue;
      }

      // Prefer PixelDrain (best for streaming — Range support + CORS)
      // Then Cloudflare worker (*.workers.dev — Range supported)
      // Then pixel.hubcloud.cx (alternative direct download)
      // Then GPDL (10Gbps server — works but slower)
      const playUrl = resolved.pixeldrainUrl || resolved.workerUrl || resolved.pixelUrl || resolved.gpdlUrl;
      const source = resolved.pixeldrainUrl ? 'PixelDrain'
                   : resolved.workerUrl ? 'Cloudflare-Worker'
                   : resolved.pixelUrl ? 'PixelServer'
                   : 'HubCloud-10Gbps';
      console.log(`[MoviesDrive]   ✓ ${source}: ${playUrl.slice(0, 80)}...`);

      // Verify the URL is playable (Range GET request)
      const verified = await verifyPlayable(playUrl);
      if (!verified.ok) {
        console.log(`[MoviesDrive]   ✗ Verify failed: HTTP ${verified.status}`);
        continue;
      }
      console.log(`[MoviesDrive]   ✓ Verified (HTTP ${verified.status}, ${verified.contentType || 'unknown'}, ${verified.contentRange || 'no range'})`);

      allStreams.push(buildStream(playUrl, info, quality, language, source, resolved.size || ''));
    } catch (e) {
      console.log(`[MoviesDrive]   ✗ Resolution failed: ${e.message.slice(0, 80)}`);
    }
  }

  // Sort by quality (4K first)
  const qOrder = { '2160p': 0, '1080p': 1, '720p': 2, '480p': 3, '360p': 4 };
  allStreams.sort((a, b) => (qOrder[a.quality] || 99) - (qOrder[b.quality] || 99));

  console.log(`[MoviesDrive] ✅ ${allStreams.length} playable stream(s) total`);
  const counts = {};
  for (const s of allStreams) counts[s.quality] = (counts[s.quality] || 0) + 1;
  if (Object.keys(counts).length > 0) {
    console.log('[MoviesDrive] Quality: ' +
                Object.entries(counts).map(([k,v]) => `${k}=${v}`).join(', '));
  }
  return allStreams;
}

// ─── Module exports ────────────────────────────────────────────────────────
module.exports = {
  getStreams,
  getTMDBInfo,
  searchMoviesdrive,
  getDownloadLinks,
  getFromAcToken,
  searchHubcloud,
  resolveFileUrl,
  verifyPlayable,
  MAIN_URL,
};

// ─── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('MoviesDrive Direct Stream Extractor (4K playable)');
    console.log('');
    console.log('Usage:');
    console.log('  node moviesdrive_all_in_one.js <tmdbId> <movie|tv> [season] [episode]');
    console.log('    Get playable streams (4K/1080p/720p/480p via PixelDrain)');
    console.log('');
    console.log('  node moviesdrive_all_in_one.js search "dune"');
    console.log('    Search MoviesDrive catalog');
    console.log('');
    console.log('Examples:');
    console.log('  node moviesdrive_all_in_one.js 693134 movie         # Dune Part Two (4K available)');
    console.log('  node moviesdrive_all_in_one.js 1396 tv 1 1          # Breaking Bad S01E01');
    console.log('');
    console.log('Chain: new3.moviesdrive.christmas → hubcloud.cx → pixeldrain.dev');
    process.exit(1);
  }

  const cmd = args[0];

  if (cmd === 'search') {
    const query = args[1];
    if (!query) { console.error('Search query required'); process.exit(1); }
    searchMoviesdrive(query, 10).then(results => {
      console.log(`\n=== Search results for "${query}" ===`);
      if (results.length === 0) {
        console.log('No results.');
      } else {
        results.forEach((r, i) => {
          console.log(`${i+1}. ${r.title.slice(0, 80)}`);
          console.log(`   Permalink: ${r.permalink}`);
          console.log(`   IMDB: ${r.imdbId || 'N/A'}`);
        });
      }
    }).catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
  } else {
    const tmdbId = args[0];
    const type = args[1] || 'movie';
    const season = args[2] || null;
    const episode = args[3] || null;
    getStreams(tmdbId, type, season, episode)
      .then(s => {
        console.log('\n=== Final playable streams (sorted by quality) ===');
        if (s.length === 0) {
          console.log('No streams found.');
        } else {
          const byQuality = {};
          s.forEach(x => { byQuality[x.quality] = byQuality[x.quality] || []; byQuality[x.quality].push(x); });
          let idx = 1;
          for (const q of ['2160p', '1080p', '720p', '480p', '360p']) {
            if (byQuality[q]) {
              console.log(`\n--- ${q} (${byQuality[q].length} stream) ---`);
              for (const x of byQuality[q]) {
                console.log(`${idx}. ${x.name}`);
                console.log(`   URL: ${x.url.slice(0, 150)}${x.url.length > 150 ? '...' : ''}`);
                idx++;
              }
            }
          }
          console.log(`\nTotal: ${s.length} playable stream(s)`);
        }
      })
      .catch(e => { console.error('FATAL: ' + e.stack); process.exit(1); });
  }
}
