// src/nuvio/streamxtv.cjs
// streamxtv.sbs — Multi-Provider Stream Extractor (direct playable HLS up to 4K)
//
// Adapted from the uploaded standalone streamxtv.js extractor. Resolves DIRECT
// PLAYABLE HLS streams from the streamxtv.sbs backend API at api.framextv.tech
// by sweeping ALL 20 provider backends (the existing framextv.cjs only queries
// the API's default provider — this module adds the provider=<p> param for
// every backend, which is where the 4K (2160p) sources live).
//
// CHAIN
//   TMDB ID → GET https://api.framextv.tech/api/stream?type=<type>&id=<tmdbId>
//             [&season=S&episode=E]&provider=<p>
//           → JSON { success, provider, sources: [{url, quality, type, server,
//             headers}], subtitles: [{url, label, language}] }
//
// Each source carries its own required headers (Referer varies per CDN —
// e.g. moon.peakstorm.top wants Referer: https://player.videasy.to/, Vuflix
// wants Referer: https://ww2.yesmovies.ag/). These are passed through as
// `headers` so the source wrapper (buildStreamResults → meta.nuvioReferer)
// routes HLS+Referer streams through /proxy, which rewrites the m3u8 and
// sends the Referer — that is what makes the streams directly playable.
//
// The API also returns title-level subtitles (stremio-ready VTT from
// subs5.strem.io) in ~25 languages. They are deduped by language and
// attached to every stream object as Stremio-format { id, url, lang } —
// buildStreamResults passes them through meta.subtitles and StreamResolver
// attaches them to the final stream output.
//
// Rate limiting: the API throttles bursts. Providers are queried in batches
// of 5 with a 500ms delay between batches and one retry (1.5s backoff) per
// provider. A 22s internal deadline returns partial results rather than
// letting the source-level timeout discard everything (StreamResolver's
// SOURCE_TIMEOUT_MS is 35s and TMDB lookups consume a few seconds of it).
//
// PROVIDERS (20 — each maps to a different upstream backend)
//   barbarian, super_barbarian, miner, lavahound, electro_wizard, ice_golem,
//   bowler, headhunter, pekka, goblin, super_pekka, valkyrie, dragon, witch,
//   giant, golem, super_dragon, pekka_x, yeti, wizard

'use strict';

const API_BASE = 'https://api.framextv.tech';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EMBED_REFERER = 'https://embed.streamxtv.tech/';

// All 20 providers — ordered by typical quality (4K-capable first)
const ALL_PROVIDERS = [
  'barbarian',       // Videasy (Yoru) — 4K + 1080p + 720p
  'goblin',          // Videasy (Yoru) — 4K + 1080p + 720p
  'super_barbarian', // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'electro_wizard',  // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'lavahound',       // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'headhunter',      // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'pekka',           // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'super_pekka',     // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'valkyrie',        // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'dragon',          // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'witch',           // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'giant',           // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'golem',           // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'super_dragon',    // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'yeti',            // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'wizard',          // VidCore (CinePlay CDN) — 4K + 1080p + 720p
  'miner',           // Movy (Miami + Seattle) — 1080p + 720p + Auto HLS
  'bowler',          // RiveStream (Pulse + Apex + Citadel) — multi-lang
  'ice_golem',       // Vuflix (YesMovies) — 1080p
  'pekka_x',         // LookMovie — 480p
];

// Internal deadline for the whole sweep — must stay below the source-level
// callNuvioProvider timeout (25s) so partial results are returned instead
// of being discarded by the timeout race (StreamResolver kills sources at
// 35s and TMDB/anime lookups consume a few seconds before this runs).
// Task 84: deadline 22s→26s + per-attempt 7s→9s — the shared sweep (framextv
// now delegates here) halves the API load, and prod probes still show 7s
// timeouts on slow providers (Task 84 logs); 9s×2 ≈ 19.5s worst batch, batch
// stop-check at 18s keeps everything inside the source-level 33s race.
const SWEEP_DEADLINE_MS = 26000;
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 9000;
const REQUEST_RETRIES = 1; // one retry per provider (2 attempts total)
const MAX_SUBTITLES = 20;  // deduped by language; mirrors addon's multi-sub philosophy

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// got-scraping loader (Chrome TLS fingerprint — repo convention)
let _gs = null;
async function getGs() {
  if (_gs !== null) return _gs;
  try { _gs = (await import('got-scraping')).gotScraping; }
  catch { _gs = false; }
  return _gs;
}

