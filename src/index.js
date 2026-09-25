// src/index.js — PhoeniX addon entry point (WebStreamrMBG port)

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { Fetcher } from './utils/Fetcher.js';
import { createSources } from './source/index.js';
import { createExtractors, ExtractorRegistry } from './extractor/index.js';
import { StreamResolver } from './utils/StreamResolver.js';
import { ImdbId, TmdbId } from './utils/id.js';
import { createRequire } from 'module';
// Task 49: shared subtitle module — used by the /debug/subs diagnostic.
const { fetchUnifiedSubs } = createRequire(import.meta.url)('./utils/siteSubtitles.cjs');
import { reanimeSegmentKey } from './utils/site-secrets.cjs';
// Task 54: playback-priority gate — /proxy + /range-proxy raise it while
// serving so the resolver's post-budget background work can yield to playback.
import playbackGate from './utils/playbackGate.cjs';
// Task 74: idle cache keeper — see utils/cacheKeeper.js. Keeps the per-source
// caches of user-opened titles warm while the instance is idle, so an
// UptimeRobot-kept-alive instance delivers warm-round card sets on round 1.
import { startCacheKeeper, recordUserRequest, getCacheKeeperInfo } from './utils/cacheKeeper.js';

// Task 89: egress watch — periodic background prober for the upstream-gated
// sources (kmmovies CF gate, acer backend cache-fill) + Render egress-IP
// rotation tracking. Pure telemetry: see utils/EgressWatch.js safety rules.
import { startEgressWatch, getEgressWatchSummary, getEgressWatchInfo } from './utils/EgressWatch.js';
// Task 90: /status live page — passive per-source outcome telemetry
// (recorded inside StreamResolver) merged with the egress watch probes.
import { getSourceStatus, watchVerdictFor } from './utils/SourceStatus.js';
import { ANIME_ONLY_SOURCE_IDS } from './utils/StreamResolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 7000;
const HOST = process.env.HOST || '0.0.0.0';
const ADDON_NAME = process.env.ADDON_NAME || 'PhoeniX';
const VERSION = '1.3.0';

// Task 74: reliable boot telemetry. /debug/env reads globalThis.__phoenixBootAt
// but it was never SET anywhere, so startedAt silently fell back to a
// per-request Date.now() — set it once at module load instead.
globalThis.__phoenixBootAt = Date.now();
// Task 74: instance identity for the /health watcher. Distinguishes
// multi-instance deployments (each instance gets its own RENDER_INSTANCE_ID)
// and boot recycles — the objective answer to "UptimeRobot keeps it awake,
// why is it still cold?".
const INSTANCE_ID = process.env.RENDER_INSTANCE_ID || `local-${process.pid}`;
// Task 74: keepalive probe visibility — UptimeRobot pings `/` every few
// minutes; if rootHits does not climb, the monitor is NOT pointed at this
// deployment (that alone explains spin-downs "despite UptimeRobot").
let rootHits = 0;
let lastRootHitAt = null;

const logger = console;

const fetcher = new Fetcher(logger);
const sources = createSources(fetcher);
const extractors = createExtractors(fetcher, logger);
const extractorRegistry = new ExtractorRegistry(logger, extractors);
const streamResolver = new StreamResolver(logger, extractorRegistry, fetcher);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files (logo)
app.use('/public', express.static(join(__dirname, '..', 'public')));

// ============== MANIFEST ==============
app.get('/manifest.json', (req, res) => {
  const hostUrl = `https://${req.headers.host}`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    id: 'community.phoenix.addon',
    version: VERSION,
    name: ADDON_NAME,
    description: 'Stream movies, series and anime in HD.',
    logo: `${hostUrl}/public/logo.png?v=${VERSION}`,
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'tmdb:'],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false },
  });
});

// ============== STREAM ==============
app.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;

  if (type !== 'movie' && type !== 'series') {
    return res.json({ streams: [] });
  }

  let parsedId;
  try {
    if (id.startsWith('tmdb:')) {
      parsedId = TmdbId.fromString(id.replace('tmdb:', ''));
    } else if (id.startsWith('tt')) {
      parsedId = ImdbId.fromString(id);
    } else {
      return res.status(400).json({ error: `Unsupported ID: ${id}` });
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const ctx = {
    hostUrl: new URL(`https://${req.headers.host}`),
    id: req.headers['x-request-id'] || '',
    ip: req.ip,
    config: { multi: 'on', en: 'on' },
  };

  // Task 74: feed the idle cache keeper (records hot titles; no-op when disabled)
  recordUserRequest(type, id);
  logger.log(`[${ADDON_NAME}] stream ${type} ${id}`);

  try {
    const startTime = Date.now();
    let streams;
    ({ streams } = await streamResolver.resolve(ctx, sources, type, parsedId));
    const duration = Date.now() - startTime;
    logger.log(`[${ADDON_NAME}] ${type} ${id} → ${streams.length} streams in ${duration}ms`);

    // Starved-response cache hint: when a response carries fewer streams than
    // the resolver had sources available, the request almost certainly hit the
    // global deadline before slow sources finished (cold start, free-tier CPU
    // spike, upstream latency). Caching that starved result for 5 minutes
    // (previous behavior) locked the user out of the full set — by the time a
    // retry arrived, the per-source caches were warm but the app kept showing
    // the cached starved response.
    // Task 69: partial responses are now NOT cached at all (no-store) —
    // the 30s HTTP cache served the SAME starved set to refreshes arriving
    // within its window, directly producing the "refresh shows the same few
    // streams" loop. Every refresh must reach the resolver so it picks up the
    // background-warmed per-source caches. Fully populated responses keep the
    // 5-minute TTL (byte-identical behavior for the converged case). The
    // decision uses the resolver's own partial flag (allSettled=false →
    // no-store): a fully-settled movie response routinely carries fewer cards
    // than the 72-source registry (20+ anime sources skipped by Task 69), so
    // the old `streams.length < sources.length` heuristic wrongly no-stored
    // converged responses.
    const starved = streamResolver._lastResolveWasPartial === true;
    // Task 75/76 — token-age window on the HTTP cache. Converged responses
    // were cached for 5 minutes, but the SHORTEST-lived families re-resolve
    // far faster than that (movielinkbd 3min CDN rotation — Task 58 measured
    // "FILE DELETED" 403s on cards older than the rotation window; anikage
    // megg tokens; the 5min token families). A client re-serving a 5-min-old
    // converged JSON could embed a URL up to ttl+5min old — already past its
    // upstream death for the 3min families → playback error with zero chance
    // of recovery (the list the player holds simply contains a dead token).
    // USER REQUEST (Task 76): cap raised from 60s into the 2-3min range —
    // 150s (2.5min, midpoint). Worst-case URL age at play = ttl+2.5min
    // (≈5.5min for the 3min families, still around the measured movielinkbd
    // rotation edge); re-opens within the window are served instantly by the
    // client without a server round. Partial responses stay no-store
    // (Task 69) — every refresh reaches the resolver.
    res.setHeader('Cache-Control', starved ? 'no-store' : 'public, max-age=150');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({ streams });
  } catch (err) {
    logger.error(`[${ADDON_NAME}] Stream error: ${err.message}`);
    res.json({ streams: [] });
  }
});

// ============== EXTRACT (lazy extraction) ==============
app.get('/extract', async (req, res) => {
  const rawUrl = req.query.url;
  const rawIndex = req.query.index;

  if (!rawUrl || !rawIndex) {
    return res.status(400).json({ error: 'Missing url or index parameter' });
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid url parameter' });
  }

  const index = parseInt(rawIndex);
  if (isNaN(index)) {
    return res.status(400).json({ error: 'Invalid index parameter' });
  }

  const ctx = {
    hostUrl: new URL(`https://${req.headers.host}`),
    id: req.headers['x-request-id'] || '',
    ip: req.ip,
    config: {},
  };

  logger.log(`[${ADDON_NAME}] extract index ${index} of ${url.href}`);

  try {
    const urlResults = await extractorRegistry.handle(ctx, url);
    const urlResult = urlResults[index];

    if (!urlResult || urlResult.error) {
      return res.status(503).send('Service Unavailable');
    }

    res.redirect(urlResult.url.href);
  } catch (err) {
    logger.error(`[${ADDON_NAME}] Extract error: ${err.message}`);
    res.status(504).send('Gateway Timeout');
  }
});

