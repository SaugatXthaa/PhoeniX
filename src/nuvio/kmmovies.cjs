// kmmovies.pics — Direct Stream Extractor (up to 4K MKV)
// ============================================================================
// Resolves DIRECT PLAYABLE MKV streams from kmmovies.pics via multiple hosts.
//
// CHAIN
//   kmmovies.pics/<slug>/           → magiclinks.lol URLs (one per quality)
//   w3.magiclinks.lol/<id>-2/       → WATCH ONLINE (R2) + Pixeldrain + other hosts
//   z1.kmphotos.cv/online.php       → JW Player → direct MKV on R2 (480p/720p/1080p)
//   pixeldrain.com/api/file/<id>    → direct MKV (all qualities when available)
//   vikingfile.com                  → has video player but needs Turnstile captcha
//
// HOSTS
//   ✅ KMMovies R2 (Cloudflare R2)   — directly playable, seekable, no auth
//   ✅ Pixeldrain                     — directly playable, seekable, no auth
//   ⚠ Vikingfile                     — needs Turnstile captcha (Playwright)
//   ⚠ Gofile                         — needs guest token + may require premium
//   ❌ Skydrop/Transfer.it/Buzzhiever — need JS execution or have CF challenge
//
// USAGE
//   node kmmovies_all_in_one.js <tmdbId> <movie|tv> [season] [episode]
//   node kmmovies_all_in_one.js search "ananthan kaadu"

'use strict';

const https = require('https');
const { execFile, spawnSync } = require('child_process');

const PROVIDER_NAME = 'KMMovies';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const KMMOVIES_BASE = 'https://kmmovies.rest'; // domain migrated .pics -> .rest (301); old host kept for link compat
const MAGICLINKS_BASE = 'https://w3.magiclinks.lol';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Async curl wrapper — uses execFile (non-blocking) so multiple calls
// can run in parallel via Promise.all
// Supports cookie jars via the cookieFile option.
function fetchBufCurl(url, { headers = {}, timeout = 30000, method = 'GET', body = null, json = false, cookieFile = null } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { 'User-Agent': UA, 'Accept': '*/*', ...headers };
    if (json) finalHeaders['Accept'] = 'application/json';
    const args = ['-sL', '--max-time', String(Math.floor(timeout / 1000)), '-X', method, '-w', '\n__HTTP_STATUS:%{http_code}'];
    // Cookie jar support — saves/loads cookies to a file so multi-step
    // resolution chains (like Skydrop) maintain session state.
    if (cookieFile) {
      args.push('-c', cookieFile, '-b', cookieFile);
    }
    for (const [k, v] of Object.entries(finalHeaders)) args.push('-H', `${k}: ${v}`);
    if (body) {
      args.push('-H', 'Content-Type: application/x-www-form-urlencoded');
      args.push('--data', body);
    }
    args.push(url);
    execFile('curl', args, { maxBuffer: 50 * 1024 * 1024, timeout: timeout + 5000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const out = stdout || '';
      if (out.length === 0 && err) {
        // Render's node:20-slim Docker image ships WITHOUT curl — spawn fails
        // ENOENT and every kmmovies fetch died server-side (sandbox had curl,
        // production didn't → 0 streams). Fall back to a child Node https GET
        // (no cookie-jar support — cookie flows degrade, plain GET/POST work).
        if (err.code === 'ENOENT' || /ENOENT|not found/i.test(err.message || '')) {
          // Task 51: got-scraping attempt first (Chrome TLS passes the CF
          // gates that plain-Node TLS fails on Render), node child last.
          return fetchBufViaGotScraping(url, finalHeaders, timeout, method, body)
            .then(resolve)
            .catch(() => {
              try {
                const fb = fetchBufViaNodeChild(url, finalHeaders, timeout, method, body);
                return resolve(fb);
              } catch (e2) {
                return reject(new Error(`curl+got+node failed: ${(e2.message || '').slice(0, 80)}`));
              }
            });
        }
        return reject(new Error(`curl failed: ${(err.message || '').slice(0, 80)}`));
      }
      const statusMatch = out.match(/__HTTP_STATUS:(\d+)$/);
      const status = statusMatch ? parseInt(statusMatch[1]) : 200;
      const responseBody = statusMatch ? out.replace(/\n__HTTP_STATUS:\d+$/, '') : out;
      resolve({ status, body: Buffer.from(responseBody, 'utf8') });
    });
  });
}

