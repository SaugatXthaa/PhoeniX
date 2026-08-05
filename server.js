// server.js
// PhoeniX server — Express + Stremio SDK
// Faithful adaptation of sootio-stremio-addon/server.js (simplified — no debrid, no usenet, no admin)
//
// Routes:
//   GET  /                                      Landing page (HTML)
//   GET  /manifest.json                         Stremio manifest
//   GET  /:apiKey?/manifest.json                Manifest (API key prefix ignored)
//   GET  /stream/:type/:id.json                 Stremio stream handler (via SDK getRouter)
//   GET  /resolve/httpstreaming/:url(*)         Lazy URL resolver (302 redirect)
//   GET  /health                                Health check

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import axios from 'axios';
import https from 'https';
import { addonBuilder } from 'stremio-addon-sdk';
import { getHttpStreamingStreams } from './lib/stream-provider/alternative-services/http-streams.js';
import { encodeUrlForStreaming } from './lib/http-streams/utils/encoding.js';
import { resolveHttpStreamUrl } from './lib/http-streams/resolvers/http-resolver.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ADDON_NAME = process.env.ADDON_NAME || 'PhoeniX';

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// ============== STREMIO ADDON BUILDER ==============
const manifest = {
    id: 'community.phoenix.addon',
    version: '3.0.0',
    name: ADDON_NAME,
    description: 'PhoeniX — Nuvio/Stremio streaming addon with 37 sources: 111477, 4KHDHub, CineWave, HDHub4u, MKVCinemas, CineDoze, MoviesMod, MoviesLeech, Pahe, DDLBase, MkvBase, SkyMoviesHD, KMMovies, HDMoviesChannel, XDMovies, ZStream, VixSrc, AnimeFlix, AnimePahe, Anikura, Anikoto, Enma, Tenies, Aether, Nima4K, UHDMovies, CineFreak, MoviesEQ, Miruro, AniWaves, AniWave, AcerMovies, MkvDrama, StreamXTV, PrimeShows, HiAnime, FlixHQ.',
    logo: 'https://i.imgur.com/mDU8KgH.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
};

const builder = new addonBuilder(manifest);

function enrichCacheParams(hasResults = true) {
    if (!hasResults) {
        return { cacheMaxAge: 0, staleRevalidate: 0, staleError: 0 };
    }
    // Short cache: 5 min max-age, 15 min stale. This ensures Nuvio doesn't
    // serve stale stream lists for too long after a provider fix is deployed.
    return {
        cacheMaxAge: 5 * 60,
        staleRevalidate: 15 * 60,
        staleError: 30 * 60
    };
}

builder.defineStreamHandler(args => {
    return new Promise((resolve) => {
        if (!args.id || !args.id.match(/tt\d+/i)) {
            resolve({ streams: [], ...enrichCacheParams(false) });
            return;
        }
        const config = args.config || {};
        // Inject host URL (for /resolve/httpstreaming lazy resolver)
        // Always use https:// — Render terminates TLS at the proxy
        config.host = `${args.config?.host || ''}`.replace(/\/$/, '') ||
            `https://${HOST}:${PORT}`;

        const type = args.type;
        const id = args.id;
        if (type !== 'movie' && type !== 'series') {
            resolve({ streams: [], ...enrichCacheParams(false) });
            return;
        }
        const season = type === 'series' ? (String(id).split(':')[1] || null) : null;
        const episode = type === 'series' ? (String(id).split(':')[2] || null) : null;

        const startTime = Date.now();
        getHttpStreamingStreams(config, type, id, { season, episode })
            .then(streams => {
                const duration = Date.now() - startTime;
                const validStreams = (streams || []).filter(Boolean);
                console.log(`[${ADDON_NAME}] ${type} ${id} → ${validStreams.length} streams in ${duration}ms`);
                resolve({
                    streams: validStreams,
                    ...enrichCacheParams(validStreams.length > 0)
                });
            })
            .catch(err => {
                console.error(`[${ADDON_NAME}] Stream handler error for ${type} ${id}:`, err.message);
                resolve({ streams: [], ...enrichCacheParams(false) });
            });
    });
});

// ============== EXPRESS APP ==============
const app = express();
app.use(cors());
app.use(express.json());

// ============== ROUTES ==============

