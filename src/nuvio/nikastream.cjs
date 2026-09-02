// NikaStream (nikastream.blog) All-In-One — Single-File Pure-Node.js Scraper
// =========================================================================
// Fetches stream URLs for anime from nikastream.blog via its Anivexa API
// backend (https://anivexa-api.sudeepdon119.workers.dev).
//
// ARCHITECTURE
// ------------
// NikaStream is a Next.js-like SPA that uses an AniList ID-based episode
// page: /episode?anime_id={anilistId}&ep_num={epNum}. The actual stream
// data is fetched from the Anivexa Cloudflare Worker, which acts as a
// unified aggregator over ~13 anime source providers.
//
// Anivexa API endpoints used:
//   GET /episodes/{anilistId}
//     Returns: { mappings, <provider>: { episodes: { sub: [], dub: [] } } }
//     Episode ID format: "watch/{provider}/{anilistId}/{sub|dub}/{provider}-{epNum}"
//
//   GET /watch/{provider}/{anilistId}/{sub|dub}/{provider}-{epNum}
//     Returns: { streams: [{ url, type, server, embed, referer, subtitles }] }
//
//   GET /map/{anilistId}
//     Returns: { mappings: { id, malId, themoviedbId, ... } }
//     (Used as a cross-check, but Stremio uses TMDB IDs natively.)
//
// TMDB → AniList mapping
// ----------------------
// Anivexa's /map/ endpoint takes an AniList ID, not TMDB. We bridge this
// gap by:
//   1. Fetching the title from TMDB API
//   2. Searching AniList GraphQL by title
//   3. Picking the top TV-format result (or MOVIE for anime movies)
// This works reliably for all popular anime. The TMDB ID is also recorded
// in the Anivexa /map/ response, so we cross-verify when possible.
//
// Providers (13 total, ~6 work reliably)
// --------------------------------------
//   reanime  — flixcloud.cc (encrypted m3u8, use embed URL as iframe)
//              ✅ sub + dub, ✅ 4 subtitle tracks (multi-language)
//   anikoto  — kryntal.top (direct m3u8, needs Referer)
//              ✅ sub + dub, ✅ 9 subtitle tracks (multi-language), ✅ 1080p
//   anibd    — animeapps.top (direct m3u8, NO auth needed)
//              ✅ sub only (dub usually empty)
//   anineko  — vivibebe.site + multiple embed mirrors
//              ✅ sub only, embeds carry subtitle URLs as query params
//   animegg  — animegg.org (mp4 + embed)
//              ✅ sub only
//   kaa      — krussdomi.com (Cloudflare-blocked, often 403)
//   mkissa   — often rate-limited
//   2dhive   — 429 rate-limited
//   senshi   — 525 errors
//   animedunya, anizone, anineko (some servers) — flaky
//
// Stream URL Types
// ----------------
// Each provider returns a mix of:
//   - type: "hls"  → direct .m3u8 URL (playable by Stremio via HLS)
//   - type: "mp4"  → direct video file URL
//   - type: "embed"→ iframe player URL (Stremio supports via type: "iframe")
//
// Authentication
// --------------
// Some CDNs (kryntal.top, flixcloud.cc) require Referer + Origin headers.
// We set behaviorHints.proxyHeaders.request so Stremio proxies the request
// with those headers attached. anibd (animeapps.top) requires NO headers.
//
// Subtitles
// ---------
// Each stream object's `subtitles` array is converted to Stremio format:
//   { id: <lang>, url: <url>, lang: <label> }
// Languages include English, Arabic, French, German, Spanish, Italian,
// Portuguese, Russian, etc. (varies by provider).
//
// Sub + Dub Audio
// ---------------
// We query BOTH sub and dub for each provider. Some providers (reanime)
// return the SAME m3u8 URL for both — the audio track is selected within
// the multi-audio HLS playlist. We dedupe by URL but keep both audio
// labels in the stream name. Others (anikoto) return DIFFERENT URLs for
// sub vs dub.
//
// USAGE
// -----
//   const nika = require('./nikastream_all_in_one.js');
//   const streams = await nika.getStreams('37854', 'tv', 1, 1);  // One Piece S01E01
//   const streams = await nika.getStreams('95479', 'tv', 1, 1);  // JJK S01E01
//
// CLI:
//   node nikastream_all_in_one.js 37854 tv 1 1
//   node nikastream_all_in_one.js 95479 tv 1 1