// Node-child https fallback (see fetchBufCurl ENOENT branch): same
// {status, body:string} shape as the curl path, minus cookie-jar support.

// Task 51: in-process got-scraping fallback — runs BEFORE the node child.
// Production evidence (2026-09): w3.magiclinks.lol Cloudflare-challenges
// Render's plain-Node TLS (403 "Just a moment") while curl (sandbox) and
// got-scraping's Chrome-JA3 pass. Render's node:20-slim has no curl (ENOENT),
// so every quality page died → "no streams" on every title. got-scraping is
// the codebase's standard CF-bypass transport; the plain-node child stays as
// the last resort.
let _gsMod = null;
async function fetchBufViaGotScraping(url, finalHeaders, timeout, method = 'GET', body = null) {
  if (!_gsMod) _gsMod = await import('got-scraping');
  // Task 64: h2→h1 fallback. magiclinks.lol (and other CF-gated hops on this
  // chain) intermittently kill h2 conns (GOAWAY class) while h1 with the same
  // browser JA3 lands — the animekai.at pattern from Task 52.
  for (const http2 of [true, false]) {
    try {
      const res = await _gsMod.gotScraping(url, {
        method,
        body: body || undefined,
        headers: finalHeaders,
        timeout: { request: timeout },
        throwHttpErrors: false,
        followRedirect: true,
        http2,
      });
      if (res.statusCode >= 400 && http2) continue; // retry once on h1
      return { status: res.statusCode, body: Buffer.from(res.body || '', 'utf8') };
    } catch (e) {
      if (!http2) throw e;
    }
  }
  // unreachable (h1 throw rethrows) — kept for shape safety
  return { status: 0, body: Buffer.alloc(0) };
}