// ============== PROXY (stream content through addon) ==============
// Used by sources whose CDN hosts may be DNS-blocked on the user's device
// (e.g. fsharetv.cc). The addon fetches the content and streams it back,
// so DNS resolution happens on the server, not the user's device.
//
// For .m3u8 playlists, relative URLs inside the playlist are rewritten to
// /proxy URLs pointing back to this addon (with the same Referer). This
// ensures the player fetches variant playlists and segments through the
// proxy with the correct Referer header — without it, the player resolves
// relative URLs against the proxy URL itself (phoenix-hgs3.onrender.com)
// and gets 404s.
app.get('/proxy', async (req, res) => {
  // Task 54: mark playback traffic — background source starts wait for quiet.
  // res 'close' fires on BOTH normal finish and client abort → gate always released.
  playbackGate.begin();
  res.on('close', () => playbackGate.end());
  const rawUrl = req.query.url;
  const rawReferer = req.query.referer;
  // origin=: optional Origin header forwarded upstream (Stellar's workers CDNs
  // reject playlist/segment requests without Origin: https://stellar.gdn).
  // Like referer=, it is ALSO propagated onto every rewritten m3u8 URL below
  // so the whole variant/segment tree authenticates identically. Additive:
  // absent for every pre-existing proxy consumer → byte-identical behavior.
  const rawOrigin = req.query.origin;
  // forceHls=1: when set, the proxy buffers the response and checks if it's
  // HLS (regardless of URL pattern). Used by Nuvio source adapters for URLs
  // that return HLS content but don't have .m3u8 in the path (e.g. vidlove
  // returns application/vnd.apple.mpegurl from /api?d=... endpoint).
  let forceHls = req.query.forceHls === '1';
  // hls=1: explicit "this URL is part of a proxied HLS tree" marker that
  // rewriteM3u8Urls propagates onto rewritten child URLs (stellar-style
  // origin-gated trees whose variant paths like cdn.reallyfast.ch/v/<token>
  // match NO urlIsM3u8 pattern and would otherwise be served raw, leaving
  // absolute segment URLs that the player then fetches without Origin → 403).
  // Same buffered-rewrite treatment as forceHls, but ALSO suppresses the
  // default Range injection (playlists are truncated/400'd by some workers
  // when a spurious Range is sent).
  if (req.query.hls === '1') forceHls = true;

  if (!rawUrl) {
    return res.status(400).send('Missing url parameter');
  }

  let targetUrl;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    return res.status(400).send('Invalid url parameter');
  }

  logger.log(`[${ADDON_NAME}] proxy ${targetUrl.hostname}${targetUrl.pathname.slice(0, 50)}`);

  try {
    // ———— Opt-in decrypt mode (Stream Reverse Engineering guide §6) ————
    // When xor= is present the upstream body is auto-detected and decrypted:
    // WebP/PNG-disguised XOR segments, base64(+XOR) m3u8 playlists, or
    // whole-body XOR (implementation: utils/stream-decrypt.cjs). Opt-in ONLY:
    // without these params the original proxy path below runs unchanged.
    // Params: xor=<b64|hex key>  strip=<n header bytes>  b64m3u8=1  ct=<mime>
    if (req.query.xor) {
      const { decryptProxyResponse } = await import('./utils/stream-decrypt.cjs');
      return await decryptProxyResponse({
        req, res, targetUrl,
        rawXor: req.query.xor,
        referer: rawReferer,
        stripHint: req.query.strip,
        expectBase64: req.query.b64m3u8 === '1',
        ctOverride: req.query.ct,
        logger,
        addonName: ADDON_NAME,
        rewrite: (text) => rewriteM3u8Urls(text, targetUrl, rawReferer, req, {
          xor: req.query.xor,
          ...(req.query.strip ? { strip: req.query.strip } : {}),
          ...(req.query.ct ? { ct: req.query.ct } : {}),
          ...(rawOrigin ? { origin: rawOrigin } : {}),
        }),
      });
    }

    const proxyHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };
    if (rawReferer) proxyHeaders['Referer'] = rawReferer;
    if (rawOrigin) proxyHeaders['Origin'] = rawOrigin;
    // Pass through Range header for seeking. Some CDNs (workers.dev) require
    // a Range header to return 206 — if Stremio doesn't send one, add a
    // default Range to get the first byte (which triggers 206 + seekability).
    if (req.headers.range) {
      proxyHeaders['Range'] = req.headers.range;
    } else if (!forceHls) {
      // Default Range only for non-HLS-tree requests — workers CDNs serving
      // playlists/segments (stellar themepark) truncate or 400 Range'd
      // playlists. Existing consumers (no hls/forceHls param) unchanged.
      proxyHeaders['Range'] = 'bytes=0-';
    }

    // Use got-scraping for Cloudflare bypass — plain fetch() gets 403
    // from workers.dev and other CF-protected CDN hosts.
    const { gotScraping } = await import('got-scraping');
    const { HeaderGenerator } = await import('header-generator');

    // For Cloudflare-protected CDNs (Netlio: aurorionacademy.site,
    // professionalidentity.cyou, etc.), use HeaderGenerator to generate
    // browser-like headers that pass CF's JS challenge.
    // Task 57: the CDN host ROTATES (mortgagerefinance.cfd observed live —
    // Squid Game S1E1 challenge-page shipped to players = mpv error). Match
    // the Netlio extractor's own identification instead of playing
    // whack-a-mole with hostnames: known hosts OR the distinctive path
    // markers (cf-master, /v4/, /hls3/ — verbatim from
    // src/extractor/Netlio.js isNetlioCdnUrl). HeaderGenerator browser
    // headers are harmless for non-CF hosts on the same paths.
    const isNetlioCdn = /aurorionacademy|professionalidentity|netrocdn|savannahridgedesignlab|creativewritingtips|harborlanecreativeworks|pinecliffdesigncollective|mortgagerefinance/.test(targetUrl.hostname) ||
                        /cf-master|\/v4\/|\/hls3\//.test(targetUrl.pathname.toLowerCase());
    if (isNetlioCdn) {
      const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });
      const browserHeaders = hg.getHeaders({ httpVersion: '2' });
      // Merge browser headers with our proxy headers (Referer, Range)
      Object.assign(proxyHeaders, browserHeaders);
      if (rawReferer) proxyHeaders['Referer'] = rawReferer;
      if (rawOrigin) proxyHeaders['Origin'] = rawOrigin;
      if (req.headers.range) proxyHeaders['Range'] = req.headers.range;
      else proxyHeaders['Range'] = 'bytes=0-';
    }
    // Task 79: atlantic.st payload workers (peraspera/totallyacdn) soft-decoy
    // requests lacking the browser's fetch headers — 200 text/html SPA shell
    // instead of the playlist. The source now validates cards with the full
    // browser header set (src/nuvio/atlantic.cjs HEADERS); the proxy must send
    // the SAME set at play time or validated cards still fail in the player.
    const atlHost = targetUrl.hostname.toLowerCase();
    const isAtlanticPayload = /(^|\.)totallyacdn\.org$/i.test(atlHost) ||
                              atlHost === 'peraspera.nbsycfzrpa4.workers.dev';
    if (isAtlanticPayload) {
      proxyHeaders['Accept-Language'] = 'en-US,en;q=0.9';
      proxyHeaders['Sec-Fetch-Dest'] = 'empty';
      proxyHeaders['Sec-Fetch-Mode'] = 'cors';
      proxyHeaders['Sec-Fetch-Site'] = 'cross-site';
    }

    // Check if this is an HLS playlist by URL extension OR by content.
    // Some CDNs (Netlio, AniNeko) disguise HLS playlists with .txt
    // extensions — detect those by checking the response body for #EXTM3U.
    // AniKage uses /m3u8/{token} paths (no .m3u8 extension).
    // AniKage also uses /stream/{token} for BOTH HLS variant playlists AND
    // MP4 streams (megg provider) — we need to check content-type to distinguish.
    // AniPriv8 uses /api/secure/pipeline/{token} for BOTH m3u8 playlists AND
    // MPEG-TS segments — detect by content (small = playlist, large = segment).
    // ZXCStream Berkas uses *.berkasNN.workers.dev/?data=... for BOTH master
    // m3u8 playlists AND variant playlists — detect by hostname pattern.
    const pathLower = targetUrl.pathname.toLowerCase();
    const hostLower = targetUrl.hostname.toLowerCase();
    const urlIsM3u8 = pathLower.endsWith('.m3u8') ||
                      pathLower.includes('.m3u8') ||
                      pathLower.includes('/m3u8/') ||
                      pathLower.includes('/m3u8?') ||  // AniChan /api/watch/m3u8?sh=...
                      pathLower.includes('/playlist');  // goated cdn.reallyfast.xyz/playlist/, DesiFlix vixsrc.to/playlist/
    const urlIsStream = pathLower.includes('/stream/');  // AniKage: could be HLS or MP4
    const urlIsAniPriv8 = pathLower.includes('/api/secure/pipeline/');
    // Berkas: *.berkas*.workers.dev — master m3u8 and variant playlists
    const urlIsBerkas = hostLower.includes('berkas') && hostLower.endsWith('.workers.dev');

    if (forceHls || urlIsM3u8 || urlIsStream || urlIsAniPriv8 || urlIsBerkas) {
      // Buffer content to check if it's HLS and rewrite URLs.
      // For /stream/ paths, use a HEAD request first to check content-type —
      // if it's video/mp4, stream directly (avoid buffering large MP4 files).
      if (urlIsStream) {
        try {
          const headRes = await gotScraping.head(targetUrl.href, {
            headers: proxyHeaders,
            timeout: { request: 8000 },
            throwHttpErrors: false,
            followRedirect: true,
          });
          const ct = (headRes.headers['content-type'] || '').toLowerCase();
          if (ct.includes('video/') || ct.includes('application/octet-stream')) {
            // It's a video file (MP4) — stream directly, skip HLS rewriting
            urlIsStream = false; // fall through to streaming mode
          }
        } catch { /* HEAD failed — try buffering (might be HLS) */ }
      }

      // For AniPriv8, use a HEAD request to check Content-Length —
      // m3u8 playlists are small (< 100KB), segments are large (> 1MB).
      // Only buffer if it's likely a playlist (avoid OOM on large segments).
      if (urlIsAniPriv8) {
        try {
          const headRes = await gotScraping.head(targetUrl.href, {
            headers: proxyHeaders,
            timeout: { request: 8000 },
            throwHttpErrors: false,
            followRedirect: true,
          });
          const cl = parseInt(headRes.headers['content-length'] || '0');
          // Segments are typically > 500KB — stream directly, skip buffering
          if (cl > 500000) {
            urlIsAniPriv8 = false; // fall through to streaming mode
          }
        } catch { /* HEAD failed — try buffering (might be playlist) */ }
      }

      // For forceHls (ambiguous URL): do a HEAD request first to check
      // Content-Type. If it's a video file (MP4/MKV), skip buffering to
      // avoid OOM on Render's 512MB tier.
      if (forceHls) {
        try {
          const headRes = await gotScraping.head(targetUrl.href, {
            headers: proxyHeaders,
            timeout: { request: 8000 },
            throwHttpErrors: false,
            followRedirect: true,
          });
          const ct = (headRes.headers['content-type'] || '').toLowerCase();
          if (ct.includes('video/') || ct.includes('application/octet-stream')) {
            // Video file — stream directly (skip buffering)
            forceHls = false; // fall through to streaming mode
          }
        } catch { /* HEAD failed — try buffering (might be HLS) */ }
      }

      if (forceHls || urlIsM3u8 || urlIsStream || urlIsAniPriv8 || urlIsBerkas) {
        // Buffer content to check if it's HLS and rewrite URLs.
        // Use HTTP/1.1 (http2: false) to avoid "GOAWAY" errors from some
        // servers (e.g. vidlove) that close HTTP/2 connections aggressively.
        // Add 1 retry to handle transient GOAWAY errors.
        let m3u8Res, lastErr;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            m3u8Res = await gotScraping.get(targetUrl.href, {
              headers: proxyHeaders,
              timeout: { request: 30000 },
              throwHttpErrors: false,
              followRedirect: true,
              http2: false,
              // Task 60: got's built-in retry (default 2× on 429/network errors)
              // stacks 30s timeouts into 45s+ hangs on CF-gated payload workers
              // (Atlantic peraspera class) — the handler's own fallbacks
              // (GOAWAY retry below + fingerprint fetch + 5xx retry on streams)
              // cover transients with bounded latency instead.
              retry: { limit: 0 },
            });
            break;
          } catch (e) {
            lastErr = e;
            const msg = e?.message || String(e);
            if (msg.includes('GOAWAY') || msg.includes('stream') || msg.includes('HTTP/2')) {
              await new Promise(r => setTimeout(r, 500));
              continue;
            }
            throw e;
          }
        }
        if (!m3u8Res) throw lastErr;

        // Task 54 fix3 — FINGERPRINT FALLBACK: some CDN hosts in the vidking
        // family reject got-scraping's browser TLS/header fingerprint with 404
        // while serving plain undici fetch. Verified LIVE on
        // i-cdn-*.salsa436jam.com (hdmovie/cineby family): same signed URL —
        // got-scraping 404, plain fetch 200 '#EXTM3U'. Before declaring
        // "Upstream error: 404" (which shipped dead-looking cards that were
        // actually ALIVE), retry once with plain global fetch and use it when
        // it succeeds. Only reachable on the previously-broken path — zero
        // behavior change for healthy upstreams.
        if (m3u8Res.statusCode >= 400) {
          const origStatus = m3u8Res.statusCode;
          try {
            const alt = await fetch(targetUrl.href, {
              headers: proxyHeaders,
              redirect: 'follow',
              signal: AbortSignal.timeout(15000),
            });
            if (alt.ok) {
              const text = await alt.text();
              m3u8Res = {
                statusCode: alt.status,
                headers: { get: (k) => alt.headers.get(k) },
                body: text,
              };
              logger.log(`[${ADDON_NAME}] proxy fingerprint-fallback OK for ${targetUrl.hostname} (got-scraping got ${origStatus})`);
            }
          } catch { /* keep the got-scraping failure */ }
        }
        if (m3u8Res.statusCode >= 400) {
          logger.error(`[${ADDON_NAME}] proxy upstream ${m3u8Res.statusCode} for ${targetUrl.hostname}`);
          return res.status(m3u8Res.statusCode).send(`Upstream error: ${m3u8Res.statusCode}`);
        }

        const body = m3u8Res.body;
        const isHls = body.trimStart().startsWith('#EXTM3U');

        if (isHls) {
          // It's an HLS playlist — rewrite relative URLs to absolute /proxy URLs
          // (origin= rides along so variant/segment fetches keep authenticating;
          // hls=1 marks children so variant playlists get the rewrite path too
          // even when their URL shape matches no m3u8 pattern)
          const rewritten = rewriteM3u8Urls(body, targetUrl, rawReferer, req,
            rawOrigin ? { origin: rawOrigin, hls: '1' } : undefined);
          res.status(200);
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.setHeader('Content-Length', Buffer.byteLength(rewritten));
          res.send(rewritten);
          return;
        }

        // /stream/ path but not HLS — could be an MP4 or other video format.
        // If the content is small (< 1MB), it might be a redirect page or error.
        // If it's large, stream it directly.
        if (urlIsStream) {
          const contentLength = parseInt(m3u8Res.headers['content-length'] || '0');
          if (contentLength > 0 && contentLength < 1024 * 1024) {
            // Small response — serve as-is (might be a redirect or error page)
            res.status(200);
            const ct = m3u8Res.headers['content-type'] || 'application/octet-stream';
            res.setHeader('Content-Type', ct);
            res.setHeader('Content-Length', Buffer.byteLength(body));
            res.send(body);
            return;
          }
          // Large response — fall through to streaming mode
        }

        // forceHls but response wasn't HLS (HEAD said it might be, but body
        // doesn't start with #EXTM3U). Serve the buffered body directly.
        // HEAD already confirmed it's not a large video file (Content-Type
        // would have been video/* and forceHls would have been cleared).
        if (forceHls) {
          res.status(200);
          const ct = m3u8Res.headers['content-type'] || 'application/octet-stream';
          res.setHeader('Content-Type', ct);
          res.setHeader('Content-Length', Buffer.byteLength(body));
          res.send(body);
          return;
        }
      }
    }

    // Non-m3u8 content — stream directly to avoid OOM on Render's 512MB tier
    // Task 60: some CDNs (acek-cdn for HDHub4u 4K) intermittently 502/503/504
    // on SEGMENT requests while the same URL succeeds seconds later. One
    // idempotent retry (700ms backoff) converts those blips into a brief
    // pause instead of an mpv stall ("stuck on loading").
    const streamOnce = () => {
      const s = gotScraping.stream(targetUrl.href, {
        headers: proxyHeaders,
        timeout: { request: 30000 },
        throwHttpErrors: false,
        followRedirect: true,
        isStream: true,
        http2: false,  // Avoid GOAWAY errors from HTTP/2 servers
      });
      return s;
    };
    let stream = streamOnce();

    // Wait for the response headers
    const awaitResponse = (s) => new Promise((resolve, reject) => {
      s.on('response', (resp) => resolve(resp));
      s.on('error', (err) => reject(err));
      // Timeout if no response in 15s
      setTimeout(() => reject(new Error('proxy response timeout')), 15000);
    });

    let response;
    try {
      response = await awaitResponse(stream);
      if (response.statusCode >= 500 && response.statusCode <= 504) {
        // Retryable upstream blip — destroy and re-issue once.
        const st = response.statusCode;
        try { stream.destroy(); } catch {}
        await new Promise(r => setTimeout(r, 700));
        stream = streamOnce();
        response = await awaitResponse(stream);
        logger.log(`[${ADDON_NAME}] proxy retry after upstream ${st} → ${response.statusCode} for ${targetUrl.hostname}`);
      }
    } catch (e) {
      try { stream.destroy(); } catch {}
      throw e;
    }

    if (response.statusCode >= 400) {
      logger.error(`[${ADDON_NAME}] proxy upstream ${response.statusCode} for ${targetUrl.hostname}`);
      stream.destroy();
      // For workers.dev 403 (expired token) or text/html responses (redirect pages),
      // return a clean error so Stremio can try the next stream automatically.
      // Don't return 502 (looks like server error) — return the actual status.
      const ct = (response.headers['content-type'] || '').toLowerCase();
      if (response.statusCode === 403 || ct.includes('text/html') || ct.includes('text/plain')) {
        return res.status(response.statusCode).send(`Upstream error: ${response.statusCode}`);
      }
      return res.status(response.statusCode).send(`Upstream error: ${response.statusCode}`);
    }

    // ———— Task 60: subtitle files served through /proxy get NORMALIZED ————
    // natsuki (hls.lol) SRT files ship malformed cues ("0:00:00,00" — hours
    // not zero-padded, 2-digit milliseconds) as text/plain; mpv drops or
    // zero-duration-renders them → "subtitles not working" on every source.
    // Buffer small .srt/.vtt targets, convert to valid WebVTT, serve as
    // text/vtt. Already-valid VTT passes through the normalizer unchanged.
    const subPath = targetUrl.pathname.toLowerCase();
    if (subPath.endsWith('.srt') || subPath.endsWith('.vtt')) {
      try { stream.destroy(); } catch {} // release the passthrough connection
      // Fetch+convert, with two fallbacks (Task 60 production evidence: natsuki
      // hls.lol 403s headerless requests, and CF sometimes KILLS got-scraping's
      // browser-TLS fingerprint mid-flight from Render — the Task 54 fix3
      // salsa class). Order: got-scraping (CF bypass) → plain fetch → raw
      // stream passthrough (pre-Task-60 behavior; a working subtitle served
      // raw beats a 502).
      let subText = null;
      try {
        const subRes = await gotScraping.get(targetUrl.href, {
          headers: proxyHeaders,
          timeout: { request: 20000 },
          throwHttpErrors: false,
          followRedirect: true,
          http2: false,
          responseType: 'buffer',
        });
        if (subRes.statusCode < 400) subText = subRes.body.toString('utf8');
      } catch { /* fall through to plain fetch */ }
      if (subText === null) {
        try {
          const alt = await fetch(targetUrl.href, {
            headers: proxyHeaders,
            redirect: 'follow',
            signal: AbortSignal.timeout(15000),
          });
          if (alt.ok) subText = await alt.text();
        } catch { /* fall through to raw passthrough */ }
      }
      if (subText !== null) {
        try {
          const { toWebVtt } = await import('./utils/subtitle-normalize.cjs');
          const vtt = toWebVtt(subText);
          res.status(200);
          res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Content-Length', Buffer.byteLength(vtt));
          return res.send(vtt);
        } catch (e) {
          logger.error(`[${ADDON_NAME}] proxy subtitle normalize failed: ${e.message}`);
          if (!res.headersSent) return res.status(502).send('Subtitle proxy error');
          return;
        }
      }
      // Raw passthrough fallback — fetch failed both ways; stream the body
      // unconverted (old behavior) so the track at least loads where possible.
      logger.log(`[${ADDON_NAME}] proxy subtitle: both fetches failed — raw passthrough for ${targetUrl.hostname}`);
      const rawStream = gotScraping.stream(targetUrl.href, {
        headers: proxyHeaders,
        timeout: { request: 30000 },
        throwHttpErrors: false,
        followRedirect: true,
        isStream: true,
        http2: false,
      });
      try {
        const rawResp = await new Promise((resolve, reject) => {
          rawStream.on('response', (resp) => resolve(resp));
          rawStream.on('error', (err) => reject(err));
          setTimeout(() => reject(new Error('subtitle raw passthrough timeout')), 15000);
        });
        if (rawResp.statusCode >= 400) {
          try { rawStream.destroy(); } catch {}
          return res.status(rawResp.statusCode).send(`Upstream error: ${rawResp.statusCode}`);
        }
        res.status(rawResp.statusCode);
        const rawCt = rawResp.headers['content-type'];
        if (rawCt) res.setHeader('Content-Type', rawCt);
        rawStream.pipe(res);
        rawStream.on('error', () => { try { res.end(); } catch {} });
        return;
      } catch (e) {
        try { rawStream.destroy(); } catch {}
        if (!res.headersSent) return res.status(502).send('Subtitle proxy error');
        return;
      }
    }

    // Forward status code and headers
    res.status(response.statusCode);
    const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'];
    for (const h of forwardHeaders) {
      const v = response.headers[h];
      if (v) res.setHeader(h, v);
    }

    // Some upstreams serve MPEG-TS segments with Content-Type:
    // application/vnd.ms-excel — override to video/mp2t.
    // This must happen BEFORE the stream starts piping.
    const preCt = (response.headers['content-type'] || '').toLowerCase();
    const preSegPath = targetUrl.pathname.toLowerCase();
    if (preCt.includes("vnd.ms-excel")) {
      // Override Content-Type for .xls segments — don't pipe, send manually
      stream.destroy();
      try {
        const bufRes = await gotScraping.get(targetUrl.href, {
          headers: proxyHeaders,
          timeout: { request: 30000 },
          throwHttpErrors: false,
          followRedirect: true,
          http2: false,
          responseType: 'buffer',
        });
        if (!res.headersSent) {
          res.status(200);
          res.removeHeader('Content-Type');
          res.setHeader('Content-Type', 'video/mp2t');
          res.setHeader('Content-Length', bufRes.body.length);
          res.end(bufRes.body);
        }
        return;
      } catch (e) {
        if (!res.headersSent) res.status(502).send('Proxy error');
        return;
      }
    }
    // PlayIMDb segments return Content-Type: text/html — override to video/mp2t
    if (preCt.includes('text/html') && (preSegPath.includes('/content/') || preSegPath.endsWith('.html') || preSegPath.includes('page-'))) {
      stream.destroy();
      try {
        const bufRes = await gotScraping.get(targetUrl.href, {
          headers: proxyHeaders,
          timeout: { request: 30000 },
          throwHttpErrors: false,
          followRedirect: true,
          http2: false,
          responseType: 'buffer',
        });
        if (!res.headersSent) {
          res.status(200);
          res.removeHeader('Content-Type');
          res.setHeader('Content-Type', 'video/mp2t');
          res.setHeader('Content-Length', bufRes.body.length);
          res.end(bufRes.body);
        }
        return;
      } catch (e) {
        if (!res.headersSent) res.status(502).send('Proxy error');
        return;
      }
    }

    // AniPriv8 segments return Content-Type: image/png when Range is requested
    // (server bug). The body is valid MPEG-TS — override Content-Type so
    // Stremio's HLS player accepts it.
    if (urlIsAniPriv8) {
      const ct2 = (response.headers['content-type'] || '').toLowerCase();
      if (ct2.includes('image/png') || ct2.includes('application/octet-stream') || !ct2) {
        res.setHeader('Content-Type', 'video/mp2t');
      }
    }

    // PlayIMDb segments return Content-Type: text/html (server quirk).
    // The body is valid MPEG-TS data — override to video/mp2t so Stremio's
    // HLS player accepts it. Without this, Stremio shows "stuck on loading"
    // because it refuses to play text/html as video.
    // Also apply to any .html segment URLs from HLS playlists (PlayIMDb uses
    // page-N.html for segment names).
    const ct = (response.headers['content-type'] || '').toLowerCase();
    const segPath = targetUrl.pathname.toLowerCase();
    if (ct.includes('text/html') && (segPath.includes('/content/') || segPath.endsWith('.html') || segPath.includes('page-'))) {
      res.setHeader('Content-Type', 'video/mp2t');
    }
    if (ct.includes('vnd.ms-excel') || ct.includes('application/vnd.ms-excel')) {
      res.removeHeader('Content-Type');
      res.setHeader('Content-Type', 'video/mp2t');
    }

    // Stream the body — pipe directly to avoid buffering in memory
    stream.pipe(res);
    stream.on('error', () => { try { res.end(); } catch {} });
  } catch (err) {
    logger.error(`[${ADDON_NAME}] proxy error: ${err.message}`);
    if (!res.headersSent) res.status(502).send('Proxy error');
    else try { res.end(); } catch {}
  }
});

