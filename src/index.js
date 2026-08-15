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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 7000;
const HOST = process.env.HOST || '0.0.0.0';
const ADDON_NAME = process.env.ADDON_NAME || 'PhoeniX';
const VERSION = '1.3.0';

const logger = console;

const fetcher = new Fetcher(logger);
const sources = createSources(fetcher);
const extractors = createExtractors(fetcher, logger);
const extractorRegistry = new ExtractorRegistry(logger, extractors);
const streamResolver = new StreamResolver(logger, extractorRegistry);

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

  logger.log(`[${ADDON_NAME}] stream ${type} ${id}`);

  try {
    const startTime = Date.now();
    const { streams } = await streamResolver.resolve(ctx, sources, type, parsedId);
    const duration = Date.now() - startTime;
    logger.log(`[${ADDON_NAME}] ${type} ${id} → ${streams.length} streams in ${duration}ms`);

    res.setHeader('Cache-Control', 'public, max-age=300');
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
  const rawUrl = req.query.url;
  const rawReferer = req.query.referer;
  // forceHls=1: when set, the proxy buffers the response and checks if it's
  // HLS (regardless of URL pattern). Used by Nuvio source adapters for URLs
  // that return HLS content but don't have .m3u8 in the path (e.g. vidlove
  // returns application/vnd.apple.mpegurl from /api?d=... endpoint).
  let forceHls = req.query.forceHls === '1';

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
    const proxyHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };
    if (rawReferer) proxyHeaders['Referer'] = rawReferer;
    // Pass through Range header for seeking. Some CDNs (workers.dev) require
    // a Range header to return 206 — if Stremio doesn't send one, add a
    // default Range to get the first byte (which triggers 206 + seekability).
    if (req.headers.range) {
      proxyHeaders['Range'] = req.headers.range;
    } else {
      proxyHeaders['Range'] = 'bytes=0-';
    }

    // Use got-scraping for Cloudflare bypass — plain fetch() gets 403
    // from workers.dev and other CF-protected CDN hosts.
    const { gotScraping } = await import('got-scraping');
    const { HeaderGenerator } = await import('header-generator');

    // For Cloudflare-protected CDNs (Netlio: aurorionacademy.site,
    // professionalidentity.cyou, etc.), use HeaderGenerator to generate
    // browser-like headers that pass CF's JS challenge.
    const isNetlioCdn = /aurorionacademy|professionalidentity|netrocdn|savannahridgedesignlab|creativewritingtips|harborlanecreativeworks|pinecliffdesigncollective/.test(targetUrl.hostname);
    if (isNetlioCdn) {
      const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });
      const browserHeaders = hg.getHeaders({ httpVersion: '2' });
      // Merge browser headers with our proxy headers (Referer, Range)
      Object.assign(proxyHeaders, browserHeaders);
      if (rawReferer) proxyHeaders['Referer'] = rawReferer;
      if (req.headers.range) proxyHeaders['Range'] = req.headers.range;
      else proxyHeaders['Range'] = 'bytes=0-';
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
    // AniDB disguises HLS playlists with .txt extensions (master.txt).
    // .xls files are segments (not playlists) — don't buffer them.
    const urlIsTxt = pathLower.endsWith('.txt');
    // AniDB .xls segments — stream directly, just override Content-Type
    const urlIsAniDBSeg = pathLower.endsWith('.xls') && hostLower.includes('anidb');
    const urlIsAniPriv8 = pathLower.includes('/api/secure/pipeline/');
    // Berkas: *.berkas*.workers.dev — master m3u8 and variant playlists
    const urlIsBerkas = hostLower.includes('berkas') && hostLower.endsWith('.workers.dev');

    if (forceHls || urlIsM3u8 || urlIsTxt || urlIsStream || urlIsAniPriv8 || urlIsBerkas) {
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

      if (forceHls || urlIsM3u8 || urlIsTxt || urlIsStream || urlIsAniPriv8 || urlIsBerkas) {
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

        if (m3u8Res.statusCode >= 400) {
          logger.error(`[${ADDON_NAME}] proxy upstream ${m3u8Res.statusCode} for ${targetUrl.hostname}`);
          return res.status(m3u8Res.statusCode).send(`Upstream error: ${m3u8Res.statusCode}`);
        }

        const body = m3u8Res.body;
        const isHls = body.trimStart().startsWith('#EXTM3U');

        if (isHls) {
          // It's an HLS playlist — rewrite relative URLs to absolute /proxy URLs
          const rewritten = rewriteM3u8Urls(body, targetUrl, rawReferer, req);
          res.status(200);
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.setHeader('Content-Length', Buffer.byteLength(rewritten));
          res.send(rewritten);
          return;
        }

        // .txt file but not HLS — serve as-is (could be subtitles or other text)
        // But override Content-Type to video/mp2t for segment-like .txt files
        // to prevent Stremio from refusing to play them as video.
        if (urlIsTxt) {
          res.status(200);
          const ct = m3u8Res.headers['content-type'] || 'text/plain';
          // If the .txt URL path looks like a segment (contains /content/ or
          // page- or .html), override to video/mp2t (PlayIMDb-style segments)
          const segPath = targetUrl.pathname.toLowerCase();
          if (ct.includes('text/html') && (segPath.includes('/content/') || segPath.endsWith('.html') || segPath.includes('page-'))) {
            res.setHeader('Content-Type', 'video/mp2t');
          } else {
            res.setHeader('Content-Type', ct);
          }
          res.setHeader('Content-Length', Buffer.byteLength(body));
          res.send(body);
          return;
        }

        // /stream/ path but not HLS — could be an MP4 or other video format.
        // If the content is small (< 1MB), it might be a redirect page or error.
        // If it's large, stream it directly.
        // AniDB .xls segments: override Content-Type to video/mp2t
        if (urlIsStream) {
          // AniDB .xls segment — override Content-Type
          if (pathLower.endsWith('.xls') && hostLower.includes('anidb')) {
            res.status(200);
            res.setHeader('Content-Type', 'video/mp2t');
            res.setHeader('Content-Length', Buffer.byteLength(body));
            res.send(body);
            return;
          }
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
    const stream = gotScraping.stream(targetUrl.href, {
      headers: proxyHeaders,
      timeout: { request: 30000 },
      throwHttpErrors: false,
      followRedirect: true,
      isStream: true,
      http2: false,  // Avoid GOAWAY errors from HTTP/2 servers
    });

    // Wait for the response headers
    const response = await new Promise((resolve, reject) => {
      stream.on('response', (resp) => resolve(resp));
      stream.on('error', (err) => reject(err));
      // Timeout if no response in 15s
      setTimeout(() => reject(new Error('proxy response timeout')), 15000);
    });

    if (response.statusCode >= 400) {
      logger.error(`[${ADDON_NAME}] proxy upstream ${response.statusCode} for ${targetUrl.hostname}`);
      stream.destroy();
      return res.status(response.statusCode).send(`Upstream error: ${response.statusCode}`);
    }

    // Forward status code and headers
    res.status(response.statusCode);
    const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'];
    for (const h of forwardHeaders) {
      const v = response.headers[h];
      if (v) res.setHeader(h, v);
    }

    // AniDB segments return Content-Type: application/vnd.ms-excel (.xls).
    // The body is valid MPEG-TS — override Content-Type to video/mp2t.
    // This must happen BEFORE the stream starts piping.
    const preCt = (response.headers['content-type'] || '').toLowerCase();
    const preSegPath = targetUrl.pathname.toLowerCase();
    const isAniDBXlsSeg = preSegPath.endsWith('.xls') && hostLower.includes('anidb');
    if (preCt.includes("vnd.ms-excel") || isAniDBXlsSeg) {
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
    // AniDB segments return Content-Type: application/vnd.ms-excel (.xls extension)
    // — the body is valid MPEG-TS, override to video/mp2t.
    const ct = (response.headers['content-type'] || '').toLowerCase();
    const segPath = targetUrl.pathname.toLowerCase();
    if (ct.includes('text/html') && (segPath.includes('/content/') || segPath.endsWith('.html') || segPath.includes('page-'))) {
      res.setHeader('Content-Type', 'video/mp2t');
    }
    if (ct.includes('vnd.ms-excel') || ct.includes('application/vnd.ms-excel') || urlIsAniDBSeg) {
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

// Rewrite relative URLs in an m3u8 playlist to absolute /proxy URLs.
// This ensures the player fetches variant playlists and segments through
// the proxy with the correct Referer — without it, relative URLs resolve
// against the proxy URL itself and return 404.
function rewriteM3u8Urls(m3u8Text, baseUrl, referer, req) {
  const lines = m3u8Text.split('\n');
  const proxyBase = `${req.protocol}://${req.get('host')}/proxy`;

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
          return `URI="${proxyUrl.href}"`;
        });
      }
      return line;
    }
    // This line is a URL (variant playlist or segment)
    const absoluteUrl = new URL(trimmed, baseUrl).href;
    const proxyUrl = new URL(proxyBase);
    proxyUrl.searchParams.set('url', absoluteUrl);
    if (referer) proxyUrl.searchParams.set('referer', referer);
    return proxyUrl.href;
  }).join('\n');
}

