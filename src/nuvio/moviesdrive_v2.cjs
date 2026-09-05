// MoviesDrive (new3.moviesdrive.christmas) — Direct Stream Extractor v3
// =========================================================================
// Returns direct playable MKV streams up to 4K via Cloudflare workers /
// Google's video-downloads.googleusercontent.com CDN.
//
// REVERSE-ENGINEERED CHAIN (verified live with got-scraping):
//   1. TMDB lookup → title + IMDB ID
//   2. Search MoviesDrive via /search.php (Typesense backend)
//   3. Fetch movie/TV page → extract hubcloud.cx links + base64-encoded quality
//   4. Visit hubcloud.cx page → get fresh FROM_AC_TOKEN
//   5. Call hubcloud.cx API: ?api=search&q=<title> <quality>p → file list
//   6. Pick best file → fetch /drive/{fileId} page → extract gamerxyt URL
//   7. Visit gamerxyt.com → find pixel.hubcloud.cx URL (and/or pixeldrain.dev URL)
//   8. Follow pixel.hubcloud.cx → pixel.<name>.workers.dev → gamerxyt.com/dl.php
//      → final URL is video-downloads.googleusercontent.com (DIRECT MKV)
//
// PLAYABILITY:
//   - googleusercontent URLs DON'T support HTTP Range — DirectStream + AcerMovies
//     extractors route them through /range-proxy for Range translation
//     (so Stremio can seek).
//   - Cloudflare worker URLs (*.workers.dev) DO support Range natively —
//     play directly via /proxy with hubcloud.cx Referer.
//
// METADATA ENRICHMENT:
//   - height: 480/720/1080/2160
//   - codec: HEVC (x265) for 4K, x264 for lower quality — detected from filename
//   - sourceType: BluRay / WEB-DL — detected from filename
//   - HDR: HDR10 / DolbyVision — detected from filename
//   - audioLabel: Dual-Audio (Hindi+English) / Multi-Audio / Hindi / English /
//     Japanese (for anime) — detected from filename
//   - fileSize: bytes parsed from filename
//
// ANIME SUPPORT:
//   - Detects anime via TMDB genres (Animation=16, original_language=ja)
//   - Anime files typically have Japanese audio + multi-audio (Hindi/English dub)
//   - Detects "Dual Audio" / "Multi Audio" / "Sub" / "Dub" in filenames
//
// CRITICAL FIX vs upload/moviesdrive.js:
//   - Uses got-scraping instead of native https (CF bypass for hubcloud.cx)
//   - Follows pixel.hubcloud.cx redirect chain to final googleusercontent URL
//     (the upload returned stale pixeldrain URLs that 404'd)
//   - Skips verifyPlayable() — would fail on googleusercontent URLs because
//     they need /range-proxy for Range support
//   - Adds subtitles from OpenSubtitles (via StreamResolver fallback) +
//     in-file subtitle detection (ESub markers in filenames)

'use strict';

const PROVIDER_NAME = 'MoviesDrive';
const MAIN_URL = 'https://new3.moviesdrive.christmas';
const SEARCH_API = MAIN_URL + '/search.php';
const HUBCLOUD_BASE = 'https://hubcloud.cx';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Cache the got-scraping module
let _gotScraping = null;
async function getGotScraping() {
  if (_gotScraping) return _gotScraping;
  try {
    const mod = await import('got-scraping');
    _gotScraping = mod.gotScraping;
  } catch (e) {
    console.error('[MoviesDrive] Failed to load got-scraping:', e.message);
  }
  return _gotScraping;
}

// ─── HTTP helpers (got-scraping — bypasses Cloudflare) ─────────────────────
async function fetchText(url, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 15000;
  const gotScraping = await getGotScraping();
  if (!gotScraping) throw new Error('got-scraping unavailable');
  const headers = {
    'User-Agent': UA,
    'Accept': opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  };
  if (opts.referer) headers['Referer'] = opts.referer;
  if (opts.origin) headers['Origin'] = opts.origin;
  const res = await gotScraping(url, {
    headers,
    timeout: { request: timeout },
    throwHttpErrors: false,
    followRedirect: true,
    http2: true,
  });
  if (res.statusCode !== 200) {
    throw new Error(`HTTP ${res.statusCode} for ${url.slice(0, 80)}`);
  }
  return res.body;
}

