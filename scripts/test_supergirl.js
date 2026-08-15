// Test Cinejoy + ZinkMovies with Supergirl 2026 movie (TMDB 1081003)
'use strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const TMDB_API = 'https://api.themoviedb.org/3';

async function testCinejoy() {
  console.log('\n========== CINEJOY on SUPERGIRL 2026 (tmdb 1081003) ==========');
  // First check IMDB ID
  try {
    const r = await fetch(`${TMDB_API}/movie/1081003/external_ids?api_key=${TMDB_API_KEY}`);
    const d = await r.json();
    console.log('  IMDB:', d.imdb_id, '| TMDB:', 1081003);
  } catch (e) { console.error('  TMDB err:', e.message); }

  const CINEJOY_PATH = path.join(__dirname, '..', 'src', 'nuvio', 'cinejoy_v2.cjs');
  delete require_.cache[require_.resolve(CINEJOY_PATH)];
  const mod = require_(CINEJOY_PATH);
  const Scraper = mod.CinejoyScraper;
  const scraper = new Scraper();

  for (const server of ['Lisbon', 'Athens', 'Solara', 'Castle']) {
    console.log(`\n[cinejoy] server=${server} movie tmdb=1081003 ...`);
    const t0 = Date.now();
    try {
      const streams = await Promise.race([
        scraper.getMovieStreams('1081003', server),
        new Promise(r => setTimeout(() => r({ __timeout: true }), 20000)),
      ]);
      const dt = Date.now() - t0;
      if (streams?.__timeout) {
        console.log(`  TIMEOUT after ${dt}ms`);
        continue;
      }
      console.log(`  returned ${Array.isArray(streams) ? streams.length : 0} streams in ${dt}ms`);
      if (Array.isArray(streams)) for (const s of streams.slice(0, 3)) {
        console.log(`  -> ${s.quality} ${s.url?.slice(0, 100)}`);
      } else {
        console.log(`  raw:`, JSON.stringify(streams)?.slice(0, 200));
      }
    } catch (e) {
      console.error(`  ERROR:`, e?.message || e);
    }
  }
}

async function testZink() {
  console.log('\n========== ZINKMOVIES on SUPERGIRL 2026 ==========');
  const ZINK_PATH = path.join(__dirname, '..', 'src', 'nuvio', 'zinkmovies_v2.cjs');
  delete require_.cache[require_.resolve(ZINK_PATH)];
  const mod = require_(ZINK_PATH);
  const Scraper = mod.ZinkMoviesScraper;
  const scraper = new Scraper(15000);
  try {
    const streams = await scraper.getMovieStreams('1081003');
    console.log(`  returned ${streams?.length || 0} streams`);
    if (Array.isArray(streams)) for (const s of streams.slice(0, 3)) {
      console.log(`  -> ${s.quality} ${s.url?.slice(0, 100)}`);
    }
  } catch (e) {
    console.error(`  ERROR:`, e?.message || e);
  }
}

async function testAniList() {
  console.log('\n========== ANILIST SEARCH for "Supergirl" ==========');
  const query = `query($search: String) { Page(page: 1, perPage: 10) { media(type: ANIME, search: $search, sort: [SEARCH_MATCH, POPULARITY_DESC]) { id idMal title { romaji english native userPreferred } format } } }`;
  try {
    const r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { search: 'Supergirl' } }),
    });
    const d = await r.json();
    console.log('  AniList matches:');
    for (const m of d?.data?.Page?.media || []) {
      console.log('  ', m.id, '| mal:', m.idMal, '| fmt:', m.format,
        '| en:', m.title?.english, '| ro:', m.title?.romaji);
    }
  } catch (e) {
    console.error('  ERR:', e.message);
  }
}

(async () => {
  await testCinejoy().catch(e => console.error('uncaught:', e));
  await testZink().catch(e => console.error('uncaught:', e));
  await testAniList().catch(e => console.error('uncaught:', e));
  console.log('\n========== DONE ==========');
  process.exit(0);
})();