'use strict';

const PROVIDER_NAME = 'NikaStream';
const ANIVEXA_API = 'https://anivexa-api.sudeepdon119.workers.dev';
const ANILIST_GRAPHQL = 'https://graphql.anilist.co';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const NIKASTREAM_ORIGIN = 'https://nikastream.blog';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// got-scraping loader — NikaStream's Anivexa API + AniList + downstream CDNs
// (kryntal.top, animeapps.top, flixcloud.cc) can return 403/429 to non-browser
// TLS fingerprints. got-scraping uses Chrome's TLS fingerprint to bypass these.
// Native fetch is kept as a fallback if got-scraping is unavailable.
let _gotScrapingMod = null;
async function getGotScraping() {
  if (_gotScrapingMod !== null) return _gotScrapingMod;
  try {
    const mod = await import('got-scraping');
    _gotScrapingMod = mod.gotScraping || (mod.default && mod.default.gotScraping) || mod.default;
  } catch (e) {
    _gotScrapingMod = false;
  }
  return _gotScrapingMod;
}

// Wrapper: GET with got-scraping (Chrome TLS) + native fetch fallback.
// `referer` is optional. `timeoutMs` defaults to 12s.
async function gotGet(url, { referer, timeoutMs = 12000, headers: extraHeaders = {} } = {}) {
  const gs = await getGotScraping();
  if (gs) {
    const res = await gs({
      url,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(referer && { Referer: referer }),
        ...extraHeaders,
      },
      timeout: { request: timeoutMs },
      throwHttpErrors: false,
      followRedirect: true,
      headerGeneratorOptions: {
        browsers: ['chrome'],
        devices: ['desktop'],
        operatingSystems: ['windows'],
      },
    });
    return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: res.body };
  }
  // Fallback: native fetch
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        ...(referer && { Referer: referer }),
        ...extraHeaders,
      },
      signal: ctrl.signal,
    });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Wrapper: POST JSON with got-scraping + native fetch fallback.
async function gotPostJson(url, data, { referer, timeoutMs = 15000, headers: extraHeaders = {} } = {}) {
  const bodyStr = JSON.stringify(data);
  const gs = await getGotScraping();
  if (gs) {
    const res = await gs({
      url,
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        ...(referer && { Referer: referer }),
        ...extraHeaders,
      },
      body: bodyStr,
      timeout: { request: timeoutMs },
      throwHttpErrors: false,
      followRedirect: true,
      headerGeneratorOptions: {
        browsers: ['chrome'],
        devices: ['desktop'],
        operatingSystems: ['windows'],
      },
    });
    return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: res.body };
  }
  // Fallback: native fetch
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        ...(referer && { Referer: referer }),
        ...extraHeaders,
      },
      body: bodyStr,
      signal: ctrl.signal,
    });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// All Anivexa providers — listed in priority order (most reliable first).
// We query all of them in parallel; failures are silently skipped.
const ALL_PROVIDERS = [
  'reanime',    // flixcloud.cc (encrypted, use embed iframe)
  'anikoto',    // kryntal.top direct m3u8 (1080p, multi-lang subs)
  'anibd',      // animeapps.top direct m3u8 (NO auth needed)
  'anineko',    // vivibebe.site + multiple embeds
  'animegg',    // animegg.org mp4 + embed
  'kaa',        // krussdomi.com (often CF-blocked)
  'mkissa',     // rate-limited
  '2dhive',     // rate-limited
  'senshi',     // often errors
  'animedunya', // sometimes works
  'anizone',    // sometimes works
];