async function fetchJson(url, opts) {
  const text = await fetchText(url, { ...opts, accept: 'application/json, text/javascript, */*; q=0.01' });
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON parse error: ${e.message}`);
  }
}

// Follow redirects WITHOUT auto-following — we need the Location headers
// to find the final googleusercontent.com URL.
// Chain: pixel.hubcloud.cx → 302 → pixel.<name>.workers.dev → 302 →
//        gamerxyt.com/dl.php?link=<googleusercontent_url>
// The gamerxyt.com/dl.php page returns 200 with HTML, but the actual
// playable video URL is in the ?link= query parameter.
async function fetchRedirectChain(url, maxHops) {
  maxHops = maxHops || 5;
  const gotScraping = await getGotScraping();
  if (!gotScraping) return null;
  let currentUrl = url;
  const referer = HUBCLOUD_BASE + '/';
  for (let i = 0; i < maxHops; i++) {
    let res;
    try {
      res = await gotScraping(currentUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,*/*',
          'Referer': referer,
        },
        timeout: { request: 10000 },
        throwHttpErrors: false,
        followRedirect: false,
        http2: true,
      });
    } catch (e) {
      return null;
    }
    // If redirect, follow
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      const next = res.headers.location.startsWith('http')
        ? res.headers.location
        : new URL(res.headers.location, currentUrl).toString();
      currentUrl = next;
      continue;
    }
    // If 200 — could be the final URL OR a gamerxyt.com/dl.php wrapper page
    if (res.statusCode === 200) {
      const parsed = (() => { try { return new URL(currentUrl); } catch { return null; } })();
      // gamerxyt.com/dl.php?link=<actual_video_url> — extract the link param
      if (parsed && parsed.hostname.includes('gamerxyt') && parsed.pathname.includes('dl.php')) {
        const link = parsed.searchParams.get('link');
        if (link && link.startsWith('http')) {
          return link;
        }
      }
      // Check body for embedded googleusercontent URL
      if (res.body) {
        const googleMatch = res.body.match(/https:\/\/video-downloads\.googleusercontent\.com\/[A-Za-z0-9_-]+/i);
        if (googleMatch) return googleMatch[0];
        const lh3Match = res.body.match(/https:\/\/lh3\.googleusercontent\.com\/[A-Za-z0-9_/-]+/i);
        if (lh3Match) return lh3Match[0];
      }
    }
    // Non-redirect, non-200, or no URL found — return current URL
    return currentUrl;
  }
  return currentUrl;
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
      genres: (j.genres || []).map(g => g.id),
      originalLanguage: j.original_language || '',
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

// ─── Detect audio language (incl. anime Japanese/dual-audio) ──────────────
function detectLanguage(text, isAnime) {
  const t = (text || '').toLowerCase();
  // Anime typically has Japanese + English/Hindi dual-audio
  if (isAnime) {
    if (t.includes('dual') || (t.includes('japanese') && (t.includes('english') || t.includes('hindi')))) return 'Dual-Audio';
    if (t.includes('multi')) return 'Multi-Audio';
    if (t.includes('english') || t.includes('dub')) return 'English (Dub)';
    if (t.includes('japanese') || t.includes('sub')) return 'Japanese (Sub)';
    return 'Japanese';
  }
  if (t.includes('multi')) return 'Multi-Audio';
  if (t.includes('dual'))  return 'Dual-Audio';
  if (t.includes('hindi') && (t.includes('english') || t.includes('eng'))) return 'Dual-Audio';
  if (t.includes('hindi')) return 'Hindi';
  if (t.includes('english') || t.includes('eng')) return 'English';
  if (t.includes('tamil') || t.includes('tam')) return 'Tamil';
  if (t.includes('telugu') || t.includes('tel')) return 'Telugu';
  return 'Multi-Audio';
}

// ─── Detect codec from filename ───────────────────────────────────────────
function detectCodec(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('x265') || t.includes('h265') || t.includes('hevc')) return 'HEVC';
  if (t.includes('x264') || t.includes('h264') || t.includes('avc')) return 'x264';
  if (t.includes('av1')) return 'AV1';
  // 4K typically uses HEVC
  if (t.includes('2160') || t.includes('4k')) return 'HEVC';
  return 'x264';
}

// ─── Detect source type from filename ─────────────────────────────────────
function detectSourceType(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('remux')) return 'BluRay Remux';
  if (t.includes('bluray') || t.includes('bdrip') || t.includes('brrip')) return 'BluRay';
  if (t.includes('web-dl') || t.includes('webdl')) return 'WebDL';
  if (t.includes('webrip')) return 'WebRip';
  if (t.includes('hdtv')) return 'HDTV';
  return 'WebDL';
}

// ─── Detect HDR from filename ─────────────────────────────────────────────
function detectHdr(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('dolby vision') || t.includes(' dv ') || t.includes('dovi')) return 'DolbyVision';
  if (t.includes('hdr10+')) return 'HDR10+';
  if (t.includes('hdr10')) return 'HDR10';
  if (t.includes('hdr')) return 'HDR';
  return '';
}

// ─── Detect file size from filename ───────────────────────────────────────
function detectSize(text) {
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

// ─── Get the hubcloud search query for a specific quality ──────────────────
function buildSearchQuery(title, qualityLabel) {
  let clean = title
    .replace(/^Download\s+/i, '')
    .replace(/\s*\(?\d{4}\)?\s*/g, ' ')
    .replace(/\s*\[.*?\]\s*/g, ' ')
    .replace(/\s*\{.*?\}\s*/g, ' ')
    .replace(/\s*(?:WEB-DL|BluRay|AMZN|WEBRip|HDRip|Dual Audio|Hindi Dubbed|English)\s.*/i, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:GB|MB)\b.*/i, '')
    .trim();
  const qNum = qualityLabel.match(/\d+/)?.[0] || '';
  if (qNum) clean += ` ${qNum}p`;
  return clean;
}

// ─── Fetch movie page and extract download links ──────────────────────────
async function getDownloadLinks(permalink, season, episode) {
  const url = permalink.startsWith('http') ? permalink : (MAIN_URL + permalink);
  const html = await fetchText(url, { referer: MAIN_URL + '/' });

  const decoded = html.replace(/&amp;/g, '&').replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
                      .replace(/&#039;/g, "'").replace(/&#x27;/g, "'")
                      .replace(/&nbsp;/g, ' ').replace(/&#8211;/g, '-')
                      .replace(/&ndash;/g, '-').replace(/&mdash;/g, '-');

  const links = [];

  // Pattern 1: hubcloud search-recover links (movie format)
  const re = /<a[^>]+href="(https:\/\/hubcloud\.[a-z]+\/drive\/search-recover\.php\?from_ac=[A-Za-z0-9_-]+(?:&q=[A-Za-z0-9+/=_-]+)?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(decoded)) !== null) {
    const url = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (text) links.push({ url, text, type: 'movie' });
  }

  // Pattern 2: mdrive.lol archive links (movie AND TV format)
  // Movies also use mdrive.lol for some titles (e.g. Your Name)
  // Each mdrive.lol URL is a quality-specific archive page containing episode links
  const mdriveRe = /<a[^>]+href="(https:\/\/mdrive\.lol\/archive\/\d+\/?)"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let mm;
  while ((mm = mdriveRe.exec(decoded)) !== null) {
    const text = mm[2].replace(/<[^>]+>/g, '').trim();
    // Parse quality from text (e.g. "1080p_10BIT_HEVC [1.72 GB]" or "480p [445.57 MB]")
    const qMatch = text.match(/(\d{3,4})p/);
    const quality = qMatch ? `${qMatch[1]}p` : (text.includes('4k') ? '2160p' : '720p');
    // Detect codec from text (e.g. "1080p_10BIT_HEVC" → HEVC)
    const isHevc = /hevc|x265|h265|10bit/i.test(text);
    const isX264 = /x264|h264/i.test(text);
    links.push({
      url: mm[1],
      text,
      quality,
      type: 'mdrive',  // mdrive.lol archive (used for both movies and TV)
      codec: isHevc ? 'HEVC' : (isX264 ? 'x264' : null),
      // For TV: season is set below; for movies: season stays undefined
      season: season ? parseInt(season) : undefined,
    });
  }

  // For TV shows: assign mdrive.lol URLs to seasons using season markers
  if (season) {
    // Walk through HTML and track season markers
    const markers = [];
    const seasonRe = /(?:Season\s+(\d+)|S(\d{2})|SEASON\s+(\d+)|\[Season\s+(\d+)\])/gi;
    let sm;
    while ((sm = seasonRe.exec(decoded)) !== null) {
      const seasonNum = sm[1] || sm[2] || sm[3] || sm[4];
      if (seasonNum) {
        const num = parseInt(seasonNum);
        if (num >= 1 && num <= 50) {
          markers.push({ pos: sm.index, season: num });
        }
      }
    }
    // Mark mdrive.lol positions (already in links array, but we need positions)
    const mdrivePositions = [];
    const mdriveRe2 = /href="(https:\/\/mdrive\.lol\/archive\/\d+\/?)"[^>]*>([\s\S]{0,100}?)<\/a>/gi;
    let mm2;
    while ((mm2 = mdriveRe2.exec(decoded)) !== null) {
      const text = mm2[2].replace(/<[^>]+>/g, '').trim();
      // Only "Single Episode" links (skip "Zip" archives) for TV
      if (text.toLowerCase().includes('single episode')) {
        mdrivePositions.push({ pos: mm2.index, url: mm2[1], text });
      }
    }
    markers.sort((a, b) => a.pos - b.pos);
    mdrivePositions.sort((a, b) => a.pos - b.pos);

    // Assign each mdrive.lol URL to its most recent season
    let currentSeason = null;
    const allMarkers = [...markers, ...mdrivePositions.map(p => ({ pos: p.pos, ...p }))].sort((a, b) => a.pos - b.pos);
    for (const marker of allMarkers) {
      if (marker.season !== undefined && !marker.url) {
        currentSeason = marker.season;
      } else if (marker.url && currentSeason === parseInt(season)) {
        // Update the corresponding link in the links array
        const link = links.find(l => l.url === marker.url && l.type === 'mdrive');
        if (link) {
          link.type = 'tv';
          link.season = currentSeason;
        }
      }
    }
    // Remove mdrive.lol links that didn't match the requested season
    for (let i = links.length - 1; i >= 0; i--) {
      if (links[i].type === 'mdrive' && links[i].season === undefined) {
        // For TV: keep only links that matched the season
        // (mdrive.lol links without season assignment are removed for TV)
        // BUT for movies: mdrive.lol links have type='mdrive' and should be kept
        // Only remove if this is a TV request (season != null)
        links.splice(i, 1);
      }
    }
  }

  return links;
}

// ─── Resolve TV episode from mdrive.lol archive page ──────────────────────
async function resolveTvEpisode(mdriveUrl, season, episode, quality) {
  const html = await fetchText(mdriveUrl, { referer: MAIN_URL + '/' });

  const decoded = html.replace(/&amp;/g, '&').replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>').replace('&quot;', '"')
                      .replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '-')
                      .replace(/&#8211;/g, '-');

  const markers = [];
  // Episode markers — multiple formats
  const epRe = /<span[^>]*color:\s*#ff0000[^>]*>(Ep\d+|Episode\s*\d+|E\d+)<\/span>/gi;
  let em;
  while ((em = epRe.exec(decoded)) !== null) {
    const epText = em[1];
    const epNumMatch = epText.match(/(\d+)/);
    if (epNumMatch) {
      markers.push({ pos: em.index, episode: parseInt(epNumMatch[1]), epText });
    }
  }
  // Also look for episode markers in other formats (not just red spans)
  // e.g. <strong>Ep01</strong> or just "Ep01" in text
  const epRe2 = /(?:>|\s)(Ep\d+|Episode\s*\d+)(?:<|\s)/gi;
  let em2;
  while ((em2 = epRe2.exec(decoded)) !== null) {
    const epText = em2[1];
    const epNumMatch = epText.match(/(\d+)/);
    if (epNumMatch) {
      const epNum = parseInt(epNumMatch[1]);
      // Don't add duplicates
      if (!markers.some(m => m.episode === epNum && Math.abs(m.pos - em2.index) < 100)) {
        markers.push({ pos: em2.index, episode: epNum, epText });
      }
    }
  }

  // hubcloud.cx URL markers — use larger limit (500 chars) to handle <img> inside <a>
  // (mdrive.lol pages use image buttons instead of text links)
  const urlRe = /href="(https:\/\/hubcloud\.cx\/drive\/[A-Za-z0-9_]+)"[^>]*>([\s\S]{0,500}?)<\/a>/gi;
  let um;
  while ((um = urlRe.exec(decoded)) !== null) {
    const linkText = um[2].replace(/<[^>]+>/g, '').trim();
    markers.push({ pos: um.index, url: um[1], type: 'url', linkText });
  }
  // Fallback: if no </a> found, just find bare URLs (some pages don't close <a>)
  if (!markers.some(m => m.type === 'url')) {
    const bareRe = /href="(https:\/\/hubcloud\.cx\/drive\/[A-Za-z0-9_]+)"/gi;
    let bm;
    while ((bm = bareRe.exec(decoded)) !== null) {
      markers.push({ pos: bm.index, url: bm[1], type: 'url', linkText: '' });
    }
  }
  markers.sort((a, b) => a.pos - b.pos);

  let currentEp = null;
  let currentEpText = null;
  for (const marker of markers) {
    if (marker.episode !== undefined) {
      currentEp = marker.episode;
      currentEpText = marker.epText;
    } else if (marker.type === 'url' && currentEp === parseInt(episode)) {
      const fileId = marker.url.match(/\/drive\/([A-Za-z0-9_]+)/)?.[1];
      if (fileId) {
        // Build a descriptive filename from the link text + episode info
        const fileName = marker.linkText || `${currentEpText || 'E' + episode} ${quality}`;
        return { fileId, fileUrl: marker.url, quality, fileName };
      }
    }
  }

  // Fallback: if no episode markers found, try the FIRST hubcloud.cx link
  // (for movies on mdrive.lol, there's typically just one file)
  const firstUrl = markers.find(m => m.type === 'url');
  if (firstUrl) {
    const fileId = firstUrl.url.match(/\/drive\/([A-Za-z0-9_]+)/)?.[1];
    if (fileId) {
      console.log(`[MoviesDrive]   ⚠ No episode marker found, using first file on page`);
      const fileName = firstUrl.linkText || `Movie ${quality}`;
      return { fileId, fileUrl: firstUrl.url, quality, fileName };
    }
  }

  return null;
}

// ─── Get a fresh FROM_AC_TOKEN from the hubcloud.cx page ──────────────────
async function getFromAcToken(hubcloudUrl) {
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

  let gamerUrl = null;
  const varUrlMatch = html.match(/var\s+url\s*=\s*'([^']+)'/);
  if (varUrlMatch) gamerUrl = varUrlMatch[1];
  if (!gamerUrl) {
    const aHrefMatch = html.match(/href="(https:\/\/gamerxyt\.com\/hubcloud\.php\?[^"]+)"/i);
    if (aHrefMatch) gamerUrl = aHrefMatch[1];
  }

  const result = { fileId };

  // File metadata from page
  const sizeMatch = html.match(/File Size[^<]*<i[^>]*>([^<]+)<\/i>/i);
  if (sizeMatch) result.size = sizeMatch[1].trim();
  const typeMatch = html.match(/File Type[^<]*<i[^>]*>([^<]+)<\/i>/i);
  if (typeMatch) result.mimeType = typeMatch[1].trim();

  // Fetch gamerxyt bridge page to find pixel.hubcloud.cx URL
  if (gamerUrl) {
    console.log(`[MoviesDrive]     Following gamerxyt bridge...`);
    try {
      const gamerHtml = await fetchText(gamerUrl, { referer: HUBCLOUD_BASE + '/' });

      // pixel.hubcloud.cx URL → redirects to googleusercontent (preferred — Range via /range-proxy)
      const pixelMatch = gamerHtml.match(/https:\/\/pixel\.hubcloud\.cx\/\?id=[A-Za-z0-9:_-]+/i);
      if (pixelMatch) {
        result.pixelUrl = pixelMatch[0];
      }

      // Cloudflare worker direct URL (already plays with Range natively)
      if (!result.workerUrl) {
        const workerMatch = gamerHtml.match(
          /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/[A-Za-z0-9:_/-]+\/\d+\/[^"'\s<>]+/i
        );
        if (workerMatch) {
          result.workerUrl = workerMatch[0].replace(/&amp;/g, '&');
        }
      }

      // PixelDrain mirror (sometimes available)
      if (!result.pixeldrainUrl) {
        const pdMatch2 = gamerHtml.match(/https:\/\/pixeldrain\.[a-z]+\/u\/([A-Za-z0-9]+)/i);
        if (pdMatch2) {
          result.pixeldrainId = pdMatch2[1];
          result.pixeldrainUrl = `https://pixeldrain.dev/api/file/${pdMatch2[1]}`;
        }
      }

      // GPDL URL (10Gbps server)
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

