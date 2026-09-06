// MultiMovies (multimovies.beer) — DooPlay WordPress scraper
// =========================================================================
// Returns embed URLs for movies, TV shows, and anime (up to 4K).
//
// REVERSE-ENGINEERED CHAIN:
//   1. Search: GET /?s={title}&post_type={movie|tv}
//      → Parse results for /movies/{slug}/ or /tvshows/{slug}/ URLs
//   2. Movie page: GET /movies/{slug}/ → extract data-post, linksnonce
//   3. TV show page: GET /tvshows/{slug}/ → extract /episodes/{slug}-{s}x{e}/ URLs
//   4. Episode page: GET /episodes/{slug}/ → extract data-post, linksnonce
//   5. Player API: POST /wp-admin/admin-ajax.php
//      Body: action=doo_player_ajax&post={id}&nume={n}&type={type}&linksnonce={nonce}
//      → Returns { embed_url: "...", type: "iframe" }
//   6. Embed URL hosts (4 servers per title):
//      - rozgarlelo.modiplay.xyz/embed/imdb/{type}?id={imdb}
//      - streams.iqsmartgames.com/embed/{type}/{imdb}?key={key}
//      - screenscape.me/embed?imdb={imdb}&type={type}&lan={lang}
//      - nxsha.space/embed/{type}/{imdb}
//
// iqsmartgames API (for file list + quality detection):
//   GET /mymovieapi?imdbid={imdb}&key={key}
//   → Returns { success, data: [{ filename, fileslug, fsize }] }
//   File names contain quality info: "1080p", "2160p", "4K", "HEVC", "H265", etc.
//
// EMBED RESOLUTION:
//   The embed URLs are iframe embeds that require browser JS to play.
//   We return them as stream entries — Stremio's built-in player or
//   EmbedResolver/ExternalUrl will handle them.
//   For iqsmartgames, we also fetch the file list to detect quality (4K/1080p/720p)
//   and return each file as a separate stream entry with the embed URL.
//
// ENRICHED METADATA:
//   - height: 480/720/1080/2160 (from filename)
//   - codec: HEVC (x265) / x264 (from filename)
//   - sourceType: WEB-DL / BluRay (from filename)
//   - audioLabel: Multi Audio / Dual Audio / Hindi / English / Japanese (anime)
//   - fileSize: from API response
//
// ANIME SUPPORT:
//   - Detects anime via TMDB genres (Animation=16) or original_language=ja
//   - Anime files typically have "Multi Audio" or "Hindi + English + Japanese"
//   - Sub/Dub: the embeds contain both sub and dub versions (language tracks in player)

'use strict';

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const BASE_URL = 'https://multimovies.beer';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Cache got-scraping
let _gotScraping = null;
async function getGot() {
  if (_gotScraping) return _gotScraping;
  try {
    const mod = await import('got-scraping');
    _gotScraping = mod.gotScraping;
  } catch (e) {
    console.error('[MultiMovies] Failed to load got-scraping:', e.message);
  }
  return _gotScraping;
}