// Landing page
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(landingHtml());
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        name: ADDON_NAME,
        version: '3.0.0',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        sources: ['111477', '4KHDHub', 'CineWave', 'HDHub4u', 'MKVCinemas', 'CineDoze',
                  'MoviesMod', 'MoviesLeech', 'Pahe', 'DDLBase', 'MkvBase',
                  'SkyMoviesHD', 'KMMovies', 'HDMoviesChannel', 'XDMovies', 'ZStream',
                  'VixSrc', 'AnimeFlix', 'AnimePahe', 'Anikura', 'Anikoto', 'Enma',
                  'Tenies', 'Aether', 'Nima4K', 'UHDMovies', 'CineFreak', 'MoviesEQ',
                  'Miruro', 'AniWaves', 'AniWave', 'AcerMovies', 'MkvDrama', 'StreamXTV',
                  'PrimeShows', 'HiAnime', 'FlixHQ']
    });
});

// Manifest (with optional API key prefix)
app.get('/:apiKey?/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(manifest);
});

// Stream handler — mounted at both /stream/:type/:id.json and /:apiKey/stream/:type/:id.json
const streamHandler = async (req, res) => {
    const { type, id } = req.params;
    const apiKey = req.params.apiKey;
    // Always use https:// for the host URL — Render terminates TLS at the proxy,
    // so req.protocol may report 'http' even when the client connects via HTTPS.
    // Using http:// causes a 301 redirect that breaks the resolver's URL encoding.
    const host = `https://${req.headers.host}`;

    if (type !== 'movie' && type !== 'series') {
        return res.json({ streams: [] });
    }

    console.log(`[${ADDON_NAME}] stream ${type} ${id}`);

    try {
        const season = type === 'series' ? (String(id).split(':')[1] || null) : null;
        const episode = type === 'series' ? (String(id).split(':')[2] || null) : null;

        const config = { host };
        const startTime = Date.now();
        const streams = await getHttpStreamingStreams(config, type, id, { season, episode });
        const validStreams = (streams || []).filter(Boolean);
        const duration = Date.now() - startTime;
        console.log(`[${ADDON_NAME}] ${type} ${id} → ${validStreams.length} streams in ${duration}ms`);

        const cacheParams = enrichCacheParams(validStreams.length > 0);
        res.setHeader('Cache-Control', `max-age=${cacheParams.cacheMaxAge}, stale-while-revalidate=${cacheParams.staleRevalidate}, stale-if-error=${cacheParams.staleError}, public`);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json({ streams: validStreams });
    } catch (err) {
        console.error(`[${ADDON_NAME}] Stream error for ${type} ${id}:`, err.message);
        res.json({ streams: [] });
    }
};

app.get('/stream/:type/:id.json', streamHandler);
app.get('/:apiKey/stream/:type/:id.json', streamHandler);

// ============== LAZY URL RESOLVER ==============
// /resolve/httpstreaming/<encoded-url> → 302 redirect to actual stream URL
//
// Two-tier cache TTL:
//   - Short (2 min) for URLs that expire: Google UserContent tokens, gpdl.hubcloud redirects
//   - Long  (10 min) for stable CDN URLs: workers.dev, fileshubcdn, pixeldrain
//
// This prevents the "403 on replay" issue where a cached Google Drive token URL
// expires before the user replays the stream.
const RESOLVE_CACHE_TTL_MS = parseInt(process.env.RESOLVE_CACHE_TTL_MS || '600000', 10); // 10 min default
const RESOLVE_CACHE_TTL_SHORT_MS = parseInt(process.env.RESOLVE_CACHE_TTL_SHORT_MS || '120000', 10); // 2 min for expiring URLs
const HTTP_RESOLVE_TIMEOUT = parseInt(process.env.HTTP_RESOLVE_TIMEOUT || '15000', 10);
const resolvedUrlCache = new Map();
const pendingResolves = new Map();

// URLs containing these patterns expire quickly (Google Drive download tokens ~3 min)
const EXPIRING_URL_PATTERNS = ['video-downloads.googleusercontent.com', 'gpdl.hubcloud', 'drive.google.com'];

// CDNs that require specific Referer/Range headers — must be proxied, not redirected
const PROXY_REQUIRED_HOSTS = ['workers.dev', 'fileshubcdn', 'vmpx.online', 'vmwesa.online'];

// CDNs and their required Referer headers
const CDN_REFERERS = {
    'workers.dev': 'https://gamerxyt.com/',
    'fileshubcdn': 'https://gamerxyt.com/',
    'vmpx.online': 'https://gamerxyt.com/',
    'vmwesa.online': 'https://gamerxyt.com/',
    'hubcdn.fans': 'https://hubcloud.ist/',
};

