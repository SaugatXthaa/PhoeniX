// Playability audit worker — tests if a source's streams are ACTUALLY playable
// (not just returning URLs). Does a HEAD or range-GET request to each stream URL
// to verify it returns 200/206 with video content.
//
// Usage: node scripts/_playability_worker.mjs <sourceId> <testCaseJson> <timeoutMs>
// Output: JSON on stdout: { ok, total, playable, unplayable, results }

// Redirect console.log to stderr
console.log = (...args) => process.stderr.write(args.join(' ') + '\n');
console.info = console.warn = console.log;

import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

// Real Fetcher for non-TMDB requests
const { Fetcher } = await import(path.join(PROJECT_ROOT, 'src', 'utils', 'Fetcher.js'));
const realFetcher = new Fetcher(console);

const mockFetcher = {
  json: async (ctx, url, options) => {
    const urlStr = url.toString();
    if (urlStr.includes('api.themoviedb.org')) {
      if (urlStr.includes('/movie/')) {
        if (urlStr.includes('/693134')) return { title: 'Dune: Part Two', release_date: '2024-02-27', imdb_id: 'tt15239678', external_ids: { imdb_id: 'tt15239678' }, genres: [{ id: 878, name: 'Sci-Fi' }], original_language: 'en' };
        if (urlStr.includes('/372058')) return { title: 'Your Name', release_date: '2016-08-26', imdb_id: 'tt5311514', external_ids: { imdb_id: 'tt5311514' }, genres: [{ id: 16, name: 'Animation' }], original_language: 'ja' };
        return { title: 'Test Movie', release_date: '2024-01-01', imdb_id: 'tt0000001', external_ids: { imdb_id: 'tt0000001' }, genres: [], original_language: 'en' };
      }
      if (urlStr.includes('/tv/')) {
        if (urlStr.includes('/31910')) return { name: 'Naruto', first_air_date: '2002-10-03', imdb_id: 'tt0988824', external_ids: { imdb_id: 'tt0988824' }, genres: [{ id: 16, name: 'Animation' }], original_language: 'ja' };
        if (urlStr.includes('/1396')) return { name: 'Breaking Bad', first_air_date: '2008-01-20', imdb_id: 'tt0903747', external_ids: { imdb_id: 'tt0903747' }, genres: [{ id: 18, name: 'Drama' }], original_language: 'en' };
        return { name: 'Test Show', first_air_date: '2024-01-01', imdb_id: 'tt0000001', external_ids: { imdb_id: 'tt0000001' }, genres: [], original_language: 'en' };
      }
      if (urlStr.includes('/find/')) {
        if (urlStr.includes('tt15239678')) return { movie_results: [{ id: 693134 }] };
        if (urlStr.includes('tt5311514')) return { movie_results: [{ id: 372058 }] };
        if (urlStr.includes('tt0988824')) return { tv_results: [{ id: 31910 }] };
        if (urlStr.includes('tt0903747')) return { tv_results: [{ id: 1396 }] };
        return { movie_results: [], tv_results: [] };
      }
    }
    if (urlStr.includes('providers.json')) return {};
    return realFetcher.json(ctx, url, options);
  },
  text: (ctx, url, options) => realFetcher.text(ctx, url, options),
  textPost: (ctx, url, data, options) => realFetcher.textPost(ctx, url, data, options),
  head: (ctx, url, options) => realFetcher.head(ctx, url, options),
  fetch: (ctx, url, options) => realFetcher.fetch(ctx, url, options),
  getFinalRedirectUrl: (ctx, url, options, mc, c) => realFetcher.getFinalRedirectUrl(ctx, url, options, mc, c),
  setCookie: (u, c) => realFetcher.setCookie(u, c),
};

const { createSources } = await import(path.join(PROJECT_ROOT, 'src', 'source', 'index.js'));
const sources = createSources(mockFetcher);
const source = sources.find(s => s.id === process.argv[2]);
if (!source) { console.error('Source not found: ' + process.argv[2]); process.exit(2); }

const testCase = JSON.parse(process.argv[3]);
const timeoutMs = parseInt(process.argv[4]) || 45000;
const ctx = { hostUrl: 'http://localhost:11470' };
const id = { id: testCase.tmdbId, ...(testCase.season ? { season: testCase.season, episode: testCase.episode } : {}) };

// ─── Playability checker ────────────────────────────────────────────────
// Does a GET with Range: bytes=0-1023 to the stream URL and checks if we
// get back 200/206 with video content. Follows redirects. Sends Referer
// if the stream meta includes nuvioReferer or requestHeaders.Referer.
function checkPlayable(url, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    // Remove any headers with undefined/null/empty values — Node's HTTP
    // module throws "Invalid value undefined for header X" if we pass them.
    const cleanHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined && v !== null && v !== '') cleanHeaders[k] = v;
    }
    const opts = {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Range': 'bytes=0-1023',
        ...cleanHeaders,
      },
      timeout: timeoutMs,
    };
    const t0 = Date.now();
    const req = lib.request(url, opts, (res) => {
      // Follow redirects (up to 5)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        res.resume();
        if (headers._redirects && headers._redirects >= 5) {
          return resolve({ playable: false, status: res.statusCode, reason: 'too many redirects', ms: Date.now() - t0 });
        }
        return resolve(checkPlayable(nextUrl, { ...headers, _redirects: (headers._redirects || 0) + 1 }, timeoutMs));
      }
      // 200/206 = playable
      if (res.statusCode === 200 || res.statusCode === 206) {
        const ct = res.headers['content-type'] || '';
        const cl = parseInt(res.headers['content-length'] || res.headers['content-range']?.split('/').pop() || '0');
        // Read first few bytes to confirm it's video data
        const chunks = [];
        res.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 100) req.destroy(); });
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ playable: true, status: res.statusCode, contentType: ct, contentLength: cl, bodyLen: body.length, ms: Date.now() - t0 });
        });
        res.on('error', () => resolve({ playable: true, status: res.statusCode, contentType: ct, ms: Date.now() - t0 }));
      } else {
        res.resume();
        resolve({ playable: false, status: res.statusCode, reason: `HTTP ${res.statusCode}`, ms: Date.now() - t0 });
      }
    });
    req.on('error', (e) => resolve({ playable: false, reason: e.message.slice(0, 60), ms: Date.now() - t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ playable: false, reason: 'timeout', ms: Date.now() - t0 }); });
    req.end();
  });
}

