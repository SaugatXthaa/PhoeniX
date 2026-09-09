// videasy.to — Stream Extractor (Direct Playable HLS/MP4 via Speedracelight API)
// ============================================================================
// Resolves DIRECT PLAYABLE HLS/MP4 streams from videasy.to via the
// speedracelight.com API (9 provider backends).
//
// CHAIN
//   TMDB ID → db.speedracelight.com/3/<type>/<id> → title, year, imdb_id
//          → player.videasy.to/<type>/<id> (Playwright headless browser)
//          → page calls api.speedracelight.com/<provider>/sources-with-title
//          → decrypts response with custom stream cipher (seed-based)
//          → returns JSON {sources: [{url, quality, type}], subtitles: [...]}
//
// The decryption uses a custom stream cipher (RC4-like key schedule + FNV-1a +
// xmur3 + custom PRNG) that's difficult to port to Node.js. We use Playwright
// to load the videasy player page and call the providers' get() function
// directly in the browser context, where the crypto code is already loaded.
//
// PROVIDERS (9 total)
//   Yoru (cdn) | Cypher (downloader2) | Breach (m4uhd) | Neon (vsrc)
//   Vyse (hdmovie-en) | Killjoy (meine-de) | Fade (hdmovie-hi) | Omen (lamovie) | Raze (superflix)
//
// USAGE
//   node videasy_all_in_one.js <tmdbId> <movie|tv> [season] [episode]
//   node videasy_all_in_one.js 299534 movie          # Avengers: Endgame
//   node videasy_all_in_one.js 1396 tv 1 1           # Breaking Bad S01E01

'use strict';

const https = require('https');

const PROVIDER_NAME = 'Videasy';
const TMDB_API_KEY = '8b7b0c30c50464e92a0d3eb9c2e7f0e3';
const SPEEDRACELIGHT_DB = 'https://db.speedracelight.com';
const PLAYER_BASE = 'https://player.videasy.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function fetchBuf(url, { headers = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': '*/*', ...headers }, timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function getTMDBInfo(tmdbId, type) {
  const isTV = type === 'tv' || type === 'series';
  const r = await fetchBuf(`${SPEEDRACELIGHT_DB}/3/${isTV ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`);
  if (r.status !== 200) return null;
  const j = JSON.parse(r.body.toString('utf8'));
  return {
    title: (isTV ? j.name : j.title) || 'Unknown',
    year: ((isTV ? j.first_air_date : j.release_date) || '').slice(0, 4),
    imdbId: j.imdb_id || (j.external_ids && j.external_ids.imdb_id) || '',
    type: isTV ? 'tv' : 'movie',
  };
}