function isExpiringUrl(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return EXPIRING_URL_PATTERNS.some(p => lower.includes(p));
}

function getResolveCacheTtl(url) {
    return isExpiringUrl(url) ? RESOLVE_CACHE_TTL_SHORT_MS : RESOLVE_CACHE_TTL_MS;
}

function needsProxy(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return PROXY_REQUIRED_HOSTS.some(h => lower.includes(h));
}

function getRefererForUrl(url) {
    if (!url) return null;
    const lower = url.toLowerCase();
    for (const [host, referer] of Object.entries(CDN_REFERERS)) {
        if (lower.includes(host)) return referer;
    }
    return null;
}

/**
 * Proxy a video stream through the server with proper headers.
 * Used for CDNs that require Referer/Range headers (workers.dev, etc.)
 * Supports Range requests for seeking.
 */
function proxyVideoStream(targetUrl, req, res) {
    const referer = getRefererForUrl(targetUrl);
    const proxyHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
    };
    if (referer) proxyHeaders['Referer'] = referer;
    // Forward Range header for seeking
    if (req.headers.range) {
        proxyHeaders['Range'] = req.headers.range;
    } else {
        proxyHeaders['Range'] = 'bytes=0-';
    }

    const protocol = targetUrl.startsWith('https:') ? https : http;
    const proxyReq = protocol.request(targetUrl, {
        method: 'GET',
        headers: proxyHeaders,
        timeout: 30000,
    }, (proxyRes) => {
        // If we get a redirect, follow it
        if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            proxyRes.destroy();
            const redirectUrl = new URL(proxyRes.headers.location, targetUrl).toString();
            return proxyVideoStream(redirectUrl, req, res);
        }

        // Forward status and headers to client
        const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
        res.writeHead(proxyRes.statusCode, Object.fromEntries(
            Object.entries(proxyRes.headers).filter(([k]) => forwardHeaders.includes(k.toLowerCase()))
        ));
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error(`[proxy] error: ${err.message}`);
        if (!res.headersSent) {
            res.status(502).send('Proxy error');
        }
        proxyReq.destroy();
    });

    proxyReq.on('timeout', () => {
        console.error(`[proxy] timeout`);
        if (!res.headersSent) {
            res.status(504).send('Proxy timeout');
        }
        proxyReq.destroy();
    });

    req.on('close', () => {
        proxyReq.destroy();
    });

    proxyReq.end();
}

