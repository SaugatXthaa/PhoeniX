// src/index.js — PhoeniX addon entry point (WebStreamrMBG port)

import express from 'express';
import cors from 'cors';
import { Fetcher } from './utils/Fetcher.js';
import { createSources } from './source/index.js';
import { createExtractors, ExtractorRegistry } from './extractor/index.js';
import { StreamResolver } from './utils/StreamResolver.js';
import { ImdbId, TmdbId } from './utils/id.js';

const PORT = process.env.PORT || 7000;
const HOST = process.env.HOST || '0.0.0.0';
const ADDON_NAME = process.env.ADDON_NAME || 'PhoeniX';

const logger = console;

const fetcher = new Fetcher(logger);
const sources = createSources(fetcher);
const extractors = createExtractors(fetcher, logger);
const extractorRegistry = new ExtractorRegistry(logger, extractors);
const streamResolver = new StreamResolver(logger, extractorRegistry);

const app = express();
app.use(cors());
app.use(express.json());

// ============== MANIFEST ==============
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    id: 'community.phoenix.addon',
    version: '4.0.0',
    name: ADDON_NAME,
    description: 'PhoeniX — Nuvio/Stremio streaming addon with direct HTTP streams from multiple sources. No external browser needed.',
    logo: 'https://i.imgur.com/mDU8KgH.png',
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

// ============== HEALTH ==============
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    name: ADDON_NAME,
    version: '4.0.0',
    uptime: process.uptime(),
    sources: sources.map(s => s.id),
    extractors: extractors.map(e => e.id),
  });
});

// ============== LANDING ==============
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><title>${ADDON_NAME}</title></head><body style="background:#0a0e1a;color:#e6e9f5;font-family:sans-serif;padding:2rem"><h1>🔥 ${ADDON_NAME} v4.0.0</h1><p>WebStreamrMBG-based streaming addon with ${sources.length} sources and ${extractors.length} extractors.</p><p><a href="/manifest.json" style="color:#ffca28">Install in Nuvio / Stremio</a></p><p>Sources: ${sources.map(s => s.label).join(', ')}</p></body></html>`);
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