function fetchBufViaNodeChild(url, finalHeaders, timeout, method = 'GET', body = null) {
  const script = `
    const https = require('https'); const http = require('http');
    const u = new URL(process.argv[1]);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({ hostname: u.hostname, path: u.pathname + u.search,
      headers: JSON.parse(process.argv[2]), method: process.argv[3],
      timeout: ${Math.min(Number(timeout) || 30000, 30000)} }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        process.stdout.write(Buffer.concat(chunks));
        process.stdout.write('\\n__HTTP_STATUS:' + res.statusCode);
      });
    });
    req.on('error', (e) => { process.stderr.write('__ERROR__' + e.message); process.exit(1); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (process.argv[4]) req.write(process.argv[4]);
    req.end();
  `;
  const res = spawnSync(process.execPath, ['-e', script, url, JSON.stringify(finalHeaders), method, body || ''],
    { maxBuffer: 50 * 1024 * 1024, timeout: timeout + 5000, encoding: 'buffer' });
  if (res.error || res.status !== 0) {
    throw new Error(`node fallback failed for ${url}: ${(res.error?.message || res.stderr?.toString() || 'unknown').slice(0, 100)}`);
  }
  const str = res.stdout.toString('utf8');
  const statusMatch = str.match(/__HTTP_STATUS:(\d+)\s*$/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 200;
  const responseBody = statusMatch ? str.replace(/\n__HTTP_STATUS:\d+\s*$/, '') : str;
  return { status, body: Buffer.from(responseBody, 'utf8') };
}

function fetchBufNode(url, { headers = {}, timeout = 30000, method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOpts = {
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'User-Agent': UA, 'Accept': '*/*', ...headers }, timeout,
    };
    if (body) {
      reqOpts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function fetchText(url, opts = {}) {
  const r = await fetchBufCurl(url, opts);
  return r.body.toString('utf8');
}

async function getTMDBInfo(tmdbId, type) {
  const isTV = type === 'tv' || type === 'series';
  const r = await fetchBufNode(`https://api.themoviedb.org/3/${isTV ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`);
  if (r.status !== 200) return null;
  const j = JSON.parse(r.body.toString('utf8'));
  return {
    title: (isTV ? j.name : j.title) || 'Unknown',
    year: ((isTV ? j.first_air_date : j.release_date) || '').slice(0, 4),
    type: isTV ? 'tv' : 'movie',
  };
}

async function searchKMMovies(query) {
  try {
    const html = await fetchText(`${KMMOVIES_BASE}/?s=${encodeURIComponent(query)}`, {
      headers: { Referer: KMMOVIES_BASE + '/', 'Accept': 'text/html' },
    });
    const matches = [...html.matchAll(/href="(https:\/\/kmmovies\.(?:pics|rest)\/([^"\/]+))\/?"/g)];
    const results = new Map();
    const skipSlugs = ['category', 'tag', 'genre', 'year', 'actor', 'director', 'writer', 'browse', 'page', 'wp-content', 'wp-includes', 'trending', 'disclaimer', 'faq', 'privacy-policy', 'dmca', 'comments', 'feed'];
    for (const m of matches) {
      const url = m[1] + '/';
      const slug = m[2];
      if (skipSlugs.some(kw => slug.includes(kw))) continue;
      if (slug.length < 3) continue;
      if (!results.has(slug)) results.set(slug, { url, slug, title: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) });
    }
    return [...results.values()];
  } catch (e) { return []; }
}

async function findMovieByTitle(title, year) {
  const queries = [title, title.replace(/\s*\(.*?\)\s*/g, '').trim()];
  for (const q of queries) {
    const results = await searchKMMovies(q);
    if (results.length === 0) continue;
    const yearMatch = year ? results.find(r => r.slug.includes(`-${year}`)) : null;
    const exact = results.find(r => r.title.toLowerCase() === title.toLowerCase());
    // Task 37: no blind results[0] pick — same wrong-content class as
    // reanime/animesuge (first search hit served under the requested title)
    const picked = yearMatch || exact || null;
    if (picked) { console.log(`[KMMovies] Search "${q}" → ${results.length} results, picked: ${picked.slug}`); return picked; }
  }
  return null;
}

function extractMagiclinks(html) {
  const links = [];
  const sectionMatch = html.match(/id="download-links"[\s\S]*?(?=<footer|<\/body|$)/);
  if (!sectionMatch) return links;
  const section = sectionMatch[0];
  const urlMatches = [...section.matchAll(/href="(https:\/\/[^"]*magiclinks[^"]*)"/g)];
  for (const m of urlMatches) {
    const href = m[1];
    const start = Math.max(0, m.index - 300);
    const end = Math.min(section.length, m.index + 200);
    const context = section.substring(start, end);
    const text = context.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    let quality = 'unknown';
    let size = '';
    if (/\b2160p\b/i.test(text) || /\b4k\b/i.test(text)) quality = '4K';
    else if (/\b1080p\b/i.test(text)) quality = '1080p';
    else if (/\b720p\b/i.test(text)) quality = '720p';
    else if (/\b480p\b/i.test(text)) quality = '480p';
    if (/10bit/i.test(text)) quality += ' 10BIT';
    if (/hdr/i.test(text)) quality += ' HDR';
    if (/dv\b/i.test(text)) quality += ' DV';
    const sizeMatch = text.match(/([\d.]+)\s*(MB|GB)/i);
    if (sizeMatch) size = `${sizeMatch[1]} ${sizeMatch[2]}`;
    links.push({ url: href, quality, size, text });
  }
  return links;
}

// ─── Resolve magiclinks page → stream URLs ────────────────────────────────
// Returns array of { url, source, playable } where playable=true means
// the URL is a direct playable stream (no captcha/auth needed).
async function resolveMagiclinks(magiclinksUrl) {
  const html = await fetchText(magiclinksUrl, { headers: { Referer: KMMOVIES_BASE + '/' } });
  // Task 65: CF verdict propagation. magiclinks.lol answers datacenter egress
  // (Render) with the "Just a moment..." challenge page — HTTP 200/403 HTML
  // with zero link matches. Throwing a flagged error lets getStreams abort the
  // WHOLE batch loop on the first verdict instead of burning 20+ fetches ×
  // the got h2→h1 ladder on links that will all be challenged identically.
  if (/Just a moment|challenge-platform|cf-browser-verification|cf_chl_/i.test(html)) {
    const err = new Error('CF_CHALLENGE');
    err.cfGated = true;
    throw err;
  }

  // Collect all host match data first
  const watchOnlineMatch = html.match(/href="(https:\/\/z1\.kmphotos\.cv\/online\.php\?file=[^"]+)"/);
  const pixeldrainMatch = html.match(/href="https:\/\/pixeldrain\.com\/u\/([^"]+)"/);
  const vikingfileMatch = html.match(/href="https:\/\/vikingfile\.com\/f\/([^"]+)"/);
  const gofileMatch = html.match(/href="https:\/\/gofile\.io\/d\/([^"]+)"/);
  const skydropMatch = html.match(/href="(https:\/\/w1\.skydrop\.sbs\/download\.php\?id=[^"]+)"/);
  // NEW magiclinks layout (2025+): per-quality pages now link to
  // HubCloud/GDFlix/GDTot/FilePress instead of the old R2+Pixeldrain set.
  const hubcloudMatch = html.match(/href="(https:\/\/hubcloud\.[a-z.]+\/drive\/([^"]+))"/);

  // Start all resolvers in PARALLEL for maximum speed
  const promises = [];

  // 1. R2 (WATCH ONLINE → z1.kmphotos.cv → JW Player → direct MKV)
  if (watchOnlineMatch) {
    promises.push((async () => {
      try {
        const playerHtml = await fetchText(watchOnlineMatch[1], { headers: { Referer: MAGICLINKS_BASE + '/' } });
        const mkvMatch = playerHtml.match(/file:\s*"([^"]+)"/);
        if (mkvMatch) return { url: mkvMatch[1], source: 'R2', playable: true };
      } catch {}
      return null;
    })());
  }

  // 2. Pixeldrain (instant — no resolution needed)
  if (pixeldrainMatch) {
    promises.push(Promise.resolve({ url: `https://pixeldrain.com/api/file/${pixeldrainMatch[1]}`, source: 'Pixeldrain', playable: true }));
  }

  // 3. Vikingfile
  if (vikingfileMatch) {
    promises.push((async () => {
      const directUrl = await resolveVikingfile(`https://vik1ngfile.site/f/${vikingfileMatch[1]}`);
      return directUrl ? { url: directUrl, source: 'Vikingfile', playable: true } : null;
    })());
  }

  // 4. Gofile
  if (gofileMatch) {
    promises.push((async () => {
      const directUrl = await resolveGofile(gofileMatch[1]);
      return directUrl ? { url: directUrl, source: 'Gofile', playable: true } : null;
    })());
  }

  // 5. Skydrop
  if (skydropMatch) {
    promises.push((async () => {
      const directUrl = await resolveSkydrop(skydropMatch[1]);
      return directUrl ? { url: directUrl, source: 'Skydrop', playable: true } : null;
    })());
  }

  // 6. HubCloud drive page — NEW magiclinks layout primary host. The URL is
  //    a HubCloud drive PAGE, not a direct file: the addon's HubExtractor
  //    claims it (HUB_HOST_PATTERN) and resolves it to a direct MKV at
  //    stream time — the same proven path as 4KHDHub/HDHub4u streams.
  //    GDTot/FilePress (token/login gated) and GDFlix (session-tokened CDN
  //    links) stay unresolved on purpose.
  if (hubcloudMatch) {
    promises.push(Promise.resolve({ url: hubcloudMatch[1], source: 'HubCloud', playable: true }));
  }

  // Wait for all resolvers in parallel, filter out nulls
  const results = await Promise.allSettled(promises);
  return results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
}