app.get('/resolve/httpstreaming/:url(*)', async (req, res) => {
    const encodedUrl = req.params.url;
    let targetUrl;
    try {
        targetUrl = decodeURIComponent(encodedUrl);
    } catch {
        return res.status(400).send('Invalid URL');
    }

    const cacheKey = crypto.createHash('md5').update(targetUrl).digest('hex');

    // Check cache — use URL-specific TTL (short for expiring URLs like Google UserContent)
    const cached = resolvedUrlCache.get(cacheKey);
    if (cached && cached.url) {
        const ttl = getResolveCacheTtl(cached.url);
        if (Date.now() - cached.ts < ttl) {
            console.log(`[resolver] cache HIT (TTL=${Math.round(ttl/1000)}s, expiring=${isExpiringUrl(cached.url)}, age=${Math.round((Date.now()-cached.ts)/1000)}s)`);
            // If the resolved URL needs proxy (workers.dev etc.), proxy it instead of redirecting
            if (needsProxy(cached.url)) {
                console.log(`[resolver] proxying cached URL (requires headers)`);
                return proxyVideoStream(cached.url, req, res);
            }
            const redirectUrl = encodeUrlForStreaming(cached.url);
            return res.redirect(302, redirectUrl);
        }
        // Cache expired — evict so we re-resolve on next request
        console.log(`[resolver] cache EXPIRED (age=${Math.round((Date.now()-cached.ts)/1000)}s, ttl=${Math.round(ttl/1000)}s) — re-resolving`);
        resolvedUrlCache.delete(cacheKey);
    }

    // In-flight dedup
    if (pendingResolves.has(cacheKey)) {
        try {
            const finalUrl = await pendingResolves.get(cacheKey);
            if (finalUrl) {
                if (needsProxy(finalUrl)) {
                    console.log(`[resolver] proxying in-flight URL (requires headers)`);
                    return proxyVideoStream(finalUrl, req, res);
                }
                const redirectUrl = encodeUrlForStreaming(finalUrl);
                return res.redirect(302, redirectUrl);
            }
        } catch (e) { /* fall through */ }
    }

    console.log(`[resolver] resolving ${targetUrl.substring(0, 80)}...`);

    const resolvePromise = (async () => {
        try {
            // Use the REAL resolver — handles gadgetsweb.xyz, hubcloud, modpro.blog, etc.
            const finalUrl = await resolveHttpStreamUrl(targetUrl);
            if (finalUrl) {
                return finalUrl;
            }
            // Fallback: return null — do NOT return the original URL (it's an HTML page,
            // not a video, which causes "fully watched" / "unrecognized format" errors)
            console.log(`[resolver] resolveHttpStreamUrl returned null, no fallback`);
            return null;
        } catch (e) {
            console.error(`[resolver] error: ${e.message}`);
            return null;
        }
    })();

    pendingResolves.set(cacheKey, resolvePromise);
    try {
        const finalUrl = await resolvePromise;
        if (finalUrl) {
            resolvedUrlCache.set(cacheKey, { url: finalUrl, ts: Date.now() });
            // If the resolved URL needs proxy (workers.dev etc.), proxy it
            if (needsProxy(finalUrl)) {
                console.log(`[resolver] proxying resolved URL (requires headers)`);
                return proxyVideoStream(finalUrl, req, res);
            }
            const redirectUrl = encodeUrlForStreaming(finalUrl);
            return res.redirect(302, redirectUrl);
        } else {
            // Resolution failed — return 404 so player shows "no stream" instead of
            // trying to play an HTML page
            return res.status(404).send('Stream not found');
        }
    } catch (e) {
        console.error(`[resolver] final error: ${e.message}`);
        return res.status(502).send('Resolution error');
    } finally {
        pendingResolves.delete(cacheKey);
    }
});