// ============================================================================
// /range-proxy — Range-translation proxy for CDNs that IGNORE Range headers
// (e.g. video-downloads.googleusercontent.com, lh3.googleusercontent.com).
//
// Google's video-downloads.googleusercontent.com returns HTTP 200 with the
// FULL file regardless of any Range header sent. This breaks video seeking
// in Stremio because the player needs 206 Partial Content + Content-Range
// to scrub to a specific timestamp.
//
// This endpoint:
//   1. Receives Stremio's Range header (e.g. bytes=5000000-10000000)
//   2. Fetches the FULL file from upstream as a stream (no Range sent upstream)
//   3. Uses a byte-counting Transform stream to:
//      - Drop bytes 0 to Range.start-1
//      - Pipe bytes Range.start to Range.end (or EOF) to Stremio
//   4. Returns 206 Partial Content + Content-Range + Accept-Ranges: bytes
//      + correct Content-Length so Stremio can seek properly.
//
// When no Range is sent, pipes the whole file with 200 + Accept-Ranges: bytes
// so Stremio knows it CAN seek on the next request.
//
// Performance note: seeking to a late position (e.g. byte 5GB of a 6GB file)
// requires downloading 5GB from upstream first. This is slow but WORKS —
// better than no seeking at all. Most playback starts from byte 0 (fast).
// ============================================================================
app.get('/range-proxy', async (req, res) => {
  // Task 54: same playback-priority marking as /proxy above.
  playbackGate.begin();
  res.on('close', () => playbackGate.end());
  const rawUrl = req.query.url;
  if (!rawUrl) {
    return res.status(400).send('Missing url parameter');
  }

  let targetUrl;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    return res.status(400).send('Invalid url parameter');
  }

  logger.log(`[${ADDON_NAME}] range-proxy ${targetUrl.hostname}${targetUrl.pathname.slice(0, 50)}`);

  // Task 62: google-family targets are REDIRECTED, not proxied. Measured live
  // (production evidence across 3 rounds x 16 card classes): google serves the
  // proxy request headers + first bytes, then HARD-STALLS the body forever
  // when the client is a datacenter IP (Render) — an escalation of the
  // 0.3-3.5Mbps throttle documented in Task 60. Every google card proxied
  // through Render died at frame 0-1. The SAME token fetched directly from a
  // non-datacenter IP (the user's device) streams at full speed — that is the
  // historic google-direct behavior that played 4K. Redirect the player to
  // the target URL: zero Render exposure (CPU/bandwidth/egress-IP), playback
  // via the user's own connection. google responds 200-no-range to the player
  // → libavformat marks the stream non-seekable and plays linearly (exactly
  // the historic working case); the /range-proxy Range-translation machinery
  // below remains for every OTHER Range-ignoring host.
  if (/(^|\.)google(usercontent)?\.com$/i.test(targetUrl.hostname)) {
    logger.log(`[${ADDON_NAME}] range-proxy: google-family target — 302 to direct (datacenter stall bypass)`);
    return res.redirect(302, targetUrl.href);
  }

  try {
    const { gotScraping } = await import('got-scraping');
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    // Task 62: the HEAD is GONE — under google's flaky windows it burned up
    // to 10s of TTFB (or poisoned the request) on every player open/seek, and
    // Task 60 fix4 already made the upstream GET the single source of truth
    // (it carries the player's Range and its Content-Length/Content-Type/
    // Content-Disposition are adopted below). One flaky roundtrip removed.
    let totalSize = 0;
    let contentType = 'application/octet-stream';
    let contentDisposition = null;

    const rangeHeader = req.headers.range;

    // Step 2: Parse Range header from Stremio (bounds finalized once size is known)
    let rangeStart = 0;
    let rangeEnd = totalSize > 0 ? totalSize - 1 : Number.MAX_SAFE_INTEGER;
    let hasRange = false;

    if (rangeHeader) {
      const m = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
      if (m) {
        hasRange = true;
        if (m[1]) rangeStart = parseInt(m[1], 10);
        if (m[2] && totalSize > 0) rangeEnd = parseInt(m[2], 10);
        // If start is empty but end is set: suffix range (last N bytes) —
        // only resolvable with a known size; deferred below otherwise.
        if (!m[1] && m[2] && totalSize > 0) {
          rangeStart = Math.max(0, totalSize - parseInt(m[2], 10));
          rangeEnd = totalSize - 1;
        }
        if (totalSize > 0) {
          if (rangeStart >= totalSize) {
            res.status(416);
            res.setHeader('Content-Range', `bytes */${totalSize}`);
            return res.end();
          }
          if (rangeEnd >= totalSize) rangeEnd = totalSize - 1;
        }
      }
    }

    // Step 3: Fetch from upstream — WITH the player's Range header first.
    // Task 60: the old code always fetched the full file and byte-skipped, so
    // ANY seek deep into a huge file (mpv preloading Matroska Cues near the
    // end of a 21GB 4K MKV) meant streaming+discarding tens of GB → the player
    // waited forever = "stuck on loading" for CineFreak/Pantyflix/MoviesDrive
    // 4K cards. Cases:
    //   a) upstream HONORS Range (206) → transparent pipe (true fast seeking);
    //   b) upstream ignores Range (200) and the skip is SMALL (≤ budget) →
    //      byte-skip transform as before (reuses the in-flight stream);
    //   c) upstream ignores Range and the skip is LARGE → connection RESET
    //      (Task 62 — see below; a 4xx status response KILLS libavformat).
    // Task 62: bounded RETRY on the upstream GET header phase. google flaps
    // (measured live: same URL+token 200 in 2.4s through us, 30s timeout
    // direct, intermittent 5xx) — a single blip used to surface as a 5XX to
    // the player = dead card. Retries are SAFE here: no client bytes have
    // flowed before the response headers are adopted.
    const RANGE_SKIP_BUDGET = Math.max(0, parseInt(process.env.RANGE_PROXY_SKIP_BUDGET_MB, 10) || 24) * 1048576;
    const upstreamReqHeaders = { 'User-Agent': UA, 'Accept': '*/*' };
    if (rangeHeader) upstreamReqHeaders['Range'] = String(rangeHeader);

    let upstreamStream = null;
    let upstreamResp = null;
    const UPSTREAM_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= UPSTREAM_ATTEMPTS; attempt++) {
      const stream = gotScraping.stream(targetUrl.href, {
        headers: upstreamReqHeaders,
        timeout: { request: 60000 },
        throwHttpErrors: false,
        followRedirect: true,
        isStream: true,
        http2: false,  // HTTP/1.1 for better streaming compatibility
      });
      try {
        const resp = await new Promise((resolve, reject) => {
          stream.on('response', (r) => resolve(r));
          stream.on('error', (err) => reject(err));
          setTimeout(() => reject(new Error('range-proxy upstream timeout')), 15000);
        });
        if (resp.statusCode >= 500 && attempt < UPSTREAM_ATTEMPTS) {
          logger.error(`[${ADDON_NAME}] range-proxy upstream ${resp.statusCode} (attempt ${attempt}/${UPSTREAM_ATTEMPTS}), retrying`);
          try { stream.destroy(); } catch {}
          await new Promise(r => setTimeout(r, 800));
          continue;
        }
        upstreamStream = stream;
        upstreamResp = resp;
        break;
      } catch (e) {
        try { stream.destroy(); } catch {}
        if (attempt < UPSTREAM_ATTEMPTS) {
          logger.error(`[${ADDON_NAME}] range-proxy upstream connect failed (attempt ${attempt}/${UPSTREAM_ATTEMPTS}): ${e.message}, retrying`);
          await new Promise(r => setTimeout(r, 800));
          continue;
        }
        logger.error(`[${ADDON_NAME}] range-proxy upstream connection failed: ${e.message}`);
        return res.status(502).send('Upstream connection failed');
      }
    }
    if (!upstreamStream || !upstreamResp) {
      return res.status(502).send('Upstream connection failed');
    }

    if (upstreamResp.statusCode >= 400) {
      logger.error(`[${ADDON_NAME}] range-proxy upstream ${upstreamResp.statusCode}`);
      upstreamStream.destroy();
      return res.status(upstreamResp.statusCode).send(`Upstream error: ${upstreamResp.statusCode}`);
    }

    // Adopt size/type from the GET when HEAD failed (or disagreed)
    const upstreamCL = parseInt(upstreamResp.headers['content-length'] || '0', 10);
    if (upstreamCL > 0 && (totalSize <= 0 || !hasRange)) totalSize = upstreamCL;
    if (totalSize > 0 && hasRange) {
      // Finalize bounds now that size is known (covers deferred suffix ranges
      // and the rangeEnd=MAX_SAFE_INTEGER default)
      const m = String(rangeHeader || '').match(/bytes=(\d*)-(\d*)/);
      if (m) {
        rangeStart = m[1] ? parseInt(m[1], 10) : (totalSize - parseInt(m[2] || '0', 10));
        if (!m[1] && m[2]) {
          rangeStart = Math.max(0, totalSize - parseInt(m[2], 10));
          rangeEnd = totalSize - 1;
        } else {
          rangeEnd = m[2] ? parseInt(m[2], 10) : totalSize - 1;
        }
        if (rangeStart >= totalSize) {
          upstreamStream.destroy();
          res.status(416);
          res.setHeader('Content-Range', `bytes */${totalSize}`);
          return res.end();
        }
        if (rangeEnd >= totalSize) rangeEnd = totalSize - 1;
      }
    }
    const contentLength = totalSize > 0 ? (rangeEnd - rangeStart + 1) : 0;

    // Case (a): upstream honored the Range → transparent partial-content pipe.
    if (hasRange && upstreamResp.statusCode === 206) {
      res.status(206);
      const ct2 = upstreamResp.headers['content-type'];
      if (ct2) contentType = ct2;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      for (const h of ['content-length', 'content-range']) {
        if (upstreamResp.headers[h]) res.setHeader(h, upstreamResp.headers[h]);
      }
      if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
      upstreamStream.pipe(res);
      upstreamStream.on('error', () => { try { res.end(); } catch {} });
      req.on('close', () => { try { upstreamStream.destroy(); } catch {} });
      return;
    }

    // Case (c): upstream ignored the Range (streaming from byte 0) and the
    // requested offset is beyond what we can cheaply discard → destroy the
    // connection WITHOUT any HTTP status. Task 62: the previous 416 response
    // KILLED playback — libavformat/mpv treats an HTTP error status on a seek
    // as clean EOF, so the Matroska demuxer saw an empty file after the header
    // (duration shown, zero frames ever decoded = "can't play, seek, anything"
    // for every google-card: MoviesDrive/CineFreak/AcerMovies/UHDMovies/Pantyflix).
    // A hard connection RESET, by contrast, makes http_seek() fail at the
    // network layer → ffmpeg restores its saved streaming connection and
    // continues LINEAR playback (verified with a libavformat matrix: 416/403/502
    // all die; connection-reset recovers; the historic google-direct 200-full
    // case plays exactly this way). Shallow seeks (≤ budget) still get real
    // byte-skipped 206s above.
    if (hasRange && totalSize > 0 && rangeStart > RANGE_SKIP_BUDGET) {
      logger.log(`[${ADDON_NAME}] range-proxy: upstream ignores Range, skip ${rangeStart} > budget — connection reset (player falls back to linear playback)`);
      try { upstreamStream.destroy(); } catch {}
      // destroy the socket WITHOUT writing any HTTP status: an error STATUS
      // (416/403/502) is consumed as clean EOF by libavformat and kills the
      // demuxer; a network-level reset is recovered from gracefully.
      res.destroy();
      return;
    }

    // Unknown size + ranged request: honest 200 passthrough of the in-flight
    // upstream stream (old direct-path semantics — never fake a 206).
    if (hasRange && totalSize <= 0) {
      logger.log(`[${ADDON_NAME}] range-proxy: no size known, honest 200 passthrough`);
      res.status(200);
      const ct2 = upstreamResp.headers['content-type'];
      if (ct2) contentType = ct2;
      res.setHeader('Content-Type', contentType);
      if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
      upstreamStream.pipe(res);
      upstreamStream.on('error', () => { try { res.end(); } catch {} });
      req.on('close', () => { try { upstreamStream.destroy(); } catch {} });
      return;
    }

    // Use the upstream Content-Type if our HEAD didn't get it
    if (upstreamResp.headers['content-type']) {
      contentType = upstreamResp.headers['content-type'];
    }

    // Step 4: Set response headers
    if (hasRange) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${totalSize}`);
    } else {
      res.status(200);
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    if (contentLength > 0) res.setHeader('Content-Length', contentLength);
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);

    // Step 5 (Task 62 rework): Byte-range translation with ONE mid-stream
    // resume. google blips mid-stream used to end the response after N bytes
    // (player stalls at N). A Range-ignoring upstream always re-sends from
    // byte 0, so a resume re-GETs and discards everything already delivered
    // (rangeStart + bytesPiped) — only attempted while that skip stays inside
    // the same 24MB budget as a fresh shallow seek, at most once.
    let bytesSkipped = 0;
    let bytesPiped = 0;
    let aborted = false;
    let skipTarget = rangeStart;      // absolute offset the current upstream must reach
    let resumedOnce = false;
    let activeUpstream = upstreamStream;

    const { Transform } = await import('stream');
    const rangeTransform = new Transform({
      transform(chunk, encoding, callback) {
        if (aborted) return callback();

        let offset = 0;
        let chunkLen = chunk.length;

        // Skip bytes before skipTarget
        if (bytesSkipped < skipTarget) {
          const need = skipTarget - bytesSkipped;
          if (chunkLen <= need) {
            // Entire chunk is before skipTarget — skip it all
            bytesSkipped += chunkLen;
            return callback();
          }
          // Skip the first 'need' bytes, process the rest
          offset = need;
          chunkLen -= need;
          bytesSkipped += need;
        }

        // Limit to contentLength
        const remaining = contentLength - bytesPiped;
        if (chunkLen > remaining) {
          chunkLen = remaining;
        }

        if (chunkLen <= 0) {
          return callback();
        }

        bytesPiped += chunkLen;
        this.push(chunk.slice(offset, offset + chunkLen));

        // If we've piped all requested bytes, end the stream
        if (bytesPiped >= contentLength && contentLength > 0) {
          aborted = true;
          this.push(null);
          try { activeUpstream.destroy(); } catch {}
        }

        callback();
      },
      flush(callback) {
        if (!aborted && bytesPiped < contentLength) {
          // Upstream ended before we got all requested bytes — that's OK,
          // just end the response.
        }
        callback();
      },
    });

    const destroyActive = () => { try { activeUpstream.destroy(); } catch {} };

    // Handle client disconnect
    req.on('close', () => {
      aborted = true;
      destroyActive();
      try { rangeTransform.destroy(); } catch {}
    });

    rangeTransform.on('error', (err) => {
      logger.error(`[${ADDON_NAME}] range-proxy transform error: ${err.message}`);
      try { res.end(); } catch {}
    });

    // Mid-stream error → ONE bounded resume, else end the response.
    const onUpstreamError = (err) => {
      logger.error(`[${ADDON_NAME}] range-proxy upstream stream error: ${err.message}`);
      if (aborted) { try { res.end(); } catch {} return; }
      if (!resumedOnce && bytesPiped < contentLength && (rangeStart + bytesPiped) <= RANGE_SKIP_BUDGET) {
        resumedOnce = true;
        skipTarget = rangeStart + bytesPiped;
        bytesSkipped = 0;
        logger.log(`[${ADDON_NAME}] range-proxy: mid-stream resume from byte ${skipTarget}`);
        (async () => {
          try {
            const retryStream = gotScraping.stream(targetUrl.href, {
              headers: upstreamReqHeaders,
              timeout: { request: 60000 },
              throwHttpErrors: false,
              followRedirect: true,
              isStream: true,
              http2: false,
            });
            const resp = await new Promise((resolve, reject) => {
              retryStream.on('response', (r) => resolve(r));
              retryStream.on('error', (e2) => reject(e2));
              setTimeout(() => reject(new Error('resume header timeout')), 15000);
            });
            if (resp.statusCode >= 400) {
              try { retryStream.destroy(); } catch {}
              aborted = true;
              try { res.end(); } catch {}
              return;
            }
            activeUpstream = retryStream;
            retryStream.pipe(rangeTransform);
            retryStream.on('error', (e2) => {
              logger.error(`[${ADDON_NAME}] range-proxy resume stream error: ${e2.message}`);
              aborted = true;
              try { res.end(); } catch {}
            });
            return;
          } catch (e2) {
            logger.error(`[${ADDON_NAME}] range-proxy resume failed: ${e2.message}`);
          }
          aborted = true;
          try { res.end(); } catch {}
        })();
        return;
      }
      aborted = true;
      try { res.end(); } catch {}
    };
    upstreamStream.on('error', onUpstreamError);

    // Pipe: upstream → rangeTransform → response
    upstreamStream.pipe(rangeTransform).pipe(res);
  } catch (err) {
    logger.error(`[${ADDON_NAME}] range-proxy error: ${err.message}`);
    if (!res.headersSent) res.status(502).send('Range proxy error');
    else try { res.end(); } catch {}
  }
});

// ============================================================================
// /reanime-proxy — XOR-decryption proxy for ReAnime/FlixCloud streams
// ============================================================================
// ReAnime (reanime.to) returns HLS streams from FlixCloud CDN that are
// XOR-encrypted:
//   - m3u8 playlists: base64-encoded + XOR with 32-byte key
//   - Segments: WebP/PNG fake headers + XOR with 16-byte key
//
// This proxy:
//   1. Fetches the m3u8 from flixcloud.cc (via curl for CF bypass)
//   2. Decrypts XOR-encrypted m3u8 content
//   3. Rewrites segment URLs to route through this proxy
//   4. Decrypts segment payloads (strips fake headers + XOR)
//
// URL formats:
//   /reanime-proxy/playlist.m3u8?url=<encoded>&key=<base64-32-byte-key>
//   /reanime-proxy/seg.ts?url=<encoded>
//   /reanime-proxy/raw?url=<encoded>&key=<base64>
// ============================================================================
app.get('/reanime-proxy/*', async (req, res) => {
  const rawUrl = req.query.url;
  const keyB64 = req.query.key;

  if (!rawUrl) {
    return res.status(400).send('Missing url parameter');
  }

  let targetUrl;
  try { targetUrl = new URL(rawUrl); }
  catch { return res.status(400).send('Invalid url parameter'); }

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const isHead = req.method === 'HEAD';
  logger.log(`[${ADDON_NAME}] reanime-proxy ${targetUrl.hostname}${targetUrl.pathname.slice(0, 50)}`);

  try {
    // Fetch upstream via curl (CF bypass for flixcloud.cc)
    const { execFileSync } = await import('child_process');
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const curlArgs = [
      '-sL', '--max-time', '15',
      '-H', `User-Agent: ${UA}`,
      '-H', 'Referer: https://flixcloud.cc/',
      '-H', 'Origin: https://flixcloud.cc',
      '-H', 'Accept: */*',
      rawUrl,
    ];

    let body;
    try {
      body = execFileSync('curl', curlArgs, { maxBuffer: 50 * 1024 * 1024, timeout: 20000, encoding: 'buffer' });
    } catch (e) {
      return res.status(502).send(`Upstream fetch failed: ${e.message.slice(0, 80)}`);
    }

    if (!body || body.length === 0) {
      return res.status(502).send('Empty upstream response');
    }

    // 16-byte XOR key for segment decryption — central registry (shared with
    // nuvio/reanime.cjs; previously byte-identical duplicates in both files).
    const SEGMENT_XOR_KEY = reanimeSegmentKey();

    // 32-byte XOR key for m3u8 playlist decryption
    let xorKey = null;
    if (keyB64) {
      try {
        xorKey = Buffer.from(keyB64, 'base64');
        if (xorKey.length !== 32) xorKey = null;
      } catch { xorKey = null; }
    }

    const bodyStr = body.toString('utf8');
    let plaintext;
    let contentType;
    let isSegment = false;
    let isM3u8 = false;

    // Detect content type by inspecting body bytes
    if (body.length >= 12 && body[0] === 0x52 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x46
        && body[8] === 0x57 && body[9] === 0x45 && body[10] === 0x42 && body[11] === 0x50) {
      // WebP disguised segment — strip 12-byte header, XOR with 16-byte key
      const payload = body.slice(12);
      plaintext = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) plaintext[i] = payload[i] ^ SEGMENT_XOR_KEY[i % 16];
      isSegment = true;
      contentType = 'video/mp2t';
    } else if (body.length >= 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4E && body[3] === 0x47
               && body[4] === 0x0D && body[5] === 0x0A && body[6] === 0x1A && body[7] === 0x0A) {
      // PNG disguised segment — strip 8-byte header, XOR with 16-byte key
      const payload = body.slice(8);
      plaintext = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) plaintext[i] = payload[i] ^ SEGMENT_XOR_KEY[i % 16];
      isSegment = true;
      contentType = 'video/mp2t';
    } else if (bodyStr.startsWith('#EXTM3U')) {
      // Plain m3u8 (already decoded)
      plaintext = body;
      isM3u8 = true;
      contentType = 'application/vnd.apple.mpegurl';
    } else if (xorKey) {
      // Encrypted m3u8 playlist (base64 + XOR with 32-byte key)
      try {
        const decoded = Buffer.from(bodyStr, 'base64');
        plaintext = Buffer.alloc(decoded.length);
        for (let i = 0; i < decoded.length; i++) plaintext[i] = decoded[i] ^ xorKey[i % xorKey.length];
        if (plaintext.toString('utf8').startsWith('#EXTM3U')) {
          isM3u8 = true;
          contentType = 'application/vnd.apple.mpegurl';
        } else {
          plaintext = body;
          contentType = 'application/octet-stream';
        }
      } catch {
        plaintext = body;
        contentType = 'application/octet-stream';
      }
    } else {
      plaintext = body;
      contentType = 'application/octet-stream';
    }

    // HEAD request — return headers only
    if (isHead) {
      res.status(200);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', plaintext.length);
      res.setHeader('Cache-Control', isSegment ? 'public, max-age=86400' : 'no-store');
      return res.end();
    }

    // Segments — stream decrypted MPEG-TS directly
    if (isSegment) {
      res.status(200);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', plaintext.length);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Accept-Ranges', 'bytes');
      return res.end(plaintext);
    }

    // m3u8 playlists — rewrite URLs to route through this proxy
    let rewritten = plaintext.toString('utf8');
    if (isM3u8) {
      const baseUrl = targetUrl;
      const basePath = baseUrl.pathname.replace(/\/[^/]*$/, '/');
      const baseOrigin = `${baseUrl.protocol}//${baseUrl.host}`;
      // Task 41: req.protocol is 'http' on Render (TLS terminates at the edge
      // proxy and app.set('trust proxy') is intentionally not enabled), which
      // produced http:// children that Render 301-redirects to https — an
      // extra round trip per segment and a cross-protocol redirect hop that
      // some HLS readers fail to follow ("stuck on loading"). Honor
      // X-Forwarded-Proto when present; falls back to req.protocol locally.
      const reanimeProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || req.protocol;
      const proxyBase = `${reanimeProto}://${req.get('host')}/reanime-proxy`;

      const toAbsolute = (line) => {
        if (line.startsWith('http://') || line.startsWith('https://')) return line;
        if (line.startsWith('//')) return baseUrl.protocol + line;
        if (line.startsWith('/')) return baseOrigin + line;
        if (line.startsWith('../')) {
          let p = basePath;
          let rest = line;
          while (rest.startsWith('../')) { p = p.replace(/[^/]*\/$/, ''); rest = rest.substring(3); }
          return baseOrigin + p + rest;
        }
        return baseOrigin + basePath + line;
      };

      const toProxy = (absUrl) => {
        if (absUrl.includes('flixcloud.cc') || absUrl.includes('atomic4cdn.top')) {
          if (absUrl.endsWith('.webp') || absUrl.endsWith('.png')) {
            return `${proxyBase}/seg.ts?url=${encodeURIComponent(absUrl)}&e=.ts`;
          }
          if (absUrl.endsWith('.m3u8')) {
            return `${proxyBase}/playlist.m3u8?url=${encodeURIComponent(absUrl)}&key=${encodeURIComponent(keyB64 || '')}`;
          }
          return `${proxyBase}/raw?url=${encodeURIComponent(absUrl)}&key=${encodeURIComponent(keyB64 || '')}`;
        }
        return absUrl;
      };

      // Rewrite URI="..." attributes
      rewritten = rewritten.replace(/(URI=")([^"]+)(")/g, (m, prefix, url, suffix) =>
        prefix + toProxy(toAbsolute(url)) + suffix);

      // Rewrite standalone URL lines
      rewritten = rewritten.replace(/(^[^#\n].*$)/gm, (line) => {
        if (!line.trim() || line.startsWith('#')) return line;
        return toProxy(toAbsolute(line.trim()));
      });

      // Remove AES-128 KEY directives (segments are XOR-encrypted, not AES)
      rewritten = rewritten.replace(/^#EXT-X-KEY:METHOD=AES-128.*$/gm, '');
    }

    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    res.end(rewritten);
  } catch (err) {
    logger.error(`[${ADDON_NAME}] reanime-proxy error: ${err.message}`);
    if (!res.headersSent) res.status(502).send('ReAnime proxy error');
    else try { res.end(); } catch {}
  }
});