// ---------------------------------------------------------------------------
// TMDB metadata fetcher
// ---------------------------------------------------------------------------
async function getTMDBInfo(tmdbId, type) {
  const url = `https://api.themoviedb.org/3/${type === 'tv' ? 'tv' : 'movie'}/${tmdbId}` +
    `?api_key=${TMDB_API_KEY}&language=en-US`;
  const r = await gotGet(url, { timeoutMs: 12000 });
  if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
  const j = JSON.parse(r.body);
  return {
    title: j.name || j.title || 'Unknown',
    year: (j.first_air_date || j.release_date || '').slice(0, 4),
    type,
    tmdbId: String(tmdbId),
    originalName: j.original_name || j.original_title || '',
  };
}

// ---------------------------------------------------------------------------
// AniList search: title -> AniList ID
// Picks the top TV-format result for TV queries, MOVIE for movie queries.
// Handles AniList's 90 req/min rate limit with retry on 429.
// ---------------------------------------------------------------------------
// Normalize anime titles for AniList search:
//   - Strip macrons (Shippūden → Shippuden) — AniList uses Hepburn without macrons
//   - Strip subtitle/qualifier suffixes (": Season 1", " - Part 1", etc.)
//   - Strip year suffixes (" (2007)")
function normalizeTitleForSearch(title) {
  if (!title) return '';
  let t = title;
  // Replace macron vowels (ū → u, ō → o, ā → a, ī → i, ē → e)
  t = t.replace(/[ūū]/g, 'u').replace(/[ōō]/g, 'o').replace(/[āā]/g, 'a').replace(/[īī]/g, 'i').replace(/[ēē]/g, 'e');
  // Strip year suffix in parentheses
  t = t.replace(/\s*\(\d{4}\)\s*$/, '');
  // Strip common season/part qualifiers
  t = t.replace(/\s*[:：]\s*Season\s+\d+.*$/i, '');
  t = t.replace(/\s*[:：]\s*Part\s+\d+.*$/i, '');
  t = t.replace(/\s*-\s*Part\s+\d+.*$/i, '');
  // Strip trailing "Season N"
  t = t.replace(/\s+Season\s+\d+.*$/i, '');
  return t.trim();
}

