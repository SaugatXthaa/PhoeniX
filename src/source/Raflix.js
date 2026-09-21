// src/source/Raflix.js
// raflixx.vercel.app — movies/TV/anime via multiple embed providers
//
// Raflix is a Vite/TanStack Start SPA that provides embed URLs from
// multiple streaming providers via its API:
//
//   Movies/TV: GET /api/media/sources?type={movie|tv}&tmdbId={id}&season={s}&episode={e}
//   Anime:     GET /api/anime/sources?tmdbId={id}&title={title}&season={s}&episode={e}&dub={0|1}&year={y}
//
// The APIs return JSON with a "sources" array containing:
//   { id, label, kind: "embed", url, language?: "sub"|"dub" }
//
// Movies/TV get 8 sources: Anicine, XPass, MoviesAPI, FileSun, VidStorm,
//   VidRift, APIPlayer, EmbedMaster
// Anime gets 17 sources (both sub and dub): TryEmbed, AniLink, MegaVid, Vidy,
//   VidNest, MegaPlay, VidLink, Yenime, SupaPlay, NHD, NontonGo, Anicine,
//   VidRift, AniEmbed, Filmu, FrameXTV
//
// Many of these embed URLs are handled by existing extractors:
//   - Megaplay → Megaplay extractor
//   - VidNest → handled by EmbedResolver
//   - VidLink → VidLink extractor
//   - FrameXTV → NuvioExtractor (framextv source)
//   - Others → EmbedResolver/ExternalUrl fallback
//
// ENRICHED METADATA:
//   - height: 1080 (default, resolved by extractor)
//   - sourceType: WebDL (default)
//   - audioLabel: SUB/DUB for anime, English for movies
//   - serverName: from API source label

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { TMDB_PRIMARY } from '../utils/site-secrets.cjs'; // central site-secret registry (env-overridable)
import { vidstormDecrypt } from '../utils/vidstorm-decrypt.cjs'; // Task 63: vidstorm.ru token crypto

const BASE_URL = 'https://raflixx.vercel.app';
const TMDB_API_KEY = TMDB_PRIMARY;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let _gotScraping = null;
async function getGot() {
  if (_gotScraping) return _gotScraping;
  try { const mod = await import('got-scraping'); _gotScraping = mod.gotScraping; }
  catch (e) { console.error('[raflix] Failed to load got-scraping:', e.message); }
  return _gotScraping;
}