// Rewrite relative URLs in an m3u8 playlist to absolute /proxy URLs.
// This ensures the player fetches variant playlists and segments through
// the proxy with the correct Referer — without it, relative URLs resolve
// against the proxy URL itself and return 404.
function rewriteM3u8Urls(m3u8Text, baseUrl, referer, req, extraParams) {
  const lines = m3u8Text.split('\n');
  // Task 41: emit https:// children on TLS-terminating hosts (Render).
  // req.protocol is 'http' behind Render's edge proxy, so every rewritten
  // variant/segment URL was http:// and Render 301-redirected each one to
  // https — doubling round trips per segment and breaking HLS readers that
  // don't follow cross-protocol redirects inside a playlist tree (manifests
  // as "stuck on loading"). X-Forwarded-Proto is always set by Render;
  // absent locally → req.protocol fallback keeps dev behavior byte-identical.
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proxyProto = forwardedProto || req.protocol;
  const proxyBase = `${proxyProto}://${req.get('host')}/proxy`;

  // Optional decrypt-mode params (xor/strip/ct) propagated onto every
  // rewritten /proxy URL so variant playlists and segments decrypt too
  // (used by the opt-in ?xor= branch below; undefined for the normal path —
  // existing callers pass 4 args and are unaffected).
  const withExtra = (proxyUrl) => {
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) {
        if (v !== undefined && v !== null && v !== '') proxyUrl.searchParams.set(k, String(v));
      }
    }
    return proxyUrl;
  };

  return lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      // Rewrite URI= inside #EXT-X-STREAM-INF, #EXT-X-I-FRAME-STREAM-INF,
      // #EXT-X-MAP, and #EXT-X-MEDIA tags (all use URI="..." for variant/
      // segment/audio/subtitle references)
      if (trimmed.startsWith('#EXT-X-STREAM-INF') ||
          trimmed.startsWith('#EXT-X-I-FRAME-STREAM-INF') ||
          trimmed.startsWith('#EXT-X-MAP') ||
          trimmed.startsWith('#EXT-X-MEDIA')) {
        return line.replace(/URI="([^"]+)"/g, (match, uri) => {
          const absoluteUrl = new URL(uri, baseUrl).href;
          const proxyUrl = new URL(proxyBase);
          proxyUrl.searchParams.set('url', absoluteUrl);
          if (referer) proxyUrl.searchParams.set('referer', referer);
          return `URI="${withExtra(proxyUrl).href}"`;
        });
      }
      return line;
    }
    // This line is a URL (variant playlist or segment)
    const absoluteUrl = new URL(trimmed, baseUrl).href;
    const proxyUrl = new URL(proxyBase);
    proxyUrl.searchParams.set('url', absoluteUrl);
    if (referer) proxyUrl.searchParams.set('referer', referer);
    return withExtra(proxyUrl).href;
  }).join('\n');
}