async function fetchText(url, referer, timeout) {
  const got = await getGot();
  if (!got) throw new Error('got-scraping unavailable');
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/json,*/*',
    'Accept-Language': 'en-US,en;q=0.5',
  };
  if (referer) headers['Referer'] = referer;
  const res = await got(url, {
    headers,
    timeout: { request: timeout || 15000 },
    throwHttpErrors: false,
    followRedirect: true,
    http2: true,
  });
  if (res.statusCode !== 200) {
    throw new Error(`HTTP ${res.statusCode} for ${url.slice(0, 80)}`);
  }
  return res.body;
}

async function fetchJson(url, referer, timeout) {
  const got = await getGot();
  if (!got) throw new Error('got-scraping unavailable');
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json,*/*',
  };
  if (referer) headers['Referer'] = referer;
  const res = await got(url, {
    headers,
    timeout: { request: timeout || 15000 },
    throwHttpErrors: false,
    followRedirect: true,
    http2: true,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

async function postForm(url, body, referer) {
  const got = await getGot();
  if (!got) throw new Error('got-scraping unavailable');
  const headers = {
    'User-Agent': UA,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json,*/*',
  };
  if (referer) headers['Referer'] = referer;
  const res = await got.post(url, {
    headers,
    body,
    timeout: { request: 15000 },
    throwHttpErrors: false,
    http2: true,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

// ─── TMDB info (with genres for anime detection) ──────────────────────────
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
    console.log(`[MultiMovies] TMDB lookup failed: ${e.message}`);
    return null;
  }
}

// ─── Search multimovies.beer ──────────────────────────────────────────────
async function searchMultiMovies(query, postType) {
  // postType: 'movie' or 'tv' (for filtering)
  const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
  try {
    const html = await fetchText(searchUrl, BASE_URL + '/');
    const results = [];

    // Find movie URLs: /movies/{slug}/
    const movieRe = /href="(https:\/\/multimovies\.beer\/movies\/[^"]+)"/gi;
    let m;
    while ((m = movieRe.exec(html)) !== null) {
      const url = m[1];
      const slug = url.match(/\/movies\/([^/]+)/)?.[1] || '';
      const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      if (!results.some(r => r.url === url)) {
        results.push({ url, slug, title, type: 'movie' });
      }
    }

    // Find TV show URLs: /tvshows/{slug}/
    const tvRe = /href="(https:\/\/multimovies\.beer\/tvshows\/[^"]+)"/gi;
    while ((m = tvRe.exec(html)) !== null) {
      const url = m[1];
      const slug = url.match(/\/tvshows\/([^/]+)/)?.[1] || '';
      const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      if (!results.some(r => r.url === url)) {
        results.push({ url, slug, title, type: 'tv' });
      }
    }

    return results;
  } catch (e) {
    console.log(`[MultiMovies] Search failed: ${e.message}`);
    return [];
  }
}

// ─── Extract data-post + linksnonce from a page ───────────────────────────
function extractPlayerData(html) {
  const dataPostMatch = html.match(/data-id="(\d+)"/);
  const linksnonceMatch = html.match(/"linksnonce":"([^"]+)"/);
  const playerApiMatch = html.match(/"player_api":"([^"]+)"/);

  // Find all player options (data-post, data-type, data-nume)
  // The attributes can appear in ANY order, so we match the full <li> element
  const options = [];
  const liRe = /<li[^>]*class=['"]dooplay_player_option['"][^>]*>/gi;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const liTag = m[0];
    const postMatch = liTag.match(/data-post=['"](\d+)['"]/);
    const typeMatch = liTag.match(/data-type=['"]([^'"]+)['"]/);
    const numeMatch = liTag.match(/data-nume=['"]([^'"]+)['"]/);
    if (postMatch && typeMatch && numeMatch) {
      options.push({ post: postMatch[1], type: typeMatch[1], nume: numeMatch[1] });
    }
  }

  return {
    postId: dataPostMatch?.[1] || (options[0]?.post) || null,
    linksnonce: linksnonceMatch?.[1] || null,
    playerApi: playerApiMatch?.[1] || null,
    options,
  };
}

// ─── Extract episode URLs from TV show page ───────────────────────────────
function extractEpisodes(html, season, episode) {
  // Episode URLs: /episodes/{slug}-{season}x{episode}
  // Can be relative (/episodes/naruto-1x1) or absolute (https://multimovies.beer/episodes/naruto-1x1)
  const target = `${season}x${episode}`;
  // Match both relative and absolute URLs containing /episodes/...{season}x{episode}
  const epRe = new RegExp(`(?:href=["'])(https://multimovies\\.beer)?/episodes/([^"']*/?)${target}([^"']*)["']`, 'gi');
  const matches = [...html.matchAll(epRe)];
  if (matches.length > 0) {
    const prefix = matches[0][1] || BASE_URL;
    const path = matches[0][2] + target + matches[0][3];
    return `${prefix}/episodes/${path}`;
  }
  // Fallback: find any /episodes/ URL containing the target
  const allEpRe = /(?:href=["'])(https:\/\/multimovies\.beer)?\/episodes\/([^"']+)/gi;
  const allMatches = [...html.matchAll(allEpRe)];
  for (const m of allMatches) {
    if (m[2].includes(target)) {
      const prefix = m[1] || BASE_URL;
      return `${prefix}/episodes/${m[2]}`;
    }
  }
  return null;
}

// ─── Get embed URLs from DooPlay API ──────────────────────────────────────
async function getEmbedUrls(postId, type, linksnonce, numeList) {
  const embedUrls = [];
  const referer = `${BASE_URL}/`;

  for (const nume of numeList) {
    // Skip trailer — it's just a YouTube embed, not the actual movie
    if (nume === 'trailer') continue;
    try {
      const body = `action=doo_player_ajax&post=${postId}&nume=${nume}&type=${type}&linksnonce=${linksnonce}`;
      const data = await postForm(`${BASE_URL}/wp-admin/admin-ajax.php`, body, referer);
      if (data?.embed_url) {
        // Clean up the embed URL — some responses contain HTML tags like <IFRAME SRC="...">
        let url = data.embed_url;
        // Extract URL from <IFRAME SRC="..."> if present
        const iframeMatch = url.match(/SRC=["']([^"']+)["']/i);
        if (iframeMatch) {
          url = iframeMatch[1];
        }
        // Decode HTML entities
        url = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                 .replace(/&quot;/g, '"').replace(/&#039;/g, "'");
        // Skip if it's not a valid URL
        if (!url.startsWith('http')) {
          console.log(`[MultiMovies]   Server ${nume}: invalid URL, skipping`);
          continue;
        }
        embedUrls.push({ nume, embed_url: url, type: data.type || 'iframe' });
        console.log(`[MultiMovies]   Server ${nume}: ${url.slice(0, 80)}...`);
      }
    } catch (e) {
      console.log(`[MultiMovies]   Server ${nume} failed: ${e.message}`);
    }
  }

  return embedUrls;
}

// ─── Fetch file list from iqsmartgames API ────────────────────────────────
async function fetchFileList(imdbId, key) {
  if (!imdbId || !key) return [];
  try {
    const url = `https://streams.iqsmartgames.com/mymovieapi?imdbid=${imdbId}&key=${key}`;
    const data = await fetchJson(url, 'https://streams.iqsmartgames.com/');
    if (data?.success && Array.isArray(data.data)) {
      return data.data;
    }
  } catch (e) {
    console.log(`[MultiMovies] iqsmartgames API failed: ${e.message}`);
  }
  return [];
}

// ─── Extract key from iqsmartgames embed URL ──────────────────────────────
function extractIqsKey(embedUrl) {
  try {
    const u = new URL(embedUrl);
    return u.searchParams.get('key') || '';
  } catch { return ''; }
}

// ─── Detect quality from filename ─────────────────────────────────────────
function detectQuality(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('2160') || t.includes('4k') || t.includes('uhd')) return '2160p';
  if (t.includes('1080')) return '1080p';
  if (t.includes('720')) return '720p';
  if (t.includes('480')) return '480p';
  return '1080p';
}

function detectHeight(q) {
  const s = String(q).toLowerCase();
  if (s.includes('2160') || s.includes('4k')) return 2160;
  if (s.includes('1080')) return 1080;
  if (s.includes('720')) return 720;
  if (s.includes('480')) return 480;
  return 1080;
}

function detectCodec(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('x265') || t.includes('h265') || t.includes('hevc')) return 'HEVC';
  if (t.includes('x264') || t.includes('h264') || t.includes('avc')) return 'x264';
  if (t.includes('2160') || t.includes('4k')) return 'HEVC';
  return 'x264';
}

function detectSourceType(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('remux')) return 'BluRay Remux';
  if (t.includes('bluray') || t.includes('bdrip') || t.includes('brrip')) return 'BluRay';
  if (t.includes('web-dl') || t.includes('webdl')) return 'WebDL';
  if (t.includes('webrip')) return 'WebRip';
  if (t.includes('hdtv')) return 'HDTV';
  if (t.includes('hdtc')) return 'HDTC';
  return 'WebDL';
}

function detectLanguage(text, isAnime) {
  const t = (text || '').toLowerCase();
  if (isAnime) {
    if (t.includes('multi') || (t.includes('japanese') && (t.includes('hindi') || t.includes('english')))) return 'Multi Audio (Sub+Dub)';
    if (t.includes('japanese')) return 'Japanese (Sub)';
    if (t.includes('english') || t.includes('dub')) return 'English (Dub)';
    return 'Japanese';
  }
  if (t.includes('multi')) return 'Multi Audio';
  if (t.includes('dual') || (t.includes('hindi') && t.includes('english'))) return 'Dual Audio';
  if (t.includes('hindi')) return 'Hindi';
  if (t.includes('english')) return 'English';
  if (t.includes('tamil')) return 'Tamil';
  if (t.includes('telugu')) return 'Telugu';
  return 'Multi Audio';
}

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

// ─── Main entry point ─────────────────────────────────────────────────────
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isTV = type === 'tv' || type === 'series';
  console.log(`[MultiMovies] Request: tmdb=${tmdbId} type=${type}` +
              (isTV ? ` S${season}E${episode}` : ''));

  // 1. Get TMDB info
  const info = await getTMDBInfo(tmdbId, type);
  if (!info) {
    console.log('[MultiMovies] TMDB fetch failed');
    return [];
  }
  const isAnime = (info.genres || []).includes(16) || info.originalLanguage === 'ja';
  console.log(`[MultiMovies] TMDB: ${info.title}${info.year ? ` (${info.year})` : ''}` +
              ` IMDB: ${info.imdbId || 'N/A'}${isAnime ? ' [ANIME]' : ''}`);

  // 2. Search multimovies.beer
  // Use a clean search query — strip special chars and use first few words
  // (TMDB titles like "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train"
  // are too long and return wrong results)
  const cleanTitle = info.title
    .replace(/[':;,.!?()]/g, ' ')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const searchQuery = cleanTitle.split(/\s+/).slice(0, 4).join(' ');
  console.log(`[MultiMovies] Searching for: "${searchQuery}"`);
  const searchResults = await searchMultiMovies(searchQuery);
  if (searchResults.length === 0) {
    console.log('[MultiMovies] No search results, trying full title');
    const retryResults = await searchMultiMovies(cleanTitle);
    if (retryResults.length === 0) {
      console.log('[MultiMovies] No search results');
      return [];
    }
    searchResults.push(...retryResults);
  }
  console.log(`[MultiMovies] Found ${searchResults.length} search result(s)`);

  // Pick best match — prefer the one whose slug contains the title keywords
  // AND penalize slugs that have EXTRA words not in the title (e.g. "naruto-shippuden"
  // should score lower than "naruto-hindi-dubbed" when searching for "Naruto")
  const titleLower = cleanTitle.toLowerCase();
  const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);
  let best = null;
  let bestScore = 0;
  for (const r of searchResults) {
    const slugLower = r.slug.toLowerCase();
    let score = 0;
    let matchedWords = 0;
    for (const word of titleWords) {
      if (slugLower.includes(word)) {
        score += 1;
        matchedWords++;
      }
    }
    // Bonus for matching type (movie vs tv)
    if (r.type === (isTV ? 'tv' : 'movie')) score += 0.5;
    // Penalty for extra words in slug that aren't in the title
    // (e.g. "naruto-shippuden" has "shippuden" which isn't in "Naruto")
    const slugWords = slugLower.split(/-/).filter(w => w.length > 2);
    const extraWords = slugWords.filter(sw => !titleWords.some(tw => tw.includes(sw) || sw.includes(tw)));
    score -= extraWords.length * 0.3;
    // Prefer higher match ratio
    if (matchedWords > 0) {
      score += matchedWords / titleWords.length;
    }
    if (score > bestScore) { bestScore = score; best = r; }
  }
  // Require at least 1 word match
  if (!best || bestScore < 1) {
    best = searchResults[0];
  }
  console.log(`[MultiMovies] Best match: ${best.title.slice(0, 60)} (${best.url}) [score: ${bestScore.toFixed(1)}]`);

  // 3. Fetch the page (movie or TV show)
  let pageHtml;
  try {
    pageHtml = await fetchText(best.url, BASE_URL + '/');
  } catch (e) {
    console.log(`[MultiMovies] Failed to fetch page: ${e.message}`);
    return [];
  }

  let playerData;
  let episodeUrl = null;

  if (isTV && season && episode) {
    // TV show: find episode URL
    episodeUrl = extractEpisodes(pageHtml, season, episode);
    if (!episodeUrl) {
      console.log(`[MultiMovies] Could not find S${season}E${episode}`);
      return [];
    }
    console.log(`[MultiMovies] Episode URL: ${episodeUrl}`);

    // Fetch episode page
    try {
      const epHtml = await fetchText(episodeUrl, BASE_URL + '/');
      playerData = extractPlayerData(epHtml);
    } catch (e) {
      console.log(`[MultiMovies] Failed to fetch episode page: ${e.message}`);
      return [];
    }
  } else {
    // Movie: use the movie page directly
    playerData = extractPlayerData(pageHtml);
  }

  if (!playerData.postId || !playerData.linksnonce) {
    console.log('[MultiMovies] No player data found');
    return [];
  }

  // 4. Get embed URLs from DooPlay API (servers 1-4)
  const numeList = playerData.options.length > 0
    ? playerData.options.map(o => o.nume)
    : ['1', '2', '3', '4'];

  console.log(`[MultiMovies] Getting embed URLs for servers: ${numeList.join(', ')}`);
  const dooType = isTV ? 'tv' : 'movie';
  const embedUrls = await getEmbedUrls(playerData.postId, dooType, playerData.linksnonce, numeList);

  if (embedUrls.length === 0) {
    console.log('[MultiMovies] No embed URLs returned');
    return [];
  }
  console.log(`[MultiMovies] Got ${embedUrls.length} embed URL(s)`);

  // 5. Try to fetch file list from iqsmartgames (for quality detection)
  let fileList = [];
  const iqsEmbedUnverified = embedUrls.find(e => e.embed_url.includes('iqsmartgames'));
  if (iqsEmbedUnverified && info.imdbId) {
    const key = extractIqsKey(iqsEmbedUnverified.embed_url);
    fileList = await fetchFileList(info.imdbId, key);
    if (fileList.length > 0) {
      console.log(`[MultiMovies] iqsmartgames returned ${fileList.length} file(s)`);
    }
  }

  // 6. Build stream objects
  const allStreams = [];

  // Verify that the embed URLs actually match the requested TMDB ID
  // (some search results match the wrong show — e.g. "Naruto Shippuden" when
  // searching for "Naruto"). The modiplay embed URL contains the TMDB ID:
  //   rozgarlelo.modiplay.xyz/embed/tmdb/tv?id={tmdbId}&s={s}&e={e}
  // If the TMDB ID in the URL doesn't match our requested ID, skip all streams.
  const verifiedEmbedUrls = [];
  for (const embed of embedUrls) {
    // Check if the embed URL contains a TMDB ID
    const tmdbMatch = embed.embed_url.match(/[?&]id=(\d+)/);
    if (tmdbMatch) {
      const embedTmdbId = tmdbMatch[1];
      if (embedTmdbId !== String(tmdbId)) {
        console.log(`[MultiMovies]   TMDB ID mismatch: embed has ${embedTmdbId}, expected ${tmdbId} — skipping this result`);
        // Return empty — we matched the wrong show
        return [];
      }
    }
    // Also check for IMDB ID mismatch
    const imdbMatch = embed.embed_url.match(/[?&]id=(tt\d+)/);
    if (imdbMatch && info.imdbId && imdbMatch[1] !== info.imdbId) {
      console.log(`[MultiMovies]   IMDB ID mismatch: embed has ${imdbMatch[1]}, expected ${info.imdbId} — skipping`);
      return [];
    }
    verifiedEmbedUrls.push(embed);
  }

  // If we have a file list from iqsmartgames, use it for quality-specific streams
  if (fileList.length > 0) {
    const iqsEmbed = verifiedEmbedUrls.find(e => e.embed_url.includes('iqsmartgames'));
    for (const file of fileList) {
      const fileName = file.filename || '';
      const quality = detectQuality(fileName);
      const height = detectHeight(quality);
      const codec = detectCodec(fileName);
      const sourceType = detectSourceType(fileName);
      const language = detectLanguage(fileName + ' ' + info.title, isAnime);
      const sizeInfo = detectSize(file.fsize);

      allStreams.push({
        name: `MultiMovies | ${quality} | ${language} | iqsmartgames`,
        title: `${info.title}${info.year ? ` (${info.year})` : ''} [MultiMovies ${quality} ${sourceType} ${codec} ${language}]${sizeInfo ? ` [${sizeInfo.raw}]` : ''}`,
        url: iqsEmbed.embed_url,
        quality,
        type: 'iframe',
        behaviorHints: {
          bingeGroup: `multimovies-${quality.toLowerCase()}-iqs`,
          proxyHeaders: {
            request: {
              'User-Agent': UA,
              'Referer': BASE_URL + '/',
            },
          },
        },
        _height: height,
        _codec: codec,
        _sourceType: sourceType,
        _language: language,
        _fileSize: sizeInfo?.bytes,
        _fileName: fileName,
        _isAnime: isAnime,
      });
    }
  }

  // Also add all verified embed URLs (one per server) as fallback streams
  for (const embed of verifiedEmbedUrls) {
    const host = (() => {
      try { return new URL(embed.embed_url).hostname; } catch { return 'unknown'; }
    })();
    const friendlyName = host.includes('modiplay') ? 'modiplay'
                       : host.includes('iqsmartgames') ? 'iqsmartgames'
                       : host.includes('screenscape') ? 'screenscape'
                       : host.includes('nxsha') ? 'nxsha'
                       : host;
    // Skip if already added from file list
    if (fileList.length > 0 && host.includes('iqsmartgames')) continue;

    allStreams.push({
      name: `MultiMovies | ${friendlyName}`,
      title: `${info.title}${info.year ? ` (${info.year})` : ''} [MultiMovies ${friendlyName}]`,
      url: embed.embed_url,
      quality: '1080p',
      type: 'iframe',
      behaviorHints: {
        bingeGroup: `multimovies-${friendlyName}`,
        proxyHeaders: {
          request: {
            'User-Agent': UA,
            'Referer': BASE_URL + '/',
          },
        },
      },
      _height: 1080,
      _codec: 'x264',
      _sourceType: 'WebDL',
      _language: isAnime ? 'Multi Audio' : 'Multi Audio',
      _isAnime: isAnime,
      _embedHost: friendlyName,
    });
  }

  // Sort by quality (4K first)
  const qOrder = { '2160p': 0, '1080p': 1, '720p': 2, '480p': 3 };
  allStreams.sort((a, b) => (qOrder[a.quality] || 99) - (qOrder[b.quality] || 99));

  console.log(`[MultiMovies] ✅ ${allStreams.length} stream(s) total`);
  return allStreams;
}

module.exports = {
  getStreams,
  getTMDBInfo,
  searchMultiMovies,
  extractPlayerData,
  extractEpisodes,
  getEmbedUrls,
  fetchFileList,
  BASE_URL,
};

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('MultiMovies scraper (multimovies.beer)');
    console.log('Usage: node multimovies.cjs <tmdbId> <movie|tv> [season] [episode]');
    process.exit(1);
  }
  const tmdbId = args[0];
  const type = args[1] || 'movie';
  const season = args[2] || null;
  const episode = args[3] || null;
  getStreams(tmdbId, type, season, episode)
    .then(s => {
      console.log(`\n=== ${s.length} stream(s) ===`);
      for (const x of s) {
        console.log(`${x.name}`);
        console.log(`  URL: ${x.url.slice(0, 150)}`);
        console.log(`  quality: ${x.quality} | height: ${x._height} | codec: ${x._codec}`);
      }
    })
    .catch(e => console.error('FATAL:', e.stack));
}