// ─── Follow pixel.hubcloud.cx redirect chain to final googleusercontent URL ─
// Chain: pixel.hubcloud.cx → 302 → pixel.<name>.workers.dev → 302 →
//        gamerxyt.com/dl.php?link=<googleusercontent_url>
// The final googleusercontent URL is the DIRECT playable MKV.
async function resolvePixelToDirect(pixelUrl) {
  return await fetchRedirectChain(pixelUrl, 5);
}

// ─── Build Stremio stream object ──────────────────────────────────────────
function buildStream(url, info, quality, language, source, size, fileName, isAnime) {
  const isHls = url.includes('.m3u8');
  const isMkv = url.includes('googleusercontent') || url.includes('pixeldrain') ||
                url.includes('matroska') || url.includes('.mkv') || url.includes('workers.dev');

  // Enriched metadata from filename
  const fullText = `${fileName} ${info.title} ${quality} ${language}`;
  const codec = detectCodec(fullText);
  const sourceType = detectSourceType(fullText);
  const hdr = detectHdr(fullText);
  const sizeInfo = detectSize(fullText) || (size ? { raw: size } : null);
  const fileSizeBytes = sizeInfo ? sizeInfo.bytes : undefined;

  // Subtitles detection from filename (ESub = English subtitles embedded)
  const hasSubs = /esub|subs?|english\s*sub/i.test(fullText);

  const titleSuffix = sizeInfo ? ` [${sizeInfo.raw}]` : '';
  const audioTag = isAnime ? `[${language}]` : `[${language}]`;
  const hdrTag = hdr ? ` ${hdr}` : '';

  return {
    name: `${PROVIDER_NAME} | ${quality} | ${language} | ${source}`,
    title: `${info.title}${info.year ? ` (${info.year})` : ''}${titleSuffix} [MoviesDrive ${quality} ${sourceType} ${codec}${hdrTag} ${language}]`,
    url,
    quality,
    type: isHls ? 'application/vnd.apple.mpegurl'
                : (isMkv ? 'video/x-matroska' : 'video/mp4'),
    behaviorHints: {
      bingeGroup: `moviesdrive-${quality.toLowerCase()}-${source}`,
      proxyHeaders: {
        request: {
          'User-Agent': UA,
          'Referer': url.includes('pixeldrain') ? 'https://pixeldrain.dev/'
                    : url.includes('googleusercontent') ? 'https://gamerxyt.com/'
                    : HUBCLOUD_BASE + '/',
        },
      },
    },
    // Enriched metadata (parsed by ESM wrapper)
    _codec: codec,
    _sourceType: sourceType,
    _hdr: hdr,
    _fileSize: fileSizeBytes,
    _isAnime: isAnime,
    _hasSubs: hasSubs,
    _fileName: fileName,
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isTV = type === 'tv' || type === 'series';
  console.log(`[MoviesDrive] Request: tmdb=${tmdbId} type=${type}` +
              (isTV ? ` S${season}E${episode}` : ''));

  // 1. Get TMDB info (with genres for anime detection)
  const info = await getTMDBInfo(tmdbId, type);
  if (!info) {
    console.log('[MoviesDrive] TMDB fetch failed');
    return [];
  }
  // Detect anime: Animation genre (16) or Japanese original language
  const isAnime = (info.genres || []).includes(16) || info.originalLanguage === 'ja';
  console.log(`[MoviesDrive] TMDB: ${info.title}${info.year ? ` (${info.year})` : ''}` +
              ` IMDB: ${info.imdbId || 'N/A'}${isAnime ? ' [ANIME]' : ''}`);

  // 2. Search MoviesDrive by title (IMDB search returns wrong fuzzy matches)
  let searchResults = await searchMoviesdrive(info.title, 10);
  if (searchResults.length === 0 && info.imdbId) {
    searchResults = await searchMoviesdrive(info.imdbId, 10);
  }
  if (searchResults.length === 0) {
    console.log('[MoviesDrive] No search results');
    return [];
  }
  console.log(`[MoviesDrive] Found ${searchResults.length} search result(s)`);

  // Pick best match
  let best = null;
  if (info.imdbId) {
    best = searchResults.find(r => r.imdbId === info.imdbId);
  }
  if (!best) {
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
    const language = detectLanguage(link.text + ' ' + best.title, isAnime);

    if (seenQualities.has(quality)) continue;
    seenQualities.add(quality);

    console.log(`[MoviesDrive] Resolving ${quality} ${language}...`);
    try {
      let fileId = null;
      let fileName = '';

      if (link.type === 'tv' || link.type === 'mdrive') {
        // TV show OR movie on mdrive.lol: link.url is a mdrive.lol archive page
        // For TV: resolve specific episode
        // For movies: the archive page has a single file (or episode 1)
        console.log(`[MoviesDrive]   Resolving from mdrive.lol archive...`);
        const epInfo = await resolveTvEpisode(link.url, season || 1, episode || 1, quality);
        if (!epInfo) {
          console.log(`[MoviesDrive]   ✗ Could not find episode ${episode || 1} on archive page`);
          continue;
        }
        fileId = epInfo.fileId;
        fileName = epInfo.fileName || `S${season || 1}E${episode || 1} ${quality}`;
        console.log(`[MoviesDrive]   ✓ File ID: ${fileId}`);
      } else {
        // Movie or TV: link.url is a hubcloud search-recover URL
        // For TV shows, the search returns individual episodes — filter by
        // episode number when season/episode are specified.
        const token = await getFromAcToken(link.url);
        console.log(`[MoviesDrive]   ✓ Token: ${token.slice(0, 30)}...`);

        // IMPORTANT: Use info.title (clean TMDB title like "Naruto" or "Inception")
        // NOT best.title (which is the full page title like "Download Naruto
        // (Season 1 - 9) Hindi Dubbed Complete Anime WEB Series 480p | 720p")
        // The long title makes hubcloud fuzzy matching return wrong files.
        const titleClean = info.title
          .replace(/^Download\s+/i, '')
          .replace(/\s*\(?\d{4}\)?\s*/g, ' ')
          .replace(/\s*\[.*?\]\s*/g, ' ')
          .replace(/\s*\{.*?\}\s*/g, ' ')
          .replace(/\s*(?:WEB-DL|BluRay|AMZN|WEBRip|HDRip).*$/i, '')
          .replace(/\s*\(Season.*$/i, '') // strip "(Season 1-9)" from TV titles
          .replace(/\s*Complete.*$/i, '') // strip "Complete Anime WEB Series"
          .trim();
        const qNum = quality.replace('p', '');
        const searchQ = `${titleClean} ${qNum}p`;
        console.log(`[MoviesDrive]   Searching hubcloud for: "${searchQ}"`);

        const hits = await searchHubcloud(token, searchQ);
        if (hits.length === 0) {
          console.log(`[MoviesDrive]   ✗ No files found in hubcloud search`);
          continue;
        }

        // Pick the best match — prefer the one with the right quality in the filename
        // AND that mentions the title (avoids picking unrelated files from same search)
        const titleLower = titleClean.toLowerCase();
        const titleFirstWord = titleLower.split(/\s+/)[0];
        let qualityHits = hits.filter(h => {
          const fn = (h.file_name || '').toLowerCase();
          const hasQuality = fn.includes(qNum) ||
                            (quality === '2160p' && fn.includes('4k'));
          const hasTitle = fn.includes(titleLower) ||
                          (titleFirstWord.length > 3 && fn.includes(titleFirstWord));
          return hasQuality && hasTitle;
        });

        // For TV shows with episodes: filter by episode number
        // Filename format: "Naruto Shippuden - E360 .1080p BD x264 Multi Audio. AAC 2.0 ESub-MoviesDrives.CV.mkv"
        // or "Naruto S01E01 ... 1080p ..."
        let target = null;
        if (season != null && episode != null) {
          const epNum = parseInt(episode, 10);
          // Look for episode markers: E01, E001, Ep01, Episode 1, S01E01, S1E1
          const epRegexes = [
            new RegExp(`[sS]0?${season}[eE]0?${epNum}\\b`),  // S01E01
            new RegExp(`\\b[eE]p?0?${epNum}\\b`),             // E01, Ep01
            new RegExp(`\\b[eE]${epNum}\\b`),                  // E1 (no leading zero)
            new RegExp(`Episode\\s+${epNum}\\b`, 'i'),         // Episode 1
          ];
          const epMatches = qualityHits.filter(h => {
            const fn = h.file_name || '';
            return epRegexes.some(re => re.test(fn));
          });
          if (epMatches.length > 0) {
            target = epMatches[0];
            console.log(`[MoviesDrive]   ✓ Matched episode ${epNum}: ${target.file_name.slice(0, 60)}`);
          } else {
            console.log(`[MoviesDrive]   ⚠ No episode ${epNum} match, using first quality hit`);
          }
        }
        if (!target) {
          target = qualityHits[0] || hits[0];
        }
        fileName = target.file_name || '';
        console.log(`[MoviesDrive]   ✓ Found: ${fileName.slice(0, 60)}`);

        fileId = target.url.match(/\/drive\/([A-Za-z0-9_]+)/)?.[1];
      }

      if (!fileId) {
        console.log(`[MoviesDrive]   ✗ Could not extract file ID`);
        continue;
      }

      // Step 4c: Resolve the file URL to direct download URLs
      const resolved = await resolveFileUrl(fileId, fileName);
      if (!resolved.pixelUrl && !resolved.gpdlUrl && !resolved.workerUrl && !resolved.pixeldrainUrl) {
        console.log(`[MoviesDrive]   ✗ No playable URL found on file page`);
        continue;
      }

      // Prefer pixel.hubcloud.cx (→ googleusercontent — direct MKV, plays via /range-proxy)
      // Then Cloudflare worker (*.workers.dev — Range native)
      // Then PixelDrain (sometimes stale — use as last resort)
      // Then GPDL (10Gbps server)
      let playUrl = null;
      let source = null;
      if (resolved.pixelUrl) {
        console.log(`[MoviesDrive]   Following pixel.hubcloud.cx redirect chain...`);
        const finalUrl = await resolvePixelToDirect(resolved.pixelUrl);
        if (finalUrl && (finalUrl.includes('googleusercontent.com') || finalUrl.includes('workers.dev'))) {
          playUrl = finalUrl;
          source = 'GDrive';
          console.log(`[MoviesDrive]   ✓ Resolved: ${playUrl.slice(0, 80)}...`);
        }
      }
      if (!playUrl && resolved.workerUrl) {
        playUrl = resolved.workerUrl;
        source = 'Cloudflare-Worker';
      }
      if (!playUrl && resolved.pixeldrainUrl) {
        playUrl = resolved.pixeldrainUrl;
        source = 'PixelDrain';
      }
      if (!playUrl && resolved.gpdlUrl) {
        playUrl = resolved.gpdlUrl;
        source = 'HubCloud-10Gbps';
      }
      if (!playUrl) {
        console.log(`[MoviesDrive]   ✗ Could not resolve to a playable URL`);
        continue;
      }
      console.log(`[MoviesDrive]   ✓ ${source}: ${playUrl.slice(0, 80)}...`);

      allStreams.push(buildStream(playUrl, info, quality, language, source, resolved.size || '', fileName, isAnime));
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
  resolvePixelToDirect,
  MAIN_URL,
};

// ─── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('MoviesDrive Direct Stream Extractor v3 (4K playable, got-scraping)');
    console.log('Usage: node moviesdrive.js <tmdbId> <movie|tv> [season] [episode]');
    process.exit(1);
  }
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
        s.forEach((x, i) => {
          console.log(`${i+1}. ${x.name}`);
          console.log(`   URL: ${x.url.slice(0, 150)}${x.url.length > 150 ? '...' : ''}`);
          console.log(`   Title: ${x.title.slice(0, 100)}`);
        });
        console.log(`\nTotal: ${s.length} playable stream(s)`);
      }
    })
    .catch(e => console.error('FATAL: ' + e.stack));
}