async function gotJson(url, timeoutMs = 12000) {
  const got = await getGot();
  if (!got) return null;
  // Task 51: h2 GOAWAY class — got-scraping defaults to HTTP/2, and raflix's
  // upstream closes h2 sessions aggressively ("New streams cannot be created
  // after receiving a GOAWAY" zeroed the whole source). One fast retry on the
  // GOAWAY class (index.js forceHls precedent) + h1 as the second attempt.
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await got(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        timeout: { request: timeoutMs },
        throwHttpErrors: false,
        followRedirect: true,
        http2: attempt === 0,
      });
      if (res.statusCode !== 200) return null;
      try { return JSON.parse(res.body); } catch { return null; }
    } catch (e) {
      lastErr = e;
      const msg = e?.message || String(e);
      if (!/GOAWAY|HTTP\/2|stream/i.test(msg)) throw e;
      await new Promise(r => setTimeout(r, 400));
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// Detect anime via TMDB genres + original language
async function isAnimeContent(fetcher, ctx, tmdbId) {
  try {
    const type = tmdbId.season ? 'tv' : 'movie';
    const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}`);
    url.searchParams.set('api_key', TMDB_API_KEY);
    const data = await fetcher.json(ctx, url);
    if (!data) return false;
    if ((data.genres || []).some(g => g.id === 16)) return true;
    if (data.original_language === 'ja') return true;
    return false;
  } catch { return false; }
}

// Fetch media sources (movies/TV)
async function fetchMediaSources(type, tmdbId, season, episode) {
  let url = `${BASE_URL}/api/media/sources?type=${type}&tmdbId=${tmdbId}`;
  if (type === 'tv' && season && episode) {
    url += `&season=${season}&episode=${episode}`;
  }
  const data = await gotJson(url);
  return data?.ok ? (data.sources || []) : [];
}

// ─── VidStorm (vidstorm.ru) server-side resolution (Task 63) ───────────
// raflixx's 7 raw embed sources (xpass/moviesapi/filesun/vidrift/apiplayer/
// embedmaster + anicine) are CF-protected SPA shells that no extractor can
// crack from a datacenter IP (5× 403, 2× JS-only pages) — and the CinePro
// worker below is DNS-dead. The ONE upstream that still resolves server-side
// is vidstorm.ru: its SPA player fetches
//   GET https://vidstorm.ru/api/movie/{tmdb} | /api/tv/{tmdb}/{s}/{e}
// → { carbon: {url: <AES-256-GCM token>, type: 'hls', language, flag}, … }
// and decrypts the token client-side (AES-256-GCM, key derived by XOR-60 of
// an embedded base64 constant — full scheme in src/utils/vidstorm-decrypt.cjs).
// Decrypted URLs (workers.dev / *.lol / ngcorp.dad) REQUIRE Origin:
// https://vidstorm.ru on every request (verified 200 #EXTM3U vs plain 403
// "Forbidden"), so cards ship through our /proxy with origin=+referer= (the
// /proxy propagates both across the whole rewritten HLS tree).
// Each candidate is PLAYLIST-VALIDATED at resolve time (Task 60 Atlantic
// pattern): only 200 + #EXTM3U masters ship, dead servers (ngcorp.dad 404,
// CF-blocked *.lol) drop instead of becoming listed-but-unplayable cards.
const VIDSTORM_API = 'https://vidstorm.ru/api';
const VIDSTORM_ORIGIN = 'https://vidstorm.ru';

async function resolveVidStorm(ctx, mediaType, tmdbId, season, episode) {
  const out = [];
  try {
    const apiPath = mediaType === 'tv'
      ? `${VIDSTORM_API}/tv/${tmdbId}/${season || 1}/${episode || 1}`
      : `${VIDSTORM_API}/movie/${tmdbId}`;
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    let servers = null;
    try {
      const res = await fetch(apiPath, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: c.signal,
      });
      if (res.ok) servers = await res.json().catch(() => null);
    } finally { clearTimeout(t); }
    if (!servers || typeof servers !== 'object') return out;

    for (const [name, srv] of Object.entries(servers)) {
      if (!srv || typeof srv !== 'object' || !srv.url) continue;
      if (srv.type && !/hls/i.test(String(srv.type))) continue; // mp4-class servers observed dead (ngcorp.dad 404)
      const real = vidstormDecrypt(srv.url);
      if (!real || !/^https?:\/\//i.test(real)) continue;

      // Playlist validation from OUR egress — the exact request /proxy will
      // make (Origin header). Dead/blocked servers drop here, honestly.
      let height = 720;
      let ok = false;
      try {
        const vc = new AbortController();
        const vt = setTimeout(() => vc.abort(), 6000);
        try {
          const vr = await fetch(real, {
            headers: { 'User-Agent': UA, Origin: VIDSTORM_ORIGIN },
            signal: vc.signal,
          });
          if (vr.ok) {
            const body = await vr.text();
            if (body.includes('#EXTM3U')) {
              ok = true;
              // Max variant RESOLUTION=1920x1080 → honest card height
              let maxH = 0;
              for (const m of body.matchAll(/RESOLUTION=(\d+)x(\d+)/g)) maxH = Math.max(maxH, Number(m[2]));
              if (maxH > 0) height = Math.min(2160, Math.max(360, maxH));
            }
          }
        } finally { clearTimeout(vt); }
      } catch { /* validation fetch failed → not ok */ }
      if (!ok) continue;

      const proxyUrl = ctx?.hostUrl ? new URL('/proxy', ctx.hostUrl) : null;
      if (!proxyUrl) continue;
      proxyUrl.searchParams.set('url', real);
      proxyUrl.searchParams.set('origin', VIDSTORM_ORIGIN);
      proxyUrl.searchParams.set('referer', `${VIDSTORM_ORIGIN}/`);
      proxyUrl.searchParams.set('hls', '1');

      const label = name.charAt(0).toUpperCase() + name.slice(1);
      out.push({
        url: proxyUrl,
        format: Format.hls,
        label: `VidStorm ${label}`,
        audioLabel: srv.language || 'English',
        height,
      });
    }
  } catch (e) {
    console.log(`[raflix] VidStorm resolution failed: ${e?.message?.slice(0, 80)}`);
  }
  return out;
}

// ─── CinePro (Anicine Embed worker) server-side resolution ─────────────
// The "Anicine Embed" server URL (api.anicine-embed.workers.dev/movie/{id})
// is an HTML SPA shell — UNPLAYABLE in mpv ("[mpv] unrecognized file format"
// was shipped to users this way). But the worker behind it exposes a fully
// server-resolvable API (reverse-engineered from its JS bundle):
//   1. GET /v1/token                              → { token }
//   2. GET /v1/movies/{tmdbId}                    → { sources: [...] }
//      GET /v1/tv/{tmdbId}/seasons/{s}/episodes/{e}
//      (Authorization: Bearer <token>)
//   3. Each source URL is the worker's own /v1/proxy?data=<b64url-json>
//      wrapper; decoding `data` yields the REAL upstream m3u8 URL plus the
//      exact User-Agent/Referer it requires.
// The upstream playlists use RELATIVE variant URLs, so streams are routed
// through the addon's /proxy (referer=) which rewrites the whole HLS tree.
let _cineproToken = { token: null, ts: 0 };
const CINEPRO_TOKEN_TTL = 50 * 60 * 1000; // server-side expiresAt ≈ 1h

const CINEPRO_WORKER = 'https://api.anicine-embed.workers.dev';

async function cineproFetch(url, headers, timeoutMs = 12000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getCineproToken(force = false) {
  if (!force && _cineproToken.token && Date.now() - _cineproToken.ts < CINEPRO_TOKEN_TTL) {
    return _cineproToken.token;
  }
  const d = await cineproFetch(`${CINEPRO_WORKER}/v1/token`, { 'User-Agent': UA });
  if (!d?.token) throw new Error('no token in response');
  _cineproToken = { token: d.token, ts: Date.now() };
  return _cineproToken.token;
}

// Resolve CinePro sources → [{ url, referer, userAgent, label }]
// Task 63: api.anicine-embed.workers.dev is DNS-DEAD (ENOTFOUND verified from
// sandbox AND Render, Sep 2026 — the worker was deleted). Each resolve paid
// 2×12s timeouts before returning []. Memoize the network-dead verdict for
// 10 minutes; self-heals if the worker ever comes back.
let _cineproDeadUntil = 0;

async function resolveCinePro(mediaType, tmdbId, season, episode) {
  const out = [];
  if (Date.now() < _cineproDeadUntil) return out;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const token = await getCineproToken(attempt > 0);
      const auth = { 'User-Agent': UA, Authorization: `Bearer ${token}` };
      const apiPath = mediaType === 'tv'
        ? `${CINEPRO_WORKER}/v1/tv/${tmdbId}/seasons/${season || 1}/episodes/${episode || 1}`
        : `${CINEPRO_WORKER}/v1/movies/${tmdbId}`;
      const data = await cineproFetch(apiPath, auth);
      const sources = Array.isArray(data?.sources) ? data.sources : [];

      for (const [i, s] of sources.entries()) {
        const rawUrl = typeof s?.url === 'string' ? s.url : '';
        if (!rawUrl) continue;
        // Preferred: decode the worker's signed /v1/proxy?data= blob to get the
        // REAL upstream URL + headers — lets our /proxy rewrite the HLS tree
        // (upstream playlists use relative variant URLs) instead of depending
        // on the worker's own proxy for every segment.
        const m = rawUrl.match(/[?&]data=([^&]+)/);
        if (m) {
          try {
            const blob = JSON.parse(decodeURIComponent(m[1]));
            if (blob?.url && typeof blob.url === 'string' && blob.url.startsWith('http')) {
              out.push({
                url: blob.url,
                referer: blob.headers?.Referer || '',
                userAgent: blob.headers?.['User-Agent'] || '',
                label: `CinePro ${i + 1}`,
              });
              continue;
            }
          } catch { /* blob decode failed — fall through */ }
        }
        // Fallback: ship the worker's proxy URL as-is ONLY if it looks like HLS
        if (/\.m3u8|\/m3u8|\/playlist/i.test(rawUrl)) {
          out.push({ url: rawUrl, referer: '', userAgent: '', label: `CinePro ${i + 1}` });
        }
      }
      return out;
    } catch (e) {
      if (attempt === 1) {
        const msg = e?.message || String(e);
        console.log(`[raflix] CinePro resolution failed: ${msg.slice(0, 80)}`);
        // DNS/network-dead worker (fetch failed / ENOTFOUND / ECONNRESET):
        // stop paying the 2×12s timeout on every resolve for 10 minutes.
        if (/fetch failed|ENOTFOUND|ECONNRESET|EAI_AGAIN|timeout|abort/i.test(msg)) {
          _cineproDeadUntil = Date.now() + 10 * 60 * 1000;
        }
        return out;
      }
      // 401/expired-token path — retry once with a fresh token
    }
  }
  return out;
}

// Fetch anime sources (sub + dub)
async function fetchAnimeSources(tmdbId, title, season, episode, year) {
  const results = { sub: [], dub: [] };

  for (const dub of [0, 1]) {
    const params = new URLSearchParams({
      tmdbId: String(tmdbId),
      title,
      season: String(season || 1),
      episode: String(episode || 1),
      dub: String(dub),
    });
    if (year) params.set('year', String(year));

    const data = await gotJson(`${BASE_URL}/api/anime/sources?${params.toString()}`);
    if (data?.ok && Array.isArray(data.sources)) {
      const lang = dub === 1 ? 'dub' : 'sub';
      results[lang] = data.sources;
    }
  }

  return results;
}

export class Raflix extends Source {
  constructor(fetcher) {
    super();
    this.id = 'raflix';
    this.label = 'Raflix';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en, CountryCode.ja];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const isAnime = await isAnimeContent(this.fetcher, ctx, tmdbId);
    const mediaType = tmdbId.season ? 'tv' : 'movie';
    const season = tmdbId.season || null;
    const episode = tmdbId.episode || null;

    const results = [];

    if (isAnime) {
      // Fetch anime sources (sub + dub)
      console.log(`[raflix] Fetching anime sources for ${name}...`);
      const animeSources = await fetchAnimeSources(tmdbId.id, name, season, episode, year);

      for (const [lang, sources] of Object.entries(animeSources)) {
        for (const src of sources) {
          if (!src.url || typeof src.url !== 'string') continue;
          if (!src.url.startsWith('http')) continue;

          let url;
          try { url = new URL(src.url); } catch { continue; }

          const isDub = lang === 'dub';
          const countryCodes = isDub
            ? [CountryCode.multi, CountryCode.en, CountryCode.ja]
            : [CountryCode.multi, CountryCode.ja, CountryCode.en];

          const audioLabel = isDub ? 'English (Dub)' : 'Japanese (Sub)';

          results.push({
            url,
            format: Format.hls,
            meta: {
              countryCodes,
              title: `${title} — [Raflix ${src.label}] ${audioLabel}`,
              sourceId: this.id,
              sourceLabel: this.label,
              height: 1080,
              sourceType: 'WebDL',
              codec: 'x264',
              serverName: `${src.label} ${lang.toUpperCase()}`,
              audioLabel: isDub ? 'English' : 'Japanese',
              isMultiAudio: true,
            },
          });
        }
      }
    } else {
      // Fetch movie/TV sources
      // Task 71: the three resolution stages are INDEPENDENT (raflixx API,
      // CinePro worker, VidStorm worker) — they used to run SEQUENTIALLY
      // (12s timeout each + 6s per-server validations) which under Render
      // 0.1-CPU contention stretched past the resolver's 35s cutoff →
      // status:timeout, count:0 in every merged resolve (measured
      // production 2026-09-21) even though each stage is healthy isolated
      // (11.4s total). Parallel fan-out caps wall time at the slowest stage
      // instead of the sum. Results are pushed in the original stage order
      // so card ordering is unchanged.
      console.log(`[raflix] Fetching media sources for ${name}...`);
      const [sources, cinepro, vidstorm] = await Promise.allSettled([
        fetchMediaSources(mediaType, tmdbId.id, season, episode),
        resolveCinePro(mediaType, tmdbId.id, season, episode),
        resolveVidStorm(ctx, mediaType, tmdbId.id, season, episode),
      ]);
      const sourcesArr = sources.status === 'fulfilled' ? (sources.value || []) : (console.log(`[raflix] media sources failed: ${sources.reason?.message?.slice(0, 80)}`), []);
      const cineproArr = cinepro.status === 'fulfilled' ? (cinepro.value || []) : (console.log(`[raflix] cinepro failed: ${cinepro.reason?.message?.slice(0, 80)}`), []);
      const vidstormArr = vidstorm.status === 'fulfilled' ? (vidstorm.value || []) : (console.log(`[raflix] vidstorm failed: ${vidstorm.reason?.message?.slice(0, 80)}`), []);

      for (const src of sourcesArr) {
        if (!src.url || typeof src.url !== 'string') continue;
        if (!src.url.startsWith('http')) continue;

        let url;
        try { url = new URL(src.url); } catch { continue; }

        results.push({
          url,
          format: Format.hls,
          meta: {
            countryCodes: [CountryCode.multi, CountryCode.en],
            title: `${title} — [Raflix ${src.label}]`,
            sourceId: this.id,
            sourceLabel: this.label,
            height: 1080,
            sourceType: 'WebDL',
            codec: 'x264',
            serverName: src.label,
            audioLabel: 'English',
          },
        });
      }

      // CinePro server-side resolution (the "Anicine Embed" server). The raw
      // anicine URL above is an HTML SPA shell that mpv cannot play — resolve
      // it to real HLS sources instead. These use the dedicated 'raflixnuvio'
      // sourceId (NOT 'raflix') so NuvioExtractor claims ONLY these streams
      // and routes them through /proxy with whole-tree Referer rewriting;
      // the raw embed results above keep flowing through the normal
      // extractor registry untouched.
      for (const cp of cineproArr) {
        let url;
        try { url = new URL(cp.url); } catch { continue; }

        const meta = {
          countryCodes: [CountryCode.multi, CountryCode.en],
          title: `${title} — [Raflix ${cp.label}]`,
          sourceId: 'raflixnuvio',
          sourceLabel: this.label,
          height: 1080,
          sourceType: 'WebDL',
          codec: 'h264',
          serverName: cp.label,
          audioLabel: 'English',
          nuvioProvider: true,
          ...(cp.referer && { nuvioReferer: cp.referer }),
          ...(cp.userAgent && { nuvioUserAgent: cp.userAgent }),
        };

        results.push({ url, format: Format.hls, meta });
      }
      if (cineproArr.length > 0) {
        console.log(`[raflix] +${cineproArr.length} CinePro stream(s) (server-resolved)`);
      }

      // VidStorm server-side resolution (Task 63) — the only raflixx upstream
      // that still resolves from a datacenter IP. Playlist-validated cards
      // through /proxy (origin-gated); dead servers drop honestly.
      // sourceId 'raflixvidstorm' (dedicated pseudo-ID like 'raflixnuvio') so
      // NuvioExtractor's already-proxied passthrough ships them unchanged —
      // under the plain 'raflix' id they matched NO extractor and were
      // silently dropped at the extraction stage (0 VidStorm cards in /stream).
      for (const vs of vidstormArr) {
        results.push({
          url: vs.url,
          format: vs.format,
          meta: {
            countryCodes: [CountryCode.multi, CountryCode.en],
            title: `${title} — [Raflix ${vs.label}]`,
            sourceId: 'raflixvidstorm',
            sourceLabel: this.label,
            height: vs.height,
            sourceType: 'WebDL',
            codec: 'h264',
            serverName: vs.label,
            audioLabel: vs.audioLabel,
          },
        });
      }
      if (vidstormArr.length > 0) {
        console.log(`[raflix] +${vidstormArr.length} VidStorm stream(s) (server-resolved)`);
      }
    }

    console.log(`[raflix] ${results.length} stream(s)${isAnime ? ' [anime]' : ''}`);
    return results;
  }
}