// Fetch JSON with retry — the API is rate-limited, so transient 5xx/timeouts
// are retried with a short backoff. Returns null on hard failure.
async function fetchJson(url, timeout = REQUEST_TIMEOUT_MS, retries = REQUEST_RETRIES) {
  const gs = await getGs();
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Referer': EMBED_REFERER,
  };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (gs) {
        const res = await gs.get(url, {
          headers,
          timeout: { request: timeout },
          throwHttpErrors: false,
          http2: false,
        });
        if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
        return JSON.parse(res.body);
      }
      // Fallback: plain fetch (no got-scraping available)
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Normalize quality labels from the API into consistent values.
// API returns: "2160p", "1080p", "720p", "480p", "360p", "Auto HLS", "HLS",
// "Auto", "dcloud", "ipcloud", "tcloud", "480" (no 'p'), "720p | English", etc.
function normalizeQuality(rawQuality) {
  if (!rawQuality) return 'HLS';
  const q = String(rawQuality).trim();
  const ql = q.toLowerCase();

  // Standard resolution labels
  if (ql === '2160p' || ql === '4k') return '4K';
  if (ql === '1440p') return '1440p';
  if (ql === '1080p') return '1080p';
  if (ql === '720p') return '720p';
  if (ql === '480p' || ql === '480') return '480p';
  if (ql === '360p' || ql === '360') return '360p';

  // Multi-language qualities like "720p | English" → extract resolution
  const resMatch = q.match(/(\d{3,4})p/i);
  if (resMatch) {
    const h = parseInt(resMatch[1]);
    if (h >= 2160) return '4K';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    if (h >= 480) return '480p';
    if (h >= 360) return '360p';
  }

  // Non-standard labels from RiveStream/MeowTV/PrimeVids providers — these
  // are typically 1080p or auto-quality HLS streams. Map to "Auto".
  //   "dcloud"/"ipcloud"/"tcloud" = PrimeVids streams (usually 1080p)
  //   "auto" = MeowTV auto-quality, "Auto HLS" = Movy, "HLS" = generic
  return 'Auto';
}

// Sort order for normalized qualities (4K first)
const Q_ORDER = { '4K': 0, '2160p': 0, '1440p': 1, '1080p': 2, '720p': 3, '480p': 4, '360p': 5, 'Auto': 6, 'HLS': 6 };
function qualitySortKey(quality) {
  return Q_ORDER[quality] ?? 99;
}

// Map the API's subtitles array to Stremio format, deduped by language
// (the API often returns "English" and "English (2)" — keep the first per
// language, it is the primary track). Format: [{ id, url, lang }].
function mapSubtitles(rawSubs) {
  if (!Array.isArray(rawSubs)) return [];
  const seen = new Set();
  const out = [];
  for (const sub of rawSubs) {
    if (!sub || !sub.url || typeof sub.url !== 'string') continue;
    const lang = String(sub.language || sub.lang || sub.label || 'en').slice(0, 12);
    if (seen.has(lang)) continue;
    seen.add(lang);
    out.push({ id: lang.slice(0, 8), url: sub.url, lang });
    if (out.length >= MAX_SUBTITLES) break;
  }
  return out;
}