// Resolve streams by loading the videasy player in a headless browser and
// calling the providers' get() function in the page context.
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isTV = type === 'tv' || type === 'series';
  console.log(`[Videasy] Request: tmdb=${tmdbId} type=${type}` + (isTV ? ` S${season || '?'}E${episode || '?'}` : ''));

  // 1. Get TMDB info
  const info = await getTMDBInfo(tmdbId, type);
  if (!info) { console.log('[Videasy] TMDB fetch failed'); return []; }
  console.log(`[Videasy] ${info.title} (${info.year}) IMDB: ${info.imdbId}`);

  // 2. Load videasy player in headless browser
  let chromium;
  try { chromium = require('playwright').chromium; }
  catch (e) {
    console.log('[Videasy] playwright not found — install with: npm install playwright');
    return [];
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio'],
  });
  const page = await browser.newPage({ userAgent: UA, viewport: { width: 1280, height: 720 } });

  const playerUrl = isTV && season && episode
    ? `${PLAYER_BASE}/tv/${tmdbId}/${season}/${episode}`
    : `${PLAYER_BASE}/movie/${tmdbId}`;
  console.log(`[Videasy] Loading ${playerUrl}...`);
  // Use 'domcontentloaded' instead of 'networkidle' — the page has continuous
  // network activity (analytics, polling) that prevents 'networkidle' from
  // ever being reached, causing a timeout.
  await page.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for the webpack chunks to load (the player JS needs time to initialize)
  await page.waitForTimeout(3000);

  // 3. Call each provider via the page's loaded webpack modules
  const result = await page.evaluate(async ({ title, tmdbId, imdbId, year, type, season, episode }) => {
    for (const chunk of (window.webpackChunk_N_E || [])) {
      if (!chunk || !chunk[1]) continue;
      for (const [id, fn] of Object.entries(chunk[1])) {
        if (id !== '9025') continue;

        const moduleCache = {};
        const req = function(modId) {
          if (moduleCache[modId]) return moduleCache[modId].exports;
          const mod = { exports: {} };
          moduleCache[modId] = mod;
          if (modId === 5225) {
            mod.exports = { Wg: async (url, opts) => {
              if (opts && opts.params) {
                const sp = new URLSearchParams();
                for (const [k, v] of Object.entries(opts.params)) sp.set(k, String(v));
                url = url + (url.includes('?') ? '&' : '?') + sp.toString();
              }
              const r = await fetch(url);
              const text = await r.text();
              // Try to parse as JSON (for /seed endpoint); fall back to raw string (for /sources-with-title)
              try { return JSON.parse(text); } catch (e) { return text; }
            }};
            return mod.exports;
          }
          if (modId === 886) {
            mod.exports = { D: { MOVIE: 'movie', TV: 'tv', ANIME: 'anime' } };
            return mod.exports;
          }
          for (const c of (window.webpackChunk_N_E || [])) {
            if (!c || !c[1] || !c[1][modId]) continue;
            c[1][modId](mod, mod.exports, req);
            return mod.exports;
          }
          return mod.exports;
        };
        req.d = (obj, getters) => {
          for (const [k, v] of Object.entries(getters))
            Object.defineProperty(obj, k, { get: v, enumerable: true });
        };
        req.n = (m) => m && m.default ? m.default : m;
        req.r = (exports) => Object.defineProperty(exports, '__esModule', { value: true });
        req.c = moduleCache;

        const mod = { exports: {} };
        try { fn(mod, mod.exports, req); } catch (e) { return JSON.stringify({ error: e.message }); }
        const exports = mod.exports;
        if (!exports.i || !exports.i.length) return JSON.stringify({ error: 'no providers' });

        // Call providers SEQUENTIALLY (not in parallel) — calling all 9 at once
        // causes the page to crash (OOM on Render's 512MB free tier).
        const results = [];
        for (const provider of exports.i) {
          try {
            const r = await provider.get({
              title: title,
              extraData: {
                tmdbId, imdbId,
                mediaType: type === 'movie' ? 'movie' : 'tv',
                year,
                seasonId: Number(season) || 1,
                episodeId: Number(episode) || 1,
                b35ebba4: 'test',
              }
            });
            results.push({ name: provider.name, note: provider.note, sources: r.sources || [], subtitles: r.subtitles || [] });
          } catch (e) { results.push({ name: provider.name, note: provider.note, error: e.message }); }
        }
        return JSON.stringify(results);
      }
    }
    return JSON.stringify({ error: 'module not found' });
  }, { title: info.title, tmdbId: Number(tmdbId), imdbId: info.imdbId, year: info.year, type: info.type, season: season ? Number(season) : undefined, episode: episode ? Number(episode) : undefined });

  await browser.close();

  // 4. Parse results
  const providers = JSON.parse(result);
  if (providers.error) { console.log(`[Videasy] Error: ${providers.error}`); return []; }

  const allStreams = [];
  const seenUrls = new Set();
  for (const p of providers) {
    if (p.error) {
      console.log(`[Videasy]   ${p.name}: ${p.error.slice(0, 80)}`);
      continue;
    }
    const sources = p.sources || [];
    const subs = p.subtitles || [];
    console.log(`[Videasy]   ${p.name}: ${sources.length} source(s), ${subs.length} subtitle(s)`);
    for (const src of sources) {
      if (!src.url || seenUrls.has(src.url)) continue;
      seenUrls.add(src.url);
      const quality = src.quality || 'HLS';
      const streamType = src.type === 'dash' || src.url?.includes('.mpd')
        ? 'application/dash+xml' : 'application/vnd.apple.mpegurl';
      const isHls = streamType === 'application/vnd.apple.mpegurl';
      allStreams.push({
        name: `${PROVIDER_NAME} [${p.name}] | ${quality} | ${p.note}`,
        title: `${info.title} (${info.year}) [Videasy ${p.name}]`,
        url: src.url,
        quality,
        type: streamType,
        // Pass subtitles from the provider to each stream — buildStreamResults
        // reads s.subtitles and attaches them to meta.subtitles
        subtitles: subs.length > 0 ? subs.map(s => ({
          id: s.lang || s.language || s.srclang || 'en',
          url: s.url || s.file || s.src || '',
          lang: s.lang || s.language || s.srclang || s.label || 'en',
          label: s.label || s.lang || s.language || 'English',
        })).filter(s => s.url) : undefined,
        // No Referer needed — streams from videasy.to are direct playable
        headers: {},
        behaviorHints: { bingeGroup: `videasyto-${p.name}-${quality}` },
      });
    }
  }

  const qOrder = { '4K': 0, '2160p': 0, '1440p': 1, '1080p': 2, '720p': 3, '480p': 4, '360p': 5 };
  allStreams.sort((a, b) => (qOrder[a.quality] || 99) - (qOrder[b.quality] || 99));
  console.log(`[Videasy] ${allStreams.length} stream(s) total`);
  return allStreams;
}

module.exports = { getStreams, getTMDBInfo, PROVIDER_NAME };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Videasy.to Direct Stream Extractor');
    console.log('  Movies + TV — direct playable HLS/MP4 via Speedracelight API');
    console.log('  (Uses Playwright headless browser for decryption)');
    console.log('');
    console.log('Usage: node videasy_all_in_one.js <tmdbId> <movie|tv> [season] [episode]');
    console.log('Examples:');
    console.log('  node videasy_all_in_one.js 299534 movie        # Avengers: Endgame');
    console.log('  node videasy_all_in_one.js 1396 tv 1 1       # Breaking Bad S01E01');
    process.exit(1);
  }
  getStreams(args[0], args[1], args[2], args[3])
    .then(s => {
      console.log('\n=== Final playable streams ===');
      if (s.length === 0) { console.log('No streams found.'); return; }
      s.forEach((x, i) => {
        console.log(`${i+1}. ${x.name}`);
        console.log(`   URL: ${x.url.slice(0, 180)}${x.url.length > 180 ? '...' : ''}`);
      });
      console.log(`\nTotal: ${s.length}`);
    })
    .catch(e => { console.error('FATAL: ' + e.stack); process.exit(1); });
}