// ─── Vikingfile resolver ──────────────────────────────────────────────────
// Vikingfile uses Cloudflare Turnstile captcha. After solving, a POST request
// to the file page returns {link: "direct_url"}.
//
// Strategy: Use curl for all requests (handles TLS better than Node fetch).
//   1. POST with empty Turnstile token (some files don't require captcha)
//   2. POST with dummy token (test tokens sometimes work)
//   3. Scrape page HTML for embedded video source URLs
async function resolveVikingfile(fileUrl) {
  try {
    // Strategy 1: POST with empty token via curl
    const r1 = await fetchBufCurl(fileUrl, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Referer': fileUrl },
      body: 'cf-turnstile-response=',
      timeout: 5000,
    });
    if (r1.status === 200) {
      try {
        const json = JSON.parse(r1.body.toString('utf8'));
        if (json.link) return json.link;
      } catch {}
    }

    // Strategy 2: POST with test token via curl
    const r2 = await fetchBufCurl(fileUrl, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Referer': fileUrl },
      body: 'cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX',
      timeout: 5000,
    });
    if (r2.status === 200) {
      try {
        const json = JSON.parse(r2.body.toString('utf8'));
        if (json.link) return json.link;
      } catch {}
    }

    // Strategy 3: Scrape page HTML for video source URLs
    const pageHtml = (await fetchBufCurl(fileUrl, { headers: { 'Accept': 'text/html' }, timeout: 5000 })).body.toString('utf8');

    // Look for video source in data-setup attribute
    const setupMatch = pageHtml.match(/data-setup='([^']+)'/);
    if (setupMatch) {
      try {
        const setup = JSON.parse(setupMatch[1].replace(/'/g, '"'));
        if (setup.sources?.[0]?.src) return setup.sources[0].src;
      } catch {}
    }

    // Look for any direct video URLs embedded in script tags
    const scriptUrls = [...pageHtml.matchAll(/['"](https?:\/\/[^'"'\s]+\.(?:mkv|mp4|m3u8|webm)[^'"'\s]*)['"]/gi)];
    if (scriptUrls.length > 0) return scriptUrls[0][1];

    // Strategy 4: Check if the poster URL reveals the video CDN pattern
    // Poster: https://narrow-wilson.s3.eu-west-par.io.cloud.ovh.net/6a65120482d869a4.webp
    // The OVH S3 bucket may allow listing objects
    const posterMatch = pageHtml.match(/poster="([^"]+\.(?:webp|jpg|png))"/);
    if (posterMatch) {
      const posterUrl = posterMatch[1];
      const baseUrl = posterUrl.replace(/\/[^/]+$/, '');
      const fileId = posterUrl.match(/\/([a-f0-9]+)\./)?.[1];
      if (fileId) {
        // Try common video file patterns at the same CDN path
        for (const ext of ['.mp4', '.mkv', '/index.m3u8']) {
          const testUrl = baseUrl + '/' + fileId + ext;
          try {
            const testRes = await fetchBufCurl(testUrl, { method: 'GET', timeout: 3000 });
            if (testRes.status === 200) return testUrl;
          } catch {}
        }
        // Try OVH S3 bucket listing to find all objects with this file ID
        try {
          const listRes = await fetchBufCurl(baseUrl + '/', { timeout: 5000 });
          if (listRes.status === 200) {
            const listXml = listRes.body.toString('utf8');
            // S3 listing returns XML with <Key> elements
            const keys = [...listXml.matchAll(/<Key>([^<]+)<\/Key>/g)];
            for (const key of keys) {
              if (key[1].includes(fileId) && /\.(mp4|mkv|m3u8|webm)$/i.test(key[1])) {
                return baseUrl + '/' + key[1];
              }
            }
          }
        } catch {}
      }
    }

    // Strategy 5: Try fetching the page with a Referer that might skip captcha
    const directRes = await fetchBufCurl(fileUrl, {
      headers: { 'Referer': MAGICLINKS_BASE + '/', 'Accept': 'application/json' },
      timeout: 5000,
    });
    if (directRes.status === 200) {
      try {
        const json = JSON.parse(directRes.body.toString('utf8'));
        if (json.link) return json.link;
      } catch {}
    }

    return null;
  } catch (e) {
    console.log(`[KMMovies] Vikingfile resolve failed: ${e.message.slice(0, 60)}`);
    return null;
  }
}

// ─── Gofile resolver ──────────────────────────────────────────────────────
// Gofile has a public API (api.gofile.io). Use curl for all requests since
// Node's native fetch times out on this host.
//   1. POST api.gofile.io/accounts → get guest token
//   2. GET api.gofile.io/contents/{fileId}?wt=4fd → get direct download URL
//
// Note: Some files require premium access (error-notPremium). The resolver
// returns null for these — only free/guest-accessible files are resolved.
async function resolveGofile(fileId) {
  try {
    // Step 1: Create guest account via curl
    const acctRes = fetchBufCurl('https://api.gofile.io/accounts', {
      method: 'POST',
      json: true,
      timeout: 10000,
    });
    if (acctRes.status !== 200) {
      console.log('[KMMovies] Gofile: API unreachable');
      return null;
    }
    const acctData = JSON.parse(acctRes.body.toString('utf8'));
    const token = acctData.data?.token;
    if (!token) return null;

    // Step 2: Get file content via curl (wt=4fd is the website token)
    const contentRes = fetchBufCurl(`https://api.gofile.io/contents/${fileId}?wt=4fd`, {
      headers: { 'Authorization': `Bearer ${token}` },
      json: true,
      timeout: 8000,
    });
    if (contentRes.status !== 200) return null;
    const contentData = JSON.parse(contentRes.body.toString('utf8'));

    // Check for premium-only files
    if (contentData.status === 'error-notPremium') {
      console.log('[KMMovies] Gofile: file requires premium account');
      return null;
    }
    if (contentData.status !== 'ok') {
      console.log('[KMMovies] Gofile: ' + contentData.status);
      return null;
    }

    // Step 3: Extract direct download URL from content
    const contents = contentData.data?.contents || {};
    for (const key of Object.keys(contents)) {
      const file = contents[key];
      if (file.directLink) return file.directLink;
      // Gofile returns a link field that needs the server prefix
      if (file.link) {
        if (file.link.startsWith('http')) return file.link;
        const server = contentData.data?.server || 'store1';
        return `https://${server}.gofile.io/download/${file.link}`;
      }
      if (file.url && file.url.startsWith('http')) return file.url;
    }

    return null;
  } catch (e) {
    console.log(`[KMMovies] Gofile resolve failed: ${e.message.slice(0, 60)}`);
    return null;
  }
}

// ─── Skydrop resolver ─────────────────────────────────────────────────────
// Skydrop (w1.skydrop.sbs) uses a 3-step resolution:
//   1. GET download.php?id=XXX → sets session cookie, shows loading page
//   2. POST /resolve/ (with cookie) → returns {ready_url: "/id/"}
//   3. GET /fetch/ (with cookie) → returns direct MKV video data
//
// The /fetch/ URL requires the session cookie, so we pass it via headers.
// The NuvioExtractor routes through /proxy which forwards request headers.
async function resolveSkydrop(downloadUrl) {
  try {
    // Use a unique cookie file per resolution to maintain session state
    // across the 3-step resolution chain
    const cookieFile = '/tmp/skydrop_' + Buffer.from(downloadUrl).toString('base64').slice(0, 16) + '.txt';

    // Step 1: Fetch download page to get session cookie
    const pageRes = await fetchBufCurl(downloadUrl, {
      headers: { 'Referer': MAGICLINKS_BASE + '/', 'Accept': 'text/html' },
      timeout: 8000,
      cookieFile,
    });
    const pageHtml = pageRes.body.toString('utf8');

    // Check if file is available
    if (pageHtml.includes('Download Unavailable') || pageHtml.includes("couldn't locate your file")) {
      console.log('[KMMovies] Skydrop: file expired/unavailable');
      return null;
    }

    // Step 2: POST to /resolve/ (with session cookie from step 1)
    const resolveRes = await fetchBufCurl('https://w1.skydrop.sbs/resolve/', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Referer': downloadUrl },
      timeout: 10000,
      cookieFile,
    });

    let readyUrl = null;
    if (resolveRes.status === 200) {
      try {
        const data = JSON.parse(resolveRes.body.toString('utf8'));
        if (data.success && data.ready_url) {
          readyUrl = data.ready_url.startsWith('http')
            ? data.ready_url
            : 'https://w1.skydrop.sbs' + data.ready_url;
        }
        // If pending, retry once after 3s
        if (data.success && data.pending) {
          await new Promise(r => setTimeout(r, 3000));
          const retryRes = await fetchBufCurl('https://w1.skydrop.sbs/resolve/', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Referer': downloadUrl },
            timeout: 10000,
            cookieFile,
          });
          if (retryRes.status === 200) {
            const retryData = JSON.parse(retryRes.body.toString('utf8'));
            if (retryData.success && retryData.ready_url) {
              readyUrl = retryData.ready_url.startsWith('http')
                ? retryData.ready_url
                : 'https://w1.skydrop.sbs' + retryData.ready_url;
            }
          }
        }
      } catch {}
    }

    if (!readyUrl) {
      console.log('[KMMovies] Skydrop: resolve failed (no ready_url)');
      return null;
    }

    // Step 3: Visit /id/ page (sets up the download session)
    await fetchBufCurl(readyUrl, {
      headers: { 'Accept': 'text/html', 'Referer': downloadUrl },
      timeout: 5000,
      cookieFile,
    });

    // Step 4: GET /fetch/ (with session cookie) → returns direct MKV stream
    const fetchUrl = 'https://w1.skydrop.sbs/fetch/';
    const verifyRes = await fetchBufCurl(fetchUrl, {
      headers: { 'Referer': readyUrl, 'Accept': 'video/*,*/*' },
      timeout: 5000,
      cookieFile,
    });

    // Check if we got MKV data (EBML header: 1A 45 DF A3)
    const header = verifyRes.body.slice(0, 4).toString('hex');
    if (header === '1a45dfa3') {
      console.log('[KMMovies] Skydrop: ✅ direct MKV stream confirmed');
      return fetchUrl;
    }

    // Check for "matroska" in the first 100 bytes
    if (verifyRes.body.slice(0, 100).toString('ascii').toLowerCase().includes('matroska')) {
      console.log('[KMMovies] Skydrop: ✅ Matroska MKV stream confirmed');
      return fetchUrl;
    }

    // If we got binary data that's not HTML, it might still be video
    const bodyStart = verifyRes.body.toString('utf8').slice(0, 20);
    if (!bodyStart.includes('<!DOCTYPE') && !bodyStart.includes('<html') && verifyRes.body.length > 1000) {
      console.log('[KMMovies] Skydrop: ✅ binary data received (likely video)');
      return fetchUrl;
    }

    console.log('[KMMovies] Skydrop: /fetch/ did not return video data');
    return null;
  } catch (e) {
    console.log(`[KMMovies] Skydrop resolve failed: ${e.message.slice(0, 60)}`);
    return null;
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isTV = type === 'tv' || type === 'series';
  console.log(`[KMMovies] Request: tmdb=${tmdbId} type=${type}`);

  const info = await getTMDBInfo(tmdbId, type);
  if (!info) { console.log('[KMMovies] TMDB fetch failed'); return []; }
  console.log(`[KMMovies] TMDB: ${info.title} (${info.year})`);

  const movie = await findMovieByTitle(info.title, info.year);
  if (!movie) { console.log('[KMMovies] No matching movie found'); return []; }
  console.log(`[KMMovies] Found: ${movie.title} → ${movie.url}`);

  const movieHtml = await fetchText(movie.url, { headers: { Referer: KMMOVIES_BASE + '/' } });
  const magiclinks = extractMagiclinks(movieHtml);
  if (magiclinks.length === 0) { console.log('[KMMovies] No download links found'); return []; }
  console.log(`[KMMovies] Found ${magiclinks.length} quality versions:`);
  for (const ml of magiclinks) console.log(`  - ${ml.quality}${ml.size ? ` (${ml.size})` : ''} → ${ml.url.slice(0, 60)}...`);

  const allStreams = [];
  const seenUrls = new Set();
  const batchSize = 5;
  // Task 65: first CF verdict ends the loop — every magiclinks fetch from a
  // challenged egress returns the same challenge page (measured: 142ms 403).
  let cfGated = false;
  for (let i = 0; i < magiclinks.length && !cfGated; i += batchSize) {
    const batch = magiclinks.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(ml => resolveMagiclinks(ml.url)));
    if (results.some(r => r.status === 'rejected' && r.reason?.cfGated)) {
      cfGated = true;
      console.log('[KMMovies] magiclinks.lol CF-gated from this egress — honest zero (source works device-side)');
    }
    for (let j = 0; j < results.length; j++) {
      const ml = batch[j];
      const result = results[j];
      if (result.status !== 'fulfilled' || result.value.length === 0) {
        console.log(`[KMMovies]   ${ml.quality}: no streams`);
        continue;
      }
      for (const stream of result.value) {
        if (seenUrls.has(stream.url)) continue;
        seenUrls.add(stream.url);
        const qualityLabel = ml.quality.replace(/\s+/g, '+');
        allStreams.push({
          name: `${PROVIDER_NAME} [${stream.source}] | ${ml.quality}${ml.size ? ` | ${ml.size}` : ''}`,
          title: `${info.title} (${info.year}) [KMMovies ${ml.quality} ${stream.source}]`,
          url: stream.url,
          quality: ml.quality.startsWith('4K') ? '4K' : ml.quality.split(' ')[0],
          type: 'video/x-matroska',
          behaviorHints: {
            bingeGroup: `kmmovies-${qualityLabel}-${stream.source}`,
            notWebReady: !stream.playable,
          },
        });
        console.log(`[KMMovies]   ${ml.quality}: ${stream.playable ? '✅' : '⚠'} ${stream.source} → ${stream.url.slice(0, 80)}...`);
      }
    }
  }

  // Sort: playable 4K first, then playable 1080p, etc. Non-playable at the end.
  const qOrder = { '4K': 0, '2160p': 0, '1440p': 1, '1080p': 2, '720p': 3, '480p': 4, '360p': 5 };
  allStreams.sort((a, b) => {
    const qA = qOrder[a.quality] || 99;
    const qB = qOrder[b.quality] || 99;
    const pA = a.behaviorHints?.notWebReady ? 100 : 0;
    const pB = b.behaviorHints?.notWebReady ? 100 : 0;
    return (qA + pA) - (qB + pB);
  });

  const playable = allStreams.filter(s => !s.behaviorHints?.notWebReady);
  const infoOnly = allStreams.filter(s => s.behaviorHints?.notWebReady);
  console.log(`[KMMovies] ${allStreams.length} stream(s) total (${playable.length} playable, ${infoOnly.length} download-only)`);

  // Return ALL streams (both playable and download-only) — the client can filter.
  return allStreams;
}