// Fetch streams from the StreamXTV API across ALL providers.
// Signature matches the other nuvio provider modules:
//   getStreams(tmdbId, mediaType, season, episode) → [{ name, title, url,
//   quality, type, headers, subtitles, behaviorHints }]
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isTV = type === 'tv' || type === 'series' || type === 'anime';
  console.log(`[StreamXTV] Request: tmdb=${tmdbId} type=${type}` +
    (isTV ? ` S${season || '?'}E${episode || '?'}` : ''));

  const params = new URLSearchParams({ type: isTV ? 'tv' : 'movie', id: tmdbId });
  if (isTV && season) {
    params.set('season', String(season));
    params.set('episode', String(episode || 1));
  }

  const startedAt = Date.now();
  const allStreams = [];
  const seenUrls = new Set();
  let sharedSubs = []; // title-level subtitles (same for all providers)

  // Query providers in batches of 5 with 500ms delay between batches to
  // avoid hitting the API rate limit (same strategy as the uploaded
  // standalone extractor). Bail out gracefully at the internal deadline —
  // partial results are better than a timeout discarding everything.
  for (let i = 0; i < ALL_PROVIDERS.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(BATCH_DELAY_MS);
    if (Date.now() - startedAt > SWEEP_DEADLINE_MS - 8000) {
      console.log(`[StreamXTV] Deadline approaching — stopping after ${i} provider(s)`);
      break;
    }

    const batch = ALL_PROVIDERS.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((provider) =>
        fetchJson(`${API_BASE}/api/stream?${params}&provider=${provider}`)
          .then((j) => ({ provider, json: j }))
      )
    );

    for (let b = 0; b < results.length; b++) {
      const result = results[b];
      const provider = batch[b];
      if (result.status !== 'fulfilled') {
        console.log(`[StreamXTV]   ${provider}: ${String(result.reason?.message || 'error').slice(0, 60)}`);
        continue;
      }
      const { json } = result.value;

      // Validate API response
      if (!json || json.success === false) {
        console.log(`[StreamXTV]   ${provider}: API returned failure`);
        continue;
      }
      const sources = json.sources || [];
      if (sources.length === 0) {
        console.log(`[StreamXTV]   ${provider}: no sources`);
        continue;
      }
      console.log(`[StreamXTV]   ${provider}: ${sources.length} source(s)`);

      // Title-level subtitles — capture once (identical across providers)
      if (sharedSubs.length === 0) {
        sharedSubs = mapSubtitles(json.subtitles);
        if (sharedSubs.length > 0) {
          console.log(`[StreamXTV]   ${sharedSubs.length} unique-language subtitle(s)`);
        }
      }

      for (const src of sources) {
        // Skip sources without URLs
        if (!src.url || typeof src.url !== 'string' || !src.url.startsWith('http')) continue;
        // Deduplicate by URL (providers often share the same backend stream)
        if (seenUrls.has(src.url)) continue;
        seenUrls.add(src.url);

        const quality = normalizeQuality(src.quality);
        const server = src.server || provider;
        const streamType = src.type === 'dash' || src.url.includes('.mpd')
          ? 'application/dash+xml'
          : 'application/vnd.apple.mpegurl';

        // Per-source request headers — REQUIRED for playability.
        // Normalize to the casing buildStreamResults expects
        // (Referer / User-Agent); drop harmless keys (Origin, Accept).
        const rawHeaders = src.headers || {};
        const headers = {};
        const referer = rawHeaders.Referer || rawHeaders.referer;
        const ua = rawHeaders['User-Agent'] || rawHeaders['user-agent'];
        if (referer) headers.Referer = referer;
        if (ua) headers['User-Agent'] = ua;

        allStreams.push({
          name: `StreamXTV - ${quality} ${server} (${provider})`,
          title: `StreamXTV ${provider} ${quality} ${server}`,
          url: src.url,
          quality,
          type: streamType,
          headers,
          ...(sharedSubs.length > 0 && { subtitles: sharedSubs }),
          // Per-source audio metadata — wired into language flags (meta
          // .countryCodes) and "Dual Audio (A + B)" title labels by
          // buildStreamResults/normalizeAudioTracks in nuvioHelpers.js.
          // Sparsely populated by the API (null on most backends) — pass
          // through verbatim whenever present.
          ...(src.audioTracks != null && { audioTracks: src.audioTracks }),
          ...(src.hasMultipleAudio != null && { hasMultipleAudio: src.hasMultipleAudio === true }),
          behaviorHints: {
            bingeGroup: `streamxtv-${provider}-${quality}`,
            notWebReady: false,
          },
        });
      }
    }
  }

  // Sort by quality (4K first), then by name for stable ordering
  allStreams.sort((a, b) => {
    const qDiff = qualitySortKey(a.quality) - qualitySortKey(b.quality);
    if (qDiff !== 0) return qDiff;
    return a.name.localeCompare(b.name);
  });

  console.log(`[StreamXTV] ${allStreams.length} stream(s) total in ${Date.now() - startedAt}ms`);
  return allStreams;
}

// Task 84: shared sweep cache — framextv.cjs DELEGATES to this module (both
// hit the same api.framextv.tech backend with the same provider params), so
// one 20-provider sweep serves both sources instead of two competing sweeps
// (40 near-parallel requests from one IP — measured to trip the API's burst
// throttle from Render egress). 90s TTL: fresh for a user refresh cycle,
// short enough to track the API's minute-scale flap windows. In-flight
// promise dedup: a merged request that runs both sources in the same wave
// waits on ONE sweep. Failures clear the cache so the next request retries.
const SWEEP_CACHE_TTL = 90 * 1000;
let _sweep = { key: null, at: 0, promise: null };

function getStreamsShared(tmdbId, type, season, episode) {
  const key = `${tmdbId}|${type}|${season || ''}|${episode || ''}`;
  const now = Date.now();
  if (_sweep.key === key && now - _sweep.at < SWEEP_CACHE_TTL && _sweep.promise) {
    return _sweep.promise;
  }
  const promise = getStreams(tmdbId, type, season, episode).catch((e) => {
    if (_sweep.promise === promise) _sweep = { key: null, at: 0, promise: null };
    throw e;
  });
  _sweep = { key, at: now, promise };
  return promise;
}

module.exports = { getStreams: getStreamsShared, getStreamsRaw: getStreams, normalizeQuality, ALL_PROVIDERS, API_BASE };
