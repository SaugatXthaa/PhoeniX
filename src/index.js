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
const VERSION = '4.0.0';

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
    logo: `${hostUrl}/public/logo.png`,
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
app.get('/proxy', async (req, res) => {
  const rawUrl = req.query.url;
  const rawReferer = req.query.referer;

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
    // Pass through Range header for seeking
    if (req.headers.range) proxyHeaders['Range'] = req.headers.range;

    const response = await fetch(targetUrl.href, {
      headers: proxyHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok && response.status !== 206) {
      logger.error(`[${ADDON_NAME}] proxy upstream ${response.status} for ${targetUrl.hostname}`);
      return res.status(response.status).send(`Upstream error: ${response.status}`);
    }

    // Forward status code and headers
    res.status(response.status);
    const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'];
    for (const h of forwardHeaders) {
      const v = response.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    // Stream the body
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) {
          await new Promise(r => res.once('drain', r));
        }
      }
      res.end();
    };
    pump().catch(() => { try { res.end(); } catch {} });
  } catch (err) {
    logger.error(`[${ADDON_NAME}] proxy error: ${err.message}`);
    if (!res.headersSent) res.status(502).send('Proxy error');
    else try { res.end(); } catch {}
  }
});

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
    background-image: url('${hostUrl}/public/logo.svg');
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
  <img src="${hostUrl}/public/logo.svg" alt="PhoeniX" class="w-20 h-20 mb-3 drop-shadow-[0_0_25px_rgba(255,100,0,0.5)]">
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