// ============== LANDING PAGE ==============
function landingHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${ADDON_NAME} — Nuvio / Stremio Addon</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(135deg, #0a0e1a 0%, #1a1f3a 100%);
    color: #e6e9f5; min-height: 100vh; padding: 2rem;
  }
  .container { max-width: 1100px; margin: 0 auto; }
  .hero { text-align: center; padding: 3rem 0; }
  .hero h1 {
    font-size: 4rem; font-weight: 800;
    background: linear-gradient(135deg, #ff5722 0%, #ffca28 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text; margin-bottom: 1rem;
  }
  .hero p { color: #a0a8c0; font-size: 1.2rem; max-width: 700px; margin: 0 auto 2rem; }
  .install-btn {
    display: inline-block; padding: 1rem 2rem;
    background: linear-gradient(135deg, #ff5722 0%, #ffca28 100%);
    color: #0a0e1a; text-decoration: none; border-radius: 8px;
    font-weight: 700; font-size: 1.1rem;
    transition: transform 0.2s;
  }
  .install-btn:hover { transform: translateY(-2px); }
  .grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 1rem; margin-top: 3rem;
  }
  .source-card {
    background: rgba(255,255,255,0.05); padding: 1.2rem;
    border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);
    text-align: center;
  }
  .source-card .icon { font-size: 2.5rem; margin-bottom: 0.5rem; }
  .source-card .name { font-weight: 700; font-size: 1rem; }
  .source-card .tier { font-size: 0.8rem; color: #a0a8c0; margin-top: 0.25rem; }
  .stats { display: flex; gap: 2rem; justify-content: center; margin: 3rem 0; flex-wrap: wrap; }
  .stat { text-align: center; }
  .stat .num { font-size: 2.5rem; font-weight: 800; color: #ffca28; }
  .stat .lbl { color: #a0a8c0; font-size: 0.9rem; text-transform: uppercase; }
  .footer { text-align: center; padding: 2rem 0; color: #6c7591; font-size: 0.85rem; }
  code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
<div class="container">
  <div class="hero">
    <h1>${ADDON_NAME}</h1>
    <p>Production-grade streaming addon — faithful port of sootio-stremio-addon's HTTPS sources. <strong>11 HTTP streaming providers</strong> running in parallel with per-source timeouts, Cinemeta metadata, FlareSolverr Cloudflare bypass, and lazy URL resolution.</p>
    <a class="install-btn" href="/manifest.json">Install in Nuvio / Stremio</a>
  </div>
  <div class="stats">
    <div class="stat"><div class="num">11</div><div class="lbl">HTTP Providers</div></div>
    <div class="stat"><div class="num">4K</div><div class="lbl">Max Quality</div></div>
    <div class="stat"><div class="num">∞</div><div class="lbl">Movies/Series</div></div>
    <div class="stat"><div class="num">12s</div><div class="lbl">Per-Source Timeout</div></div>
  </div>
  <div class="grid">
    <div class="source-card"><div class="icon">🔥</div><div class="name">111477</div><div class="tier">Direct CDN via p.111477.xyz/bulk</div></div>
    <div class="source-card"><div class="icon">💎</div><div class="name">4KHDHub</div><div class="tier">DDL → HubCloud extraction</div></div>
    <div class="source-card"><div class="icon">🎥</div><div class="name">HDHub4u</div><div class="tier">DDL → HubCloud extraction</div></div>
    <div class="source-card"><div class="icon">🎬</div><div class="name">MKVCinemas</div><div class="tier">DDL → modpro.blog</div></div>
    <div class="source-card"><div class="icon">📺</div><div class="name">SkyMoviesHD</div><div class="tier">Movies + KDramas</div></div>
    <div class="source-card"><div class="icon">🎭</div><div class="name">CineDoze</div><div class="tier">Hindi DDL</div></div>
    <div class="source-card"><div class="icon">📦</div><div class="name">MoviesMod</div><div class="tier">DDL → modpro.blog</div></div>
    <div class="source-card"><div class="icon">🪝</div><div class="name">MoviesLeech</div><div class="tier">DDL → leechpro.blog</div></div>
    <div class="source-card"><div class="icon">🌸</div><div class="name">AnimeFlix</div><div class="tier">Anime DDL</div></div>
    <div class="source-card"><div class="icon">📡</div><div class="name">VixSrc</div><div class="tier">HLS playlists (TMDB)</div></div>
    <div class="source-card"><div class="icon">⚡</div><div class="name">XDMovies</div><div class="tier">API worker</div></div>
  </div>
  <div class="footer">
    <p>${ADDON_NAME} v3.0.0 — Faithful port of sootio-stremio-addon/lib/http-streams/</p>
    <p>Manifest: <code>/manifest.json</code> · Streams: <code>/stream/movie/tt1234567.json</code></p>
  </div>
</div>
</body>
</html>`;
}

// ============== START SERVER ==============
app.listen(PORT, HOST, () => {
    console.log(`[${ADDON_NAME}] listening on http://${HOST}:${PORT}`);
    console.log(`[${ADDON_NAME}] manifest: http://${HOST}:${PORT}/manifest.json`);
    console.log(`[${ADDON_NAME}] NODE_ENV=${process.env.NODE_ENV || 'development'}`);
    console.log(`[${ADDON_NAME}] Sources: 37 providers (111477, 4KHDHub, CineWave, HDHub4u, MKVCinemas, CineDoze, MoviesMod, MoviesLeech, Pahe, DDLBase, MkvBase, SkyMoviesHD, KMMovies, HDMoviesChannel, XDMovies, ZStream, VixSrc, AnimeFlix, AnimePahe, Anikura, Anikoto, Enma, Tenies, Aether, Nima4K, UHDMovies, CineFreak, MoviesEQ, Miruro, AniWaves, AniWave, AcerMovies, MkvDrama, StreamXTV, PrimeShows, HiAnime, FlixHQ)`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// ============== KEEP-ALIVE (prevent Render free tier spin-down) ==============
// Render free tier spins down after 15 min of inactivity. When a request
// comes in on a spun-down server, it takes 30s+ to spin up — causing Nuvio
// to timeout and show 0 streams. This self-ping keeps the server warm.
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL || `https://phoenix-e9au.onrender.com`;
const KEEP_ALIVE_INTERVAL = 5 * 60 * 1000; // 5 minutes
setInterval(() => {
    fetch(`${KEEP_ALIVE_URL}/health`)
        .then(() => console.log(`[keep-alive] pinged ${KEEP_ALIVE_URL}/health`))
        .catch(err => console.log(`[keep-alive] failed: ${err.message}`));
}, KEEP_ALIVE_INTERVAL);
console.log(`[${ADDON_NAME}] Keep-alive enabled: pinging every ${KEEP_ALIVE_INTERVAL / 1000}s`);