async function findAniListId(title, type) {
  const query = `
    query ($search: String, $format: MediaFormat) {
      Page(page: 1, perPage: 3) {
        media(type: ANIME, search: $search, format: $format) {
          id
          idMal
          title { english romaji }
          format
        }
      }
    }
  `;
  // Try the original title first, then a normalized version
  const searchVariants = [title, normalizeTitleForSearch(title)].filter((v, i, a) => a.indexOf(v) === i);
  const formats = type === 'tv' ? ['TV', null] : ['MOVIE', null];

  for (const search of searchVariants) {
    for (const format of formats) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await gotPostJson(
            ANILIST_GRAPHQL,
            { query, variables: { search, format } },
            { timeoutMs: 20000 }
          );
          if (r.status === 429) {
            // AniList rate-limited — retry after 2s
            await new Promise(res => setTimeout(res, 2000));
            continue;
          }
          if (!r.ok) continue;
          const j = JSON.parse(r.body);
          const media = j?.data?.Page?.media || [];
          if (media.length > 0) {
            return {
              anilistId: media[0].id,
              malId: media[0].idMal,
              title: media[0].title.english || media[0].title.romaji,
            };
          }
          break; // No results for this format, try next format
        } catch (e) {
          if (attempt < 2) {
            await new Promise(res => setTimeout(res, 1500));
          }
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch a SINGLE provider's episodes — much faster than the combined /episodes
// endpoint (which queries all 13 providers in parallel and takes ~20s when
// some are slow). Per-provider call is ~500ms.
// Returns: { episodes: { sub: [], dub: [] } } or null on failure.
// ---------------------------------------------------------------------------
async function fetchProviderEpisodes(provider, anilistId) {
  const url = `${ANIVEXA_API}/episodes/${provider}/${anilistId}`;
  try {
    const r = await gotGet(url, {
      referer: NIKASTREAM_ORIGIN + '/',
      timeoutMs: 12000,
      headers: { 'Origin': NIKASTREAM_ORIGIN },
    });
    if (!r.ok) return null;
    const j = JSON.parse(r.body);
    return j[provider]?.episodes || null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch ALL providers' episodes in parallel. Returns a map of
// { providerName: { sub: [...], dub: [...] } }.
// Skip providers that fail or return no episodes.
// ---------------------------------------------------------------------------
async function fetchAllProviderEpisodes(anilistId) {
  const results = await Promise.all(
    ALL_PROVIDERS.map(p =>
      fetchProviderEpisodes(p, anilistId).then(eps => ({ provider: p, episodes: eps }))
    )
  );
  const map = {};
  for (const r of results) {
    if (r.episodes && (r.episodes.sub?.length || r.episodes.dub?.length)) {
      map[r.provider] = r.episodes;
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Fetch the /watch response for a specific provider × episode × audio.
// Returns: { streams: [...], error?: string }
// ---------------------------------------------------------------------------
async function fetchWatch(provider, anilistId, audio, epNum) {
  const epId = `watch/${provider}/${anilistId}/${audio}/${provider}-${epNum}`;
  const url = `${ANIVEXA_API}/${epId}`;
  try {
    const r = await gotGet(url, {
      referer: NIKASTREAM_ORIGIN + '/',
      timeoutMs: 15000,
      headers: { 'Origin': NIKASTREAM_ORIGIN },
    });
    if (!r.ok) {
      return { provider, audio, error: `HTTP ${r.status}`, streams: [] };
    }
    const j = JSON.parse(r.body);
    if (!j.streams || !Array.isArray(j.streams)) {
      return { provider, audio, error: 'no streams', streams: [] };
    }
    return { provider, audio, streams: j.streams, raw: j };
  } catch (e) {
    return { provider, audio, error: e.message, streams: [] };
  }
}

// ---------------------------------------------------------------------------
// Validate a stream URL is actually reachable.
// Some CDNs reject Range requests (flixcloud.cc returns 403 "Invalid token"),
// so we do a plain GET and just check the HTTP status.
// Returns true if HTTP 200/206.
// Uses got-scraping so CF-protected CDNs (kryntal.top, animeapps.top) validate.
// ---------------------------------------------------------------------------
async function validateStreamUrl(url, referer) {
  try {
    const extraHeaders = { 'Accept': '*/*' };
    if (referer) {
      extraHeaders['Referer'] = referer;
      extraHeaders['Origin'] = referer.replace(/\/$/, '');
    }
    const r = await gotGet(url, { referer, timeoutMs: 10000, headers: extraHeaders });
    // 200 = OK, 206 = partial content (Range honored) — both mean playable
    return r.ok || r.status === 206;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Build a Stremio stream object
// ---------------------------------------------------------------------------
function buildStream(opts) {
  const s = {
    name: PROVIDER_NAME + ' - ' + opts.serverLabel,
    title: opts.title,
    url: opts.url,
    quality: opts.quality || '1080p',
    behaviorHints: {
      bingeGroup: opts.bingeGroup || ('nikastream-' + opts.serverLabel.toLowerCase().replace(/\s+/g, '-')),
    },
  };
  // Set type based on URL/known type
  if (opts.type === 'iframe' || opts.isEmbed) {
    s.type = 'iframe';
    s.behaviorHints.notWebVideo = true;
  } else if (opts.type === 'mp4') {
    s.type = 'video/mp4';
  } else {
    s.type = 'application/vnd.apple.mpegurl';
  }
  // Set proxy headers if the CDN requires auth (Referer/Origin)
  if (opts.needsReferer && opts.referer) {
    s.behaviorHints.proxyHeaders = {
      request: {
        'User-Agent': UA,
        'Referer': opts.referer,
        'Origin': opts.referer.replace(/\/$/, ''),
      },
    };
  }
  // Attach subtitles
  if (opts.subtitles && opts.subtitles.length > 0) {
    s.subtitles = opts.subtitles.map(sub => ({
      id: sub.srclang || sub.lang || sub.language || 'en',
      url: sub.url,
      lang: sub.label || sub.lang || sub.language || 'English',
    }));
  }
  return s;
}

// ---------------------------------------------------------------------------
// Build the stream title with audio + episode info
// ---------------------------------------------------------------------------
function buildStreamTitle(info, provider, audio, server, epNum) {
  const audioLabel = audio === 'dub' ? 'DUB' : 'SUB';
  return `${info.title} [NikaStream ${provider} ${audioLabel}${server ? ' ' + server : ''} E${epNum}]`;
}

// ---------------------------------------------------------------------------
// Convert a raw Anivexa stream object into a Stremio stream object.
// Returns null if the stream can't be made playable.
// ---------------------------------------------------------------------------
// Some CDNs return encrypted m3u8 bodies (flixcloud.cc — uses WASM to decrypt
// client-side). For those, we MUST use the embed URL as an iframe — Stremio's
// iframe player can run the page's JS to decrypt the stream.
const ENCRYPTED_CDN_HOSTS = ['flixcloud.cc', 'fetch8.flixcloud.cc', 'fetch7.flixcloud.cc'];

function isEncryptedCdn(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return ENCRYPTED_CDN_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (e) {
    return false;
  }
}

async function convertStream(rawStream, provider, audio, info, epNum) {
  if (!rawStream) return null;

  let url = rawStream.url || rawStream.embed;
  if (!url || !url.startsWith('http')) return null;

  // Determine the type
  const isEmbed = rawStream.type === 'embed' || (!rawStream.url && rawStream.embed);
  const isMp4 = rawStream.type === 'mp4' || url.endsWith('.mp4');
  const isIframe = isEmbed && !rawStream.url; // pure embed-only stream

  // For encrypted CDNs (flixcloud.cc), ALWAYS use the embed URL as iframe —
  // the m3u8 body is encrypted and can only be decrypted by the page's JS.
  if (isEncryptedCdn(rawStream.url) && rawStream.embed) {
    return buildStream({
      title: buildStreamTitle(info, provider, audio, rawStream.server, epNum),
      url: rawStream.embed,
      quality: '1080p',
      serverLabel: `${provider} ${audio.toUpperCase()} ${rawStream.server || ''}`.trim(),
      bingeGroup: `nikastream-${provider}-${audio}-${rawStream.server || 'embed'}`.toLowerCase(),
      type: 'iframe',
      isEmbed: true,
      subtitles: rawStream.subtitles,
    });
  }

  // For embed-only streams, use the embed URL as an iframe
  if (isIframe) {
    return buildStream({
      title: buildStreamTitle(info, provider, audio, rawStream.server, epNum),
      url: url,
      quality: '1080p',
      serverLabel: `${provider} ${audio.toUpperCase()} ${rawStream.server || ''}`.trim(),
      bingeGroup: `nikastream-${provider}-${audio}-${rawStream.server || 'embed'}`.toLowerCase(),
      type: 'iframe',
      isEmbed: true,
      subtitles: rawStream.subtitles,
    });
  }

  // For HLS/MP4 streams, validate the URL is reachable (no Range header —
  // some CDNs reject Range requests)
  const referer = rawStream.referer;
  const needsReferer = !!referer;
  const ok = await validateStreamUrl(url, referer);
  if (!ok) return null;

  return buildStream({
    title: buildStreamTitle(info, provider, audio, rawStream.server, epNum),
    url: url,
    quality: '1080p',
    serverLabel: `${provider} ${audio.toUpperCase()} ${rawStream.server || ''}`.trim(),
    bingeGroup: `nikastream-${provider}-${audio}-${rawStream.server || 'stream'}`.toLowerCase(),
    type: isMp4 ? 'mp4' : 'hls',
    isEmbed: false,
    needsReferer,
    referer,
    subtitles: rawStream.subtitles,
  });
}

// ---------------------------------------------------------------------------
// Main entry: get streams for a TMDB item
// ---------------------------------------------------------------------------
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isMovie = type !== 'tv';

  if (!isMovie && (season == null || episode == null)) {
    console.log('[NikaStream] TV request without season/episode — returning empty');
    return [];
  }
  if (!tmdbId) {
    console.log('[NikaStream] Empty TMDB ID — returning empty');
    return [];
  }

  console.log('[NikaStream] Request: tmdb=' + tmdbId + ' type=' + type +
    (isMovie ? '' : ' S' + season + 'E' + episode));

  // 1. Fetch TMDB info
  let info;
  try {
    info = await Promise.race([
      getTMDBInfo(tmdbId, type),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TMDB timeout')), 10000)),
    ]);
  } catch (e) {
    console.log('[NikaStream] TMDB fetch error: ' + e.message);
    return [];
  }
  console.log('[NikaStream] TMDB: ' + info.title + (info.year ? ' (' + info.year + ')' : ''));

  // 2. Find AniList ID
  const anilistResult = await findAniListId(info.title, type);
  if (!anilistResult) {
    console.log('[NikaStream] Could not find AniList ID for "' + info.title + '"');
    return [];
  }
  console.log('[NikaStream] AniList: ' + anilistResult.anilistId + ' (MAL: ' + anilistResult.malId + ', title: ' + anilistResult.title + ')');

  // 3. Fetch per-provider episodes in parallel (each takes ~500ms)
  console.log('[NikaStream] Fetching episode lists from all ' + ALL_PROVIDERS.length + ' providers in parallel...');
  const providerEpisodes = await fetchAllProviderEpisodes(anilistResult.anilistId);
  const activeProviders = Object.keys(providerEpisodes);
  console.log('[NikaStream] Providers with episodes: ' + activeProviders.join(', '));

  if (activeProviders.length === 0) {
    console.log('[NikaStream] No providers have this anime');
    return [];
  }

  // For movies, epNum = 1. For TV, epNum = episode.
  const epNum = isMovie ? 1 : parseInt(episode, 10);

  // 4. Query /watch for each provider × (sub, dub) in parallel
  const watchQueries = [];
  for (const provider of activeProviders) {
    const eps = providerEpisodes[provider];
    const hasSub = eps.sub && eps.sub.some(e => e.number === epNum);
    const hasDub = eps.dub && eps.dub.some(e => e.number === epNum);
    if (hasSub) watchQueries.push({ provider, audio: 'sub' });
    if (hasDub) watchQueries.push({ provider, audio: 'dub' });
    // If neither explicitly has the ep number, try /watch anyway
    // (some providers don't list all episodes but do serve them)
    if (!hasSub && !hasDub) {
      watchQueries.push({ provider, audio: 'sub' });
      if (eps.dub) watchQueries.push({ provider, audio: 'dub' });
    }
  }

  console.log('[NikaStream] Querying ' + watchQueries.length + ' provider×audio combos in parallel...');
  const watchResults = await Promise.all(
    watchQueries.map(q => fetchWatch(q.provider, anilistResult.anilistId, q.audio, epNum))
  );

  // 5. Convert each /watch result into Stremio stream objects.
  // We collect ALL raw streams first, then convert+validate them in parallel
  // with bounded concurrency. Sequential validation was the bottleneck
  // (11 streams × 10s timeout = 110s). With concurrency=8, total time drops
  // to ~15s even when several CDNs time out.
  const conversionTasks = [];
  for (const r of watchResults) {
    if (r.error) continue; // silent — too noisy to log every provider error
    for (const rawStream of r.streams) {
      conversionTasks.push({ rawStream, provider: r.provider, audio: r.audio });
    }
  }

  // Bounded parallel conversion (8 at a time) — validateStreamUrl hits CDNs
  // that may be slow. Sequential was the slow path (62s+); parallel gets us
  // to ~10-15s for 11 streams.
  async function mapPool(items, concurrency, worker) {
    const out = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        out[i] = await worker(items[i], i);
      }
    });
    await Promise.all(runners);
    return out;
  }

  const converted = await mapPool(conversionTasks, 8, async (task) => {
    try {
      const s = await convertStream(task.rawStream, task.provider, task.audio, info, epNum);
      return s ? { stream: s, provider: task.provider, audio: task.audio } : null;
    } catch (e) {
      return null;
    }
  });

  // Dedupe by URL+audio (some providers return same stream multiple times)
  const allStreams = [];
  const seenUrls = new Set();
  const addedCounts = {};
  for (const c of converted) {
    if (!c || !c.stream) continue;
    const dedupeKey = c.stream.url + '|' + c.audio;
    if (seenUrls.has(dedupeKey)) continue;
    seenUrls.add(dedupeKey);
    allStreams.push(c.stream);
    addedCounts[c.provider + ' ' + c.audio.toUpperCase()] = (addedCounts[c.provider + ' ' + c.audio.toUpperCase()] || 0) + 1;
  }
  for (const [k, v] of Object.entries(addedCounts)) {
    console.log('[NikaStream]   ' + k + ': ' + v + ' stream(s)');
  }

  // 6. Sort streams: SUB first, then DUB; reanime/anikoto first within each audio
  const audioOrder = { sub: 0, dub: 1 };
  const providerOrder = { reanime: 0, anikoto: 1, anibd: 2, anineko: 3, animegg: 4, kaa: 5 };
  allStreams.sort((a, b) => {
    const aAudio = (a.title.match(/\[(.*?)\]/)?.[1] || '').includes('DUB') ? 1 : 0;
    const bAudio = (b.title.match(/\[(.*?)\]/)?.[1] || '').includes('DUB') ? 1 : 0;
    if (aAudio !== bAudio) return aAudio - bAudio;
    const aProv = (a.name.match(/- (.+?) /) || [])[1] || '';
    const bProv = (b.name.match(/- (.+?) /) || [])[1] || '';
    return (providerOrder[aProv] || 99) - (providerOrder[bProv] || 99);
  });

  console.log('[NikaStream] ' + allStreams.length + ' streams total');
  return allStreams;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getStreams: getStreams,
  getTMDBInfo: getTMDBInfo,
  findAniListId: findAniListId,
  fetchProviderEpisodes: fetchProviderEpisodes,
  fetchAllProviderEpisodes: fetchAllProviderEpisodes,
  fetchWatch: fetchWatch,
  validateStreamUrl: validateStreamUrl,
  listProviders: function () { return ALL_PROVIDERS.slice(); },
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node nikastream_all_in_one.js <tmdbId> <tv|movie> [season] [episode]');
    console.log('Examples:');
    console.log('  node nikastream_all_in_one.js 37854 tv 1 1   # One Piece S01E01');
    console.log('  node nikastream_all_in_one.js 95479 tv 1 1   # Jujutsu Kaisen S01E01');
    console.log('  node nikastream_all_in_one.js 31910 tv 1 1   # Naruto S01E01');
    process.exit(1);
  }
  const tmdbId = args[0];
  const type = args[1];
  const season = type === 'tv' ? parseInt(args[2] || '1', 10) : null;
  const episode = type === 'tv' ? parseInt(args[3] || '1', 10) : null;

  getStreams(tmdbId, type, season, episode).then(streams => {
    console.log('\n=== Final streams ===');
    streams.forEach((s, i) => {
      console.log((i + 1) + '. ' + s.name + ' | ' + s.quality + ' | ' + s.type);
      console.log('   ' + s.url);
      if (s.subtitles) console.log('   subtitles: ' + s.subtitles.length);
      if (s.behaviorHints?.proxyHeaders) console.log('   proxyHeaders: yes (Referer)');
    });
    console.log('\nTotal: ' + streams.length + ' stream(s)');
  }).catch(e => {
    console.error('FATAL: ' + e.stack);
    process.exit(1);
  });
}