// ============== HEALTH ==============
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    name: ADDON_NAME,
    version: VERSION,
    uptime: process.uptime(),
    sources: sources.map(s => s.id),
    extractors: extractors.map(e => e.id),
  });
});

// ============== DEBUG (diagnostic — safe, read-only) ==============
// Returns which proxy env vars are SET (boolean only — never exposes values).
app.get('/debug/env', (req, res) => {
  res.json({
    ALL_PROXY: !!process.env.ALL_PROXY,
    HTTPS_PROXY: !!process.env.HTTPS_PROXY,
    HTTP_PROXY: !!process.env.HTTP_PROXY,
    TMDB_API_KEY: !!process.env.TMDB_API_KEY,
    FLARESOLVERR_ENDPOINT: !!process.env.FLARESOLVERR_ENDPOINT,
    NODE_ENV: process.env.NODE_ENV || 'development',
  });
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
    const { streams } = await streamResolver.resolve(ctx, sources, type, parsedId);
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

  const t0 = Date.now();
  try {
    // Call handleInternal directly to bypass the cache
    const results = await Promise.race([
      source.handleInternal(ctx, type, parsedId),
      new Promise(r => setTimeout(() => r({ __timeout: true }), 35000)),
    ]);
    const dt = Date.now() - t0;
    if (results?.__timeout) {
      return res.json({ source: sourceId, type, id: rawId, timedOut: true, durationMs: dt });
    }
    return res.json({
      source: sourceId,
      type,
      id: rawId,
      durationMs: dt,
      count: Array.isArray(results) ? results.length : 0,
      results: Array.isArray(results) ? results.slice(0, 5).map(r => ({
        url: r.url?.href?.slice(0, 150),
        format: r.format,
        meta: { ...r.meta, title: r.meta?.title?.slice(0, 120) },
      })) : [],
    });
  } catch (e) {
    const dt = Date.now() - t0;
    return res.json({
      source: sourceId,
      type,
      id: rawId,
      durationMs: dt,
      error: e?.message || String(e),
      stack: e?.stack?.split('\n').slice(0, 5),
    });
  }
});

// ============== LANDING PAGE ==============
app.get('/', (req, res) => {
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
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
