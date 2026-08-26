// Diagnostic script: tests Cinejoy and ZinkMovies scrapers directly
'use strict';

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

const CINEJOY_PATH = path.join(__dirname, '..', 'src', 'nuvio', 'cinejoy_v2.cjs');
const ZINK_PATH = path.join(__dirname, '..', 'src', 'nuvio', 'zinkmovies_v2.cjs');

async function testCinejoy() {
  console.log('\n========== CINEJOY TEST ==========');
  let Scraper;
  try {
    delete require_.cache[require_.resolve(CINEJOY_PATH)];
    const mod = require_(CINEJOY_PATH);
    Scraper = mod.CinejoyScraper;
    console.log('[load] OK, CinejoyScraper present:', !!Scraper);
  } catch (e) {
    console.error('[load] FAILED:', e?.message || e);
    return;
  }
  if (!Scraper) {
    console.error('[load] CinejoyScraper export missing');
    return;
  }

  const scraper = new Scraper();
  // The Dark Knight (TMDB 155) — known good
  const servers = ['Lisbon', 'Solara', 'Athens'];
  for (const server of servers) {
    try {
      console.log(`[cinejoy] trying server=${server} movie tmdb=155 ...`);
      const t0 = Date.now();
      const streams = await Promise.race([
        scraper.getMovieStreams('155', server),
        new Promise(r => setTimeout(() => r({ __timeout: true }), 30000)),
      ]);
      const dt = Date.now() - t0;
      if (streams?.__timeout) {
        console.log(`[cinejoy] ${server}: TIMEOUT after ${dt}ms`);
        continue;
      }
      console.log(`[cinejoy] ${server}: returned ${Array.isArray(streams) ? streams.length : 0} streams in ${dt}ms`);
      if (Array.isArray(streams) && streams.length > 0) {
        for (const s of streams.slice(0, 3)) {
          console.log(`  -> ${s.quality} ${s.url?.slice(0, 100)}${s.url?.length > 100 ? '...' : ''}`);
        }
      } else {
        console.log(`  raw:`, JSON.stringify(streams)?.slice(0, 200));
      }
    } catch (e) {
      console.error(`[cinejoy] ${server} ERROR:`, e?.message || e);
    }
  }
}

async function testZink() {
  console.log('\n========== ZINKMOVIES TEST ==========');
  let Scraper;
  try {
    delete require_.cache[require_.resolve(ZINK_PATH)];
    const mod = require_(ZINK_PATH);
    Scraper = mod.ZinkMoviesScraper;
    console.log('[load] OK, ZinkMoviesScraper present:', !!Scraper);
  } catch (e) {
    console.error('[load] FAILED:', e?.message || e);
    return;
  }
  if (!Scraper) {
    console.error('[load] ZinkMoviesScraper export missing');
    return;
  }

  const scraper = new Scraper(15000);
  try {
    console.log('[zink] trying movie tmdb=155 ...');
    const t0 = Date.now();
    const streams = await Promise.race([
      scraper.getMovieStreams('155'),
      new Promise(r => setTimeout(() => r({ __timeout: true }), 35000)),
    ]);
    const dt = Date.now() - t0;
    if (streams?.__timeout) {
      console.log(`[zink]: TIMEOUT after ${dt}ms`);
      return;
    }
    console.log(`[zink]: returned ${Array.isArray(streams) ? streams.length : 0} streams in ${dt}ms`);
    if (Array.isArray(streams)) {
      for (const s of streams.slice(0, 5)) {
        console.log(`  -> ${s.quality} referer=${s.headers?.Referer ? 'yes' : 'no'} ${s.url?.slice(0, 100)}${s.url?.length > 100 ? '...' : ''}`);
      }
    } else {
      console.log(`  raw:`, JSON.stringify(streams)?.slice(0, 200));
    }
  } catch (e) {
    console.error(`[zink] ERROR:`, e?.message || e);
  }
}

(async () => {
  await testCinejoy().catch(e => console.error('cinejoy uncaught:', e));
  await testZink().catch(e => console.error('zink uncaught:', e));
  console.log('\n========== DONE ==========');
  process.exit(0);
})();