// ============== HEALTH ==============
// Task 74: additive telemetry for the keep-alive investigation — every
// original field is preserved. memoryMB/watch boot recycles + OOM pressure;
// instanceId exposes multi-instance deployments (an UptimeRobot ping keeps
// only ONE instance warm — a sleeping second instance is a cold boot for the
// next user); keepalive.rootHits proves whether the monitor actually reaches
// THIS deployment; cacheKeeper shows the idle-warm passes live.
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    name: ADDON_NAME,
    version: VERSION,
    uptime: process.uptime(),
    bootAt: new Date(globalThis.__phoenixBootAt).toISOString(),
    instanceId: INSTANCE_ID,
    memoryMB: {
      rss: +(mem.rss / 1048576).toFixed(1),
      heapUsed: +(mem.heapUsed / 1048576).toFixed(1),
      heapTotal: +(mem.heapTotal / 1048576).toFixed(1),
    },
    keepalive: { rootHits, lastRootHitAt },
    cacheKeeper: getCacheKeeperInfo(),
    egressWatch: getEgressWatchSummary(),
    sources: sources.map(s => s.id),
    extractors: extractors.map(e => e.id),
  });
});

// ============== DEBUG (diagnostic — safe, read-only) ==============
// Returns which proxy env vars are SET (boolean only — never exposes values).
app.get('/debug/env', (req, res) => {
  res.json({
    version: 'task61-persianstremio-wave2-budget-echo',
    startedAt: new Date(globalThis.__phoenixBootAt || Date.now()).toISOString(),
    ALL_PROXY: !!process.env.ALL_PROXY,
    HTTPS_PROXY: !!process.env.HTTPS_PROXY,
    HTTP_PROXY: !!process.env.HTTP_PROXY,
    TMDB_API_KEY: !!process.env.TMDB_API_KEY,
    FLARESOLVERR_ENDPOINT: !!process.env.FLARESOLVERR_ENDPOINT,
    NODE_ENV: process.env.NODE_ENV || 'development',
  });
});