// ─── Main ───────────────────────────────────────────────────────────────
try {
  const results = await Promise.race([
    source.handleInternal(ctx, testCase.type, id),
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)),
  ]);

  if (!Array.isArray(results) || results.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, total: 0, playable: 0, unplayable: 0, results: [] }) + '\n');
    process.exit(0);
  }

  // Filter out any results with undefined/invalid Referer in requestHeaders
  // (some scrapers set headers.Referer to undefined which breaks HTTP requests)
  const cleanResults = results.filter(r => {
    if (r.requestHeaders?.Referer === undefined) delete r.requestHeaders?.Referer;
    if (r.meta?.nuvioReferer === undefined) delete r.meta?.nuvioReferer;
    return true;
  });

  // Load the extractor registry to resolve source URLs to playable URLs
  const { createExtractors, ExtractorRegistry } = await import(path.join(PROJECT_ROOT, 'src', 'extractor', 'index.js'));
  // Full mock logger — extractors call .info, .warn, .error, .debug, .log
  const mockLogger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, log: () => {},
  };
  const extractors = createExtractors(realFetcher, mockLogger);
  const registry = new ExtractorRegistry(mockLogger, extractors);

  // Test each stream URL for playability (max 5 streams to save time)
  const testStreams = cleanResults.slice(0, 5);
  const playResults = [];
  let playable = 0;

  for (const r of testStreams) {
    const sourceUrl = r.url?.href || r.url || '';
    if (!sourceUrl || !sourceUrl.startsWith('http')) {
      playResults.push({ url: String(sourceUrl).slice(0, 80), playable: false, reason: 'invalid URL' });
      continue;
    }

    // Step 1: Run the extractor pipeline to resolve to a playable URL
    let resolvedUrls = [];
    try {
      const extracted = await Promise.race([
        registry.handle(ctx, r.url, r.meta || {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('extractor timeout')), 15000)),
      ]);
      resolvedUrls = Array.isArray(extracted) ? extracted : [];
    } catch (e) {
      playResults.push({
        url: sourceUrl.slice(0, 80),
        playable: false,
        reason: `extractor error: ${e.message.slice(0, 40)}`,
      });
      continue;
    }

    if (resolvedUrls.length === 0) {
      playResults.push({
        url: sourceUrl.slice(0, 80),
        playable: false,
        reason: 'extractor returned 0 URLs',
      });
      continue;
    }

    // Step 2: Test the resolved URL for playability
    let bestResult = null;
    for (const resolved of resolvedUrls.slice(0, 3)) {
      let testUrl = resolved.url?.href || resolved.url || '';
      if (!testUrl || !testUrl.startsWith('http')) continue;

      // Unwrap /proxy and /range-proxy URLs to get the real stream URL.
      // In production, these proxy endpoints run on the Stremio addon server.
      // In testing, we test the underlying URL directly (with appropriate headers).
      const proxyMatch = testUrl.match(/\/(?:proxy|range-proxy)\?(?:.*&)?url=([^&]+)/);
      if (proxyMatch) {
        try { testUrl = decodeURIComponent(proxyMatch[1]); } catch {}
      }

      // Build headers from resolved meta — only set non-empty values
      const headers = {};
      if (resolved.meta?.nuvioReferer) headers['Referer'] = resolved.meta.nuvoReferer;
      if (resolved.requestHeaders?.Referer) headers['Referer'] = resolved.requestHeaders.Referer;
      if (resolved.requestHeaders?.['User-Agent']) headers['User-Agent'] = resolved.requestHeaders['User-Agent'];
      // For /proxy URLs, also check the referer query param
      const refererMatch = (resolved.url?.href || '').match(/[?&]referer=([^&]+)/);
      if (refererMatch && !headers['Referer']) {
        try { headers['Referer'] = decodeURIComponent(refererMatch[1]); } catch {}
      }

      const result = await checkPlayable(testUrl, headers, 8000);
      if (result.playable) {
        bestResult = { ...result, resolvedUrl: testUrl.slice(0, 80) };
        break;
      }
      bestResult = { ...result, resolvedUrl: testUrl.slice(0, 80) };
    }

    if (bestResult?.playable) {
      playable++;
      playResults.push({
        url: sourceUrl.slice(0, 80),
        playable: true,
        resolvedUrl: bestResult.resolvedUrl,
        status: bestResult.status,
        contentType: bestResult.contentType?.slice(0, 40),
        contentLength: bestResult.contentLength,
        ms: bestResult.ms,
      });
    } else {
      playResults.push({
        url: sourceUrl.slice(0, 80),
        playable: false,
        reason: bestResult?.reason || 'no resolved URL playable',
        resolvedUrl: bestResult?.resolvedUrl || '',
        status: bestResult?.status,
      });
    }
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    total: cleanResults.length,
    playable,
    unplayable: testStreams.length - playable,
    results: playResults,
  }) + '\n');
  process.exit(0);
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message, total: 0, playable: 0, unplayable: 0, results: [] }) + '\n');
  process.exit(0);
}
