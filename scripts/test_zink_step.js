// Diagnostic: test ZinkMovies step-by-step and also test Cinejoy on Supergirl 2026
'use strict';

const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const TMDB_API = 'https://api.themoviedb.org/3';
const GEMMA_PLAY = 'https://gemma416okl.com/play';
const RASTA_BASE = 'https://rasta428jem.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers,
      },
    });
    return {
      status: r.status,
      headers: Object.fromEntries(r.headers.entries()),
      body: await r.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function testZinkStepByStep() {
  console.log('\n========== ZINKMOVIES STEP-BY-STEP ==========');

  // Step 0: Find Supergirl 2026 IMDB ID via TMDB search
  console.log('\n[step 0] Search TMDB for "Supergirl" 2026 ...');
  try {
    const r = await fetchWithTimeout(
      `${TMDB_API}/search/tv?api_key=${TMDB_API_KEY}&query=Supergirl&first_air_date_year=2026`
    );
    const data = JSON.parse(r.body);
    console.log('  status:', r.status);
    console.log('  results:', data.results?.slice(0, 5).map(x => ({ id: x.id, name: x.name, date: x.first_air_date })));
  } catch (e) {
    console.error('  ERR:', e.message);
  }

  // Try The Dark Knight IMDB ID for known-good test
  const imdbId = 'tt0468569';
  console.log(`\n[step 1] GET ${GEMMA_PLAY}/${imdbId} ...`);
  let config;
  try {
    const r = await fetchWithTimeout(`${GEMMA_PLAY}/${imdbId}`, {
      headers: { Referer: 'https://new3.zinkmovies.today/' },
    });
    console.log('  status:', r.status, '| body length:', r.body.length);

    // Try the regex extractors
    let m = r.body.match(/let p3 = (\{[\s\S]*?\})\s*;/);
    if (m) {
      console.log('  matched: let p3 = {...}');
      try { config = JSON.parse(m[1].replace(/\\\//g, '/')); } catch (e) { console.log('  parse failed:', e.message); }
    }
    if (!config) {
      m = r.body.match(/new HDVBPlayer\((\{[\s\S]*?\})\)/);
      if (m) {
        console.log('  matched: new HDVBPlayer({...})');
        try { config = JSON.parse(m[1].replace(/\\\//g, '/')); } catch (e) { console.log('  parse failed:', e.message); }
      }
    }
    if (!config) {
      console.log('  NO CONFIG MATCHED');
      console.log('  body preview:', r.body.slice(0, 500));
      // try alternative patterns
      const altPatt = /HDVBPlayer[^{]*(\{[^}]+\})/;
      m = r.body.match(altPatt);
      if (m) console.log('  alt match found:', m[1].slice(0, 200));
    } else {
      console.log('  config:', { file: config.file, key: config.key?.slice(0, 20) });
    }
  } catch (e) {
    console.error('  ERR:', e.message);
  }

  if (!config) return;

  // Step 2: POST to get sources
  let fileUrl = config.file;
  if (!fileUrl.startsWith('http')) fileUrl = RASTA_BASE + fileUrl;
  console.log(`\n[step 2] POST ${fileUrl} ...`);
  try {
    const r = await fetchWithTimeout(fileUrl, {
      method: 'POST',
      headers: {
        'X-CSRF-TOKEN': config.key,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://gemma416okl.com',
        'Referer': `${GEMMA_PLAY}/${imdbId}`,
      },
    });
    console.log('  status:', r.status);
    console.log('  body preview:', r.body.slice(0, 500));
  } catch (e) {
    console.error('  ERR:', e.message);
  }
}

async function testCinejoySupergirl() {
  console.log('\n========== CINEJOY ON SUPERGIRL 2026 ==========');
  // Search TMDB for Supergirl 2026 TV
  try {
    const r = await fetchWithTimeout(
      `${TMDB_API}/search/tv?api_key=${TMDB_API_KEY}&query=Supergirl&first_air_date_year=2026`
    );
    const data = JSON.parse(r.body);
    const sg = data.results?.find(x => /supergirl/i.test(x.name));
    if (!sg) {
      console.log('  Supergirl 2026 not found in TMDB search');
      return;
    }
    console.log('  Found:', sg.id, sg.name, sg.first_air_date);

    // Now load cinejoy scraper and test
    const { createRequire } = await import('module');
    const path = await import('path');
    const url = await import('url');
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const require_ = createRequire(import.meta.url);
    const CINEJOY_PATH = path.join(__dirname, '..', 'src', 'nuvio', 'cinejoy_v2.cjs');
    delete require_.cache[require_.resolve(CINEJOY_PATH)];
    const mod = require_(CINEJOY_PATH);
    const Scraper = mod.CinejoyScraper;
    const scraper = new Scraper();

    // try Lisbon first
    for (const server of ['Lisbon', 'Athens', 'Solara']) {
      console.log(`\n[cinejoy] trying server=${server} series tmdb=${sg.id} S1E1 ...`);
      const t0 = Date.now();
      try {
        const streams = await Promise.race([
          scraper.getSeriesStreams(String(sg.id), 1, 1, server),
          new Promise(r => setTimeout(() => r({ __timeout: true }), 25000)),
        ]);
        const dt = Date.now() - t0;
        if (streams?.__timeout) {
          console.log(`  TIMEOUT after ${dt}ms`);
          continue;
        }
        console.log(`  returned ${Array.isArray(streams) ? streams.length : 0} streams in ${dt}ms`);
        if (Array.isArray(streams)) {
          for (const s of streams.slice(0, 3)) {
            console.log(`  -> ${s.quality} ${s.url?.slice(0, 100)}`);
          }
        }
      } catch (e) {
        console.error(`  ERROR:`, e?.message || e);
      }
    }
  } catch (e) {
    console.error('  TMDB ERR:', e.message);
  }
}

(async () => {
  await testZinkStepByStep().catch(e => console.error('uncaught:', e));
  await testCinejoySupergirl().catch(e => console.error('uncaught:', e));
  console.log('\n========== DONE ==========');
  process.exit(0);
})();