module.exports = { getStreams, searchKMMovies, findMovieByTitle, extractMagiclinks, resolveMagiclinks, PROVIDER_NAME };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('KMMovies.pics Direct Stream Extractor');
    console.log('  Movies — direct playable MKV (up to 4K) via R2 + Pixeldrain');
    console.log('');
    console.log('Usage:');
    console.log('  node kmmovies_all_in_one.js <tmdbId> <movie|tv> [season] [episode]');
    console.log('  node kmmovies_all_in_one.js search "ananthan kaadu"');
    process.exit(1);
  }
  if (args[0] === 'search') {
    searchKMMovies(args[1]).then(r => {
      console.log('\n=== Search results ===');
      r.forEach((x, i) => console.log(`${i+1}. ${x.title} → ${x.url}`));
    }).catch(e => { console.error(e); process.exit(1); });
  } else {
    getStreams(args[0], args[1] || 'movie', args[2], args[3])
      .then(s => {
        console.log('\n=== Final playable streams ===');
        if (s.length === 0) { console.log('No streams found.'); return; }
        s.forEach((x, i) => {
          const playable = !x.behaviorHints?.notWebReady;
          console.log(`${i+1}. ${playable ? '✅' : '⚠'} ${x.name}`);
          console.log(`   URL: ${x.url.slice(0, 180)}${x.url.length > 180 ? '...' : ''}`);
        });
        const playable = s.filter(x => !x.behaviorHints?.notWebReady);
        console.log(`\nTotal: ${s.length} (${playable.length} directly playable)`);
      })
      .catch(e => { console.error('FATAL: ' + e.stack); process.exit(1); });
  }
}