// Task 49: universal-subtitle diagnostic — runs the SHARED subtitle module
// exactly as the resolver does and returns what it produces for a title.
// Isolates scraper failure (granite/natsuki unreachable from this instance)
// from integration failure (resolver not attaching). Additive; diagnostic only.
// Usage: /debug/subs?type=series&id=tmdb:1396:1:1
app.get('/debug/subs', async (req, res) => {
  try {
    const rawId = req.query.id || 'tmdb:1396';
    const type = req.query.type || 'series';
    // Task 63: accept tt ids the same way the real /stream path does — the old
    // digit-extract mangled tt0944947:1:1 into tmdb 944947 (diagnostics lied
    // about "no subs" for tt probes). Convert via the same module the resolver
    // uses so tt and tmdb probes return identical sets.
    let tmdbId = 1396, season, episode;
    if (/^tt\d+/i.test(rawId)) {
      const parts = rawId.split(':');
      try {
        const { getTmdbIdFromImdbId } = await import('./utils/tmdb.js');
        const converted = await getTmdbIdFromImdbId(fetcher, { hostUrl: new URL(`https://${req.headers.host}`) }, { id: parts[0] });
        if (converted?.id) tmdbId = converted.id;
      } catch { /* keep default */ }
      season = parts[1] ? Number(parts[1]) : undefined;
      episode = parts[2] ? Number(parts[2]) : undefined;
    } else {
      const m = rawId.match(/(\d+)(?::(\d+))?(?::(\d+))?/);
      tmdbId = m ? Number(m[1]) : 1396;
      season = m && m[2] ? Number(m[2]) : undefined;
      episode = m && m[3] ? Number(m[3]) : undefined;
    }
    const t0 = Date.now();
    const subs = await Promise.race([
      fetchUnifiedSubs({ tmdbId, type, season, episode, hostUrl: new URL(`https://${req.headers.host}`), fetcher, ctx: { hostUrl: new URL(`https://${req.headers.host}`) } }),
      new Promise(r => setTimeout(() => r(null), 20000)),
    ]);
    const dt = Date.now() - t0;
    res.json({
      tmdbId, type, season, episode,
      durationMs: dt,
      timedOut: subs === null,
      count: Array.isArray(subs) ? subs.length : 0,
      byProvider: {
        granite: Array.isArray(subs) ? subs.filter(s => String(s.id).startsWith('gr-')).length : 0,
        natsuki: Array.isArray(subs) ? subs.filter(s => String(s.id).startsWith('nk-')).length : 0,
      },
      sample: Array.isArray(subs) ? subs.slice(0, 6).map(s => ({ lang: s.lang, url: String(s.url).slice(0, 90) })) : [],
    });
  } catch (e) {
    res.json({ error: e?.message || String(e) });
  }
});

// Runs a full /stream resolution and returns per-source timing data.
// This is the SAME code path as /stream/:type/:id.json, so it captures
// real-world behavior including concurrency, timeouts, and caching.
// Usage: /debug/stream?type=movie&id=tmdb:155
app.get('/debug/stream', async (req, res) => {
  const type = req.query.type || 'movie';
  const rawId = req.query.id || 'tmdb:155';

  let parsedId;
  try {
    if (rawId.startsWith('tmdb:')) {
      parsedId = TmdbId.fromString(rawId.replace('tmdb:', ''));
    } else if (rawId.startsWith('tt')) {
      parsedId = ImdbId.fromString(rawId);
    } else {
      return res.status(400).json({ error: `Unsupported ID: ${rawId}` });
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const ctx = {
    hostUrl: new URL(`https://${req.headers.host}`),
    id: req.headers['x-request-id'] || '',
    ip: req.ip,
    config: { multi: 'on', en: 'on' },
  };

  const t0 = Date.now();
  try {
    let streams;
    ({ streams } = await streamResolver.resolve(ctx, sources, type, parsedId));
    const totalMs = Date.now() - t0;

    // Get per-source timing data (stashed by _resolveInternal)
    const timings = streamResolver._lastSourceTimings || [];

    // Sort by duration descending (slowest first)
    const sortedTimings = [...timings].sort((a, b) => b.durationMs - a.durationMs);

    return res.json({
      type,
      id: rawId,
      totalMs,
      totalStreams: streams.length,
      sourceCount: sources.length,
      // Client-budget telemetry — partial=true means the response was cut at
      // STREAM_CLIENT_BUDGET_MS with sources still resolving in background
      // (their results cache for the next request).
      // Task 61: report the RESOLVER's actual budget (stashed at resolve
      // time), not a stale local fallback — the old `|| 13000` echo lied
      // whenever the env var was unset (real budget 40s since Task 56).
      partial: streamResolver._lastResolveWasPartial === true,
      clientBudgetMs: streamResolver._clientBudgetMs || 40000,
      // Task 69 early-ship telemetry — fired=true means the response shipped
      // before the budget because only ≤ maxRemaining stragglers were left.
      earlyShip: streamResolver._lastEarlyShip || null,
      // Per-source timing (slowest first)
      sources: sortedTimings.map(t => ({
        id: t.id,
        status: t.status,
        count: t.count,
        durationMs: t.durationMs,
        queueMs: t.queueMs,
      })),
      // Streams from Cinejoy + ZinkMovies specifically
      cinejoyStreams: streams
        .filter(s => /cinejoy/i.test(s.name || ''))
        .map(s => ({ name: s.name, title: (s.title || '').slice(0, 100) })),
      zinkStreams: streams
        .filter(s => /zink/i.test(s.name || ''))
        .map(s => ({ name: s.name, title: (s.title || '').slice(0, 100) })),
    });
  } catch (err) {
    return res.json({
      error: err.message,
      totalMs: Date.now() - t0,
    });
  }
});

// Tests a single source by id and returns its raw output + timing + errors.
// Usage: /debug/source/:sourceId?type=movie&id=tmdb:1081003
app.get('/debug/source/:sourceId', async (req, res) => {
  const { sourceId } = req.params;
  const type = req.query.type || 'movie';
  const rawId = req.query.id || 'tmdb:1081003';

  const source = sources.find(s => s.id === sourceId);
  if (!source) {
    return res.status(404).json({ error: `Source '${sourceId}' not found. Available: ${sources.map(s => s.id).join(', ')}` });
  }

  let parsedId;
  try {
    if (rawId.startsWith('tmdb:')) {
      parsedId = TmdbId.fromString(rawId.replace('tmdb:', ''));
    } else if (rawId.startsWith('tt')) {
      parsedId = ImdbId.fromString(rawId);
    } else {
      return res.status(400).json({ error: `Unsupported ID: ${rawId}` });
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const ctx = {
    hostUrl: new URL(`https://${req.headers.host}`),
    id: req.headers['x-request-id'] || '',
    ip: req.ip,
    config: { multi: 'on', en: 'on' },
  };

  // Task 38: capture the scraper's console output so zero-stream sources can
  // be diagnosed from production telemetry without Render log access.
  const capturedLogs = [];
  const origLog = console.log, origError = console.error, origWarn = console.warn;
  console.log = (...a) => { const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); if (capturedLogs.length < 60) capturedLogs.push(s.slice(0, 220)); origLog(...a); };
  console.error = (...a) => { const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); if (capturedLogs.length < 60) capturedLogs.push('[err] ' + s.slice(0, 220)); origError(...a); };
  console.warn = (...a) => { const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); if (capturedLogs.length < 60) capturedLogs.push('[warn] ' + s.slice(0, 220)); origWarn(...a); };
  const restoreConsole = () => { console.log = origLog; console.error = origError; console.warn = origWarn; };

  const t0 = Date.now();
  try {
    // Call handleInternal directly to bypass the cache
    const results = await Promise.race([
      source.handleInternal(ctx, type, parsedId),
      new Promise(r => setTimeout(() => r({ __timeout: true }), 35000)),
    ]);
    const dt = Date.now() - t0;
    restoreConsole();
    if (results?.__timeout) {
      return res.json({ source: sourceId, type, id: rawId, timedOut: true, durationMs: dt, logs: capturedLogs });
    }
    // full=1 → untruncated stream URLs (up to 3). Diagnostic use only: the
    // default 150-char slice keeps responses small for humans, but it makes
    // magic-byte playability checks impossible for long direct URLs.
    const wantFull = req.query.full === '1';
    const sliceLen = wantFull ? 3 : 5;
    return res.json({
      source: sourceId,
      type,
      id: rawId,
      durationMs: dt,
      logs: capturedLogs,
      count: Array.isArray(results) ? results.length : 0,
      results: Array.isArray(results) ? results.slice(0, sliceLen).map(r => ({
        url: wantFull ? r.url?.href : r.url?.href?.slice(0, 150),
        format: r.format,
        // Task 57: expose requestHeaders + notWebReady so external playability
        // probes can replicate the player's fetch (behaviorHints.proxyHeaders
        // comes from urlResult.requestHeaders on direct cards). Diagnostic only.
        requestHeaders: r.requestHeaders || null,
        notWebReady: r.notWebReady,
        meta: { ...r.meta, title: r.meta?.title?.slice(0, 120) },
      })) : [],
    });
  } catch (e) {
    const dt = Date.now() - t0;
    restoreConsole();
    return res.json({
      source: sourceId,
      type,
      id: rawId,
      durationMs: dt,
      logs: capturedLogs,
      error: e?.message || String(e),
      stack: e?.stack?.split('\n').slice(0, 5),
    });
  }
});

// Task 90: live status data for the non-technical /status page. READ-ONLY:
// merges passive per-source outcomes (real request telemetry from
// StreamResolver) with the Task 89 egress-watch probes. Triggers nothing.
app.get('/status/data', (req, res) => {
  const telemetry = getSourceStatus();
  const watchSummary = getEgressWatchSummary();
  const rows = sources.map(s => {
    const t = telemetry[s.id];
    const w = watchVerdictFor(s.id, watchSummary);
    const kinds = [
      ...((s.contentTypes || []).includes('movie') ? ['Movies'] : []),
      ...((s.contentTypes || []).includes('series') ? ['Series'] : []),
    ];
    if (ANIME_ONLY_SOURCE_IDS.has(s.id)) kinds.push('Anime');
    const row = {
      id: s.id, label: s.label || s.id, kinds,
      cls: w ? w.cls : (t ? t.cls : 'idle'),
      count: t?.count || 0, ms: t?.ms || 0, agoMs: t?.agoMs || 0,
      lastType: t?.type || '', totals: t?.totals || { ok: 0, zero: 0, err: 0 },
      recentOk: t?.recentOk || 0, recentN: t?.recentN || 0,
      note: w ? w.note : '',
    };
    return row;
  });
  const summary = { working: 0, waiting: 0, issue: 0, idle: 0, total: rows.length };
  for (const r of rows) summary[r.cls === 'delivering' ? 'working' : r.cls === 'waiting' ? 'waiting' : r.cls === 'issue' ? 'issue' : 'idle']++;
  res.json({
    generatedAt: new Date().toISOString(),
    server: {
      ip: watchSummary.ip || null,
      ipSince: watchSummary.ipSince || null,
      ipChanges: watchSummary.ipChanges || 0,
      uptimeH: Math.round(process.uptime() / 360) / 10,
      watchEnabled: watchSummary.enabled !== false,
    },
    summary,
    sources: rows,
  });
});

// Task 90: non-technical live status page — dark glass style matching the
// landing page; polls /status/data every 30s. Renders what already happened;
// never triggers resolves or probes.
app.get('/status', (req, res) => {
  const hostUrl = `https://${req.headers.host}`;
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PhoeniX · Live Source Status</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { background: radial-gradient(ellipse at 50% -10%, #2a1a08 0%, #0a0a0f 55%); min-height: 100vh; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .g { background: #22c55e; box-shadow: 0 0 10px rgba(34,197,94,.7); }
  .a { background: #f59e0b; box-shadow: 0 0 10px rgba(245,158,11,.7); }
  .r { background: #ef4444; box-shadow: 0 0 10px rgba(239,68,68,.7); }
  .i { background: #475569; }
  .pulse { animation: p 2s ease-in-out infinite; }
  @keyframes p { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
</style>
</head>
<body class="text-gray-200">
<div class="max-w-md mx-auto px-4 py-8">
  <div class="flex items-center gap-3 mb-1">
    <img src="${hostUrl}/public/logo.png" alt="PhoeniX" class="w-10 h-10 drop-shadow-[0_0_15px_rgba(255,100,0,0.5)]">
    <h1 class="text-2xl font-black text-white tracking-tight">Live Source Status</h1>
  </div>
  <p class="text-xs text-gray-400 mb-4">What each source actually returned on recent real requests. Updates itself every 30&nbsp;seconds.</p>
  <div id="chips" class="flex flex-wrap gap-2 mb-3 text-xs font-semibold"></div>
  <div class="rounded-2xl border border-white/10 p-3 mb-4 text-xs text-gray-400" style="background:rgba(15,15,20,0.6);backdrop-filter:blur(20px)">
    <span id="serverline">Loading server info…</span>
  </div>
  <div id="content" class="space-y-5"></div>
  <p class="text-[11px] text-gray-500 mt-6 leading-relaxed">
    PhoeniX streams directly from each site — no torrents, ever.
    "Waiting" sources are blocked or empty <em>on their own websites</em>; the addon re-checks them automatically and they come back on their own.
    Sources nobody has opened lately show as "no recent requests" instead of a stale verdict.
  </p>
</div>
<script>
const GROUPS = [
  ['working', 'Working', 'g'],
  ['waiting', 'Waiting on their sites', 'a'],
  ['issue',   'Had an issue', 'r'],
  ['idle',    'No recent requests', 'i'],
];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function ago(ms) {
  if (!ms || ms < 90e3) return 'just now';
  const m = Math.round(ms / 60e3); if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 48) return h + ' h ago';
  return Math.round(h / 24) + ' d ago';
}
function dur(ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'; }
function card(r) {
  const recent = r.recentN > 0 && r.recentOk > 0 ? ' <span class="text-gray-600">· delivered ' + r.recentOk + ' of last ' + r.recentN + ' checks</span>' : '';
  let line;
  if (r.cls === 'delivering') line = '<span class="text-green-400 font-semibold">Working</span> — delivered <span class="text-white font-semibold">' + r.count + '</span> stream' + (r.count === 1 ? '' : 's') + ' · ' + ago(r.agoMs);
  else if (r.cls === 'waiting') line = '<span class="text-amber-400 font-semibold">Waiting</span> — ' + esc(r.note || 'the site had nothing to offer this time') + (r.agoMs ? ' · last try ' + ago(r.agoMs) : '');
  else if (r.cls === 'issue') line = '<span class="text-red-400 font-semibold">Timed out</span> · ' + ago(r.agoMs) + ' — usually recovers on the next open';
  else line = r.agoMs ? 'No requests in the last 3 h — last try ' + ago(r.agoMs) : 'No requests yet — lights up on first use';
  const kinds = r.kinds.map(k => '<span class="text-[10px] uppercase tracking-wide text-gray-500 border border-white/10 rounded px-1 py-px">' + k + '</span>').join(' ');
  const meta = r.cls === 'delivering' ? ' <span class="text-gray-600">· ' + dur(r.ms) + '</span>' : '';
  return '<div class="flex items-start gap-2.5 rounded-xl border border-white/10 px-3 py-2.5" style="background:rgba(15,15,20,0.55)">'
    + '<span class="dot mt-1.5 ' + (GROUPS.find(g => g[0] === r.cls)?.[2] || 'i') + (r.cls === 'waiting' ? ' pulse' : '') + '"></span>'
    + '<div class="min-w-0 flex-1"><div class="flex items-center gap-2 flex-wrap">' + esc(r.label) + ' ' + kinds + '</div>'
    + '<div class="text-xs text-gray-400 mt-0.5">' + line + meta + recent + '</div></div></div>';
}
function render(d) {
  const chips = [
    ['Working', d.summary.working, 'text-green-400 border-green-400/30'],
    ['Waiting', d.summary.waiting, 'text-amber-400 border-amber-400/30'],
    ['Issues', d.summary.issue, 'text-red-400 border-red-400/30'],
    ['Idle', d.summary.idle, 'text-gray-500 border-white/10'],
  ];
  document.getElementById('chips').innerHTML = chips.map(([l, n, c]) =>
    '<span class="rounded-full border px-2.5 py-1 ' + c + '">' + n + ' ' + l + '</span>').join('');
  const sl = d.server;
  let since = '';
  if (sl.ipSince) {
    const h = Math.floor((Date.now() - new Date(sl.ipSince).getTime()) / 36e5);
    since = ' · unchanged for ' + (h < 1 ? 'under an hour' : h + ' h');
  }
  document.getElementById('serverline').innerHTML =
    'Server network IP <span class="text-gray-200 font-mono">' + esc(sl.ip || 'checking…') + '</span>' + since +
    ' · watched every 30 min · addon uptime ' + sl.uptimeH + ' h';
  const by = {};
  for (const g of GROUPS) by[g[0]] = [];
  for (const r of d.sources) (by[r.cls] || by.idle).push(r);
  for (const g of GROUPS) by[g[0]].sort((a, b) => a.label.localeCompare(b.label));
  document.getElementById('content').innerHTML = GROUPS.filter(([k]) => by[k].length)
    .map(([k, title]) => '<div><h2 class="text-sm font-bold text-gray-300 mb-2">' + title + ' <span class="text-gray-500 font-normal">(' + by[k].length + ')</span></h2><div class="space-y-2">'
    + by[k].map(card).join('') + '</div></div>').join('');
}
async function tick() {
  try { render(await (await fetch('/status/data')).json()); } catch (e) { /* keep last frame */ }
}
tick();
setInterval(tick, 30000);
</script>
</body>
</html>`);
});

// Task 89: egress watch telemetry — rolling probe history for the upstream-gated
// sources (kmmovies / acermovies) + egress-IP rotation log. Read-only.
app.get('/debug/egresswatch', (req, res) => {
  res.json(getEgressWatchInfo());
});

// Raw native-fetch probe from THIS server — diagnoses egress-IP/TLS blocks.
// Task 38: stellarrip/stellar/uhdmovies/bollyflix resolve 0 in production while
// identical code + got-scraping /proxy probes succeed; this endpoint isolates
// the native undici fetch path each scraper actually uses.
// Usage: /debug/rawfetch?url=https://stellar.rip/en/watch/embed/movie/27205
//   Optional POST support (Task 81): &method=POST&body=<raw body>&ct=application/json
//   — diagnosing POST-class APIs (acer api2, animekai POST search) needs the
//   exact status/body from production egress; GET-only rawfetch reported
//   misleading "Cannot GET /api/search" signatures.
app.get('/debug/rawfetch', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return res.status(400).json({ error: 'query param url required (http/https)' });
  }
  const method = String(req.query.method || 'GET').toUpperCase();
  const body = req.query.body;
  const ct = req.query.ct;
  const extraHeaders = {};
  if (ct) extraHeaders['Content-Type'] = ct;
  if (req.query.origin) extraHeaders['Origin'] = req.query.origin;
  if (req.query.referer) extraHeaders['Referer'] = req.query.referer;
  const t0 = Date.now();
  try {
    const r = await fetch(rawUrl, {
      method: method === 'GET' ? 'GET' : method,
      ...(method !== 'GET' && body ? { body } : {}),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Accept': 'text/html,*/*', ...extraHeaders },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });
    const text = await r.text();
    return res.json({
      url: rawUrl,
      ok: r.ok,
      status: r.status,
      finalUrl: r.url,
      durationMs: Date.now() - t0,
      bytes: text.length,
      ct: r.headers.get('content-type') || undefined,
      head: text.slice(0, 300),
    });
  } catch (e) {
    return res.json({
      url: rawUrl,
      error: e?.message || String(e),
      cause: e?.cause?.message || e?.cause?.code || undefined,
      durationMs: Date.now() - t0,
    });
  }
});


// ============== LANDING PAGE ==============
app.get('/', (req, res) => {
  // Task 74: keepalive probe counter — makes UptimeRobot pings observable.
  rootHits++;
  lastRootHitAt = new Date().toISOString();
  const hostUrl = `https://${req.headers.host}`;
  const manifestUrl = `${hostUrl}/manifest.json`;
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PhoeniX</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    background: linear-gradient(135deg, #0a0a0f 0%, #1a0a1a 30%, #0f0a15 50%, #1a0a0f 70%, #0a0a0f 100%);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .phoenix-bg {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 80vmin;
    height: 80vmin;
    opacity: 0.06;
    background-image: url('${hostUrl}/public/logo.png');
    background-size: contain;
    background-position: center;
    background-repeat: no-repeat;
    filter: drop-shadow(0 0 60px rgba(255, 100, 0, 0.3));
    animation: glow 4s ease-in-out infinite alternate;
  }
  @keyframes glow {
    from { opacity: 0.04; filter: drop-shadow(0 0 40px rgba(255, 80, 0, 0.2)); }
    to { opacity: 0.08; filter: drop-shadow(0 0 80px rgba(255, 120, 0, 0.4)); }
  }
  .ember {
    position: fixed;
    bottom: -10px;
    width: 4px;
    height: 4px;
    background: rgba(255, 140, 0, 0.6);
    border-radius: 50%;
    animation: rise 3s linear infinite;
    pointer-events: none;
  }
  @keyframes rise {
    to { transform: translateY(-100vh) translateX(20px); opacity: 0; }
  }
</style>
</head>
<body>
<div class="phoenix-bg"></div>
<div id="embers"></div>
<div class="relative z-10 flex flex-col items-center px-6 w-full max-w-md">
  <img src="${hostUrl}/public/logo.png" alt="PhoeniX" class="w-20 h-20 mb-3 drop-shadow-[0_0_25px_rgba(255,100,0,0.5)]">
  <h1 class="text-5xl font-black text-white tracking-tight mb-1">PhoeniX</h1>
  <p class="text-sm text-orange-400/70 font-medium mb-8 tracking-wider uppercase">Stream movies, series & anime in HD</p>
  <div class="w-full rounded-3xl border border-white/10 p-6" style="background: rgba(15,15,20,0.6); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);">
    <a href="stremio://${hostUrl.replace('https://','')}/manifest.json" class="flex items-center justify-center w-full py-3.5 rounded-2xl text-white font-bold text-lg transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]" style="background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); box-shadow: 0 8px 30px rgba(124,58,237,0.4);">
      <svg class="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20"><path d="M10 0C4.477 0 0 4.477 0 10c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.014-1.699-2.782.602-3.369-1.34-3.369-1.34-.455-1.155-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.071 1.531 1.03 1.531 1.03.892 1.529 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.57 9.57 0 0110 4.836a9.59 9.59 0 012.504.336c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.579.688.481A10.001 10.001 0 0020 10c0-5.523-4.477-10-10-10z"/></svg>
      Install in Stremio
    </a>
    <button onclick="navigator.clipboard.writeText('${manifestUrl}').then(()=>{this.innerText='Copied!';setTimeout(()=>this.innerText='Copy Manifest URL',2000)})" class="mt-3 flex items-center justify-center w-full py-3 rounded-2xl text-gray-300 font-medium text-sm transition-all duration-300 hover:text-white hover:bg-white/5 border border-white/10">
      <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg>
      Copy Manifest URL
    </button>
    <a href="/status" class="mt-3 flex items-center justify-center w-full py-2.5 rounded-2xl text-gray-400 font-medium text-xs transition-all duration-300 hover:text-orange-300 hover:bg-white/5">
      <span class="dot g mr-2 pulse"></span> Live source status
    </a>
  </div>
</div>
<script>
  // Ember particles
  const embers = document.getElementById('embers');
  for(let i=0;i<15;i++){
    const e=document.createElement('div');
    e.className='ember';
    e.style.left=Math.random()*100+'vw';
    e.style.animationDuration=(2+Math.random()*3)+'s';
    e.style.animationDelay=Math.random()*3+'s';
    e.style.width=e.style.height=(2+Math.random()*4)+'px';
    embers.appendChild(e);
  }
</script>
</body>
</html>`);
});

// ============== START ==============
app.listen(PORT, HOST, () => {
  logger.log(`[${ADDON_NAME}] listening on http://${HOST}:${PORT}`);
  logger.log(`[${ADDON_NAME}] manifest: http://${HOST}:${PORT}/manifest.json`);
  logger.log(`[${ADDON_NAME}] Sources: ${sources.length} (${sources.map(s => s.id).join(', ')})`);
  logger.log(`[${ADDON_NAME}] Extractors: ${extractors.length} (${extractors.map(e => e.id).join(', ')})`);
  // Task 54: boot-time warmup REMOVED (user request, standing): the original
  // PhoeniX repo has no pre-warm. On the 0.1-CPU free tier the 50+ origin TLS
  // handshakes raced exactly the requests that follow a scale-from-zero boot
  // (first /stream + playback) and contributed to the degraded-instance class.
  // The Task 45 idle-time prewarm loop was already removed earlier.
  //
  // Task 74: the idle CACHE KEEPER is a different contract, not a prewarm
  // revival: nothing runs at boot, nothing runs before a USER request
  // existed, and passes fire only ≥3 min after the last user /stream activity
  // (yielding instantly when the user returns). It warms ONLY titles the user
  // actually opened, through the resolver's own scheduling — so the
  // always-awake instance the user pays UptimeRobot for stays warm where it
  // matters (the caches their next open will hit). CACHE_KEEPER=off reverts
  // to the exact pre-Task-74 behavior.
  startCacheKeeper({
    sources,
    parseId: (type, rawId) => rawId.startsWith('tmdb:')
      ? TmdbId.fromString(rawId.replace('tmdb:', ''))
      : ImdbId.fromString(rawId),
    logger,
    hostUrl: process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`,
  });

  // Task 89: egress watch — same contract inputs as the cache keeper; first
  // tick is deliberately 90s after boot (no boot-window racing). Pure
  // telemetry + upstream-cache pre-fill on acer recovery; see the module's
  // safety rules. EGRESS_WATCH=off reverts to pre-Task-89 behavior.
  startEgressWatch({
    sources,
    parseId: (type, rawId) => rawId.startsWith('tmdb:')
      ? TmdbId.fromString(rawId.replace('tmdb:', ''))
      : ImdbId.fromString(rawId),
    logger,
  });
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
