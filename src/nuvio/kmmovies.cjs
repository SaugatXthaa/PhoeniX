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
const { spawnSync } = require('child_process');

const PROVIDER_NAME = 'KMMovies';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const KMMOVIES_BASE = 'https://kmmovies.pics';
const MAGICLINKS_BASE = 'https://w3.magiclinks.lol';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function fetchBufCurl(url, { headers = {}, timeout = 30000, method = 'GET', body = null, json = false } = {}) {
  const finalHeaders = { 'User-Agent': UA, 'Accept': '*/*', ...headers };
  if (json) finalHeaders['Accept'] = 'application/json';
  const args = ['-sL', '--max-time', String(Math.floor(timeout / 1000)), '-X', method, '-w', '\n__HTTP_STATUS:%{http_code}'];
  for (const [k, v] of Object.entries(finalHeaders)) args.push('-H', `${k}: ${v}`);
  if (body) {
    args.push('-H', 'Content-Type: application/x-www-form-urlencoded');
    args.push('--data', body);
  }
  args.push(url);
  // Use spawnSync — doesn't throw on non-zero exit, captures stdout/stderr separately
  const result = spawnSync('curl', args, { maxBuffer: 50 * 1024 * 1024, timeout: timeout + 5000, encoding: 'utf8' });
  const out = result.stdout || '';
  if (out.length === 0) {
    throw new Error(`curl failed (exit ${result.status}): ${(result.stderr || '').slice(0, 80)}`);
  }
  const statusMatch = out.match(/__HTTP_STATUS:(\d+)$/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 200;
  const responseBody = statusMatch ? out.replace(/\n__HTTP_STATUS:\d+$/, '') : out;
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
    const matches = [...html.matchAll(/href="(https:\/\/kmmovies\.pics\/([^"\/]+))\/?"/g)];
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
    const picked = yearMatch || exact || results[0];
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
  const streams = [];

  // 1. WATCH ONLINE → z1.kmphotos.cv/online.php → JW Player → direct MKV on R2
  const watchOnlineMatch = html.match(/href="(https:\/\/z1\.kmphotos\.cv\/online\.php\?file=[^"]+)"/);
  if (watchOnlineMatch) {
    try {
      const playerHtml = await fetchText(watchOnlineMatch[1], { headers: { Referer: MAGICLINKS_BASE + '/' } });
      const mkvMatch = playerHtml.match(/file:\s*"([^"]+)"/);
      if (mkvMatch) streams.push({ url: mkvMatch[1], source: 'R2', playable: true });
    } catch (e) {}
  }

  // 2. Pixeldrain → pixeldrain.com/api/file/<id> → direct MKV
  const pixeldrainMatch = html.match(/href="https:\/\/pixeldrain\.com\/u\/([^"]+)"/);
  if (pixeldrainMatch) {
    streams.push({ url: `https://pixeldrain.com/api/file/${pixeldrainMatch[1]}`, source: 'Pixeldrain', playable: true });
  }

  // 3. Vikingfile → resolve via POST with Turnstile bypass attempts
  const vikingfileMatch = html.match(/href="https:\/\/vikingfile\.com\/f\/([^"]+)"/);
  if (vikingfileMatch) {
    const vikingfileUrl = `https://vik1ngfile.site/f/${vikingfileMatch[1]}`;
    const directUrl = await resolveVikingfile(vikingfileUrl);
    if (directUrl) {
      streams.push({ url: directUrl, source: 'Vikingfile', playable: true });
    }
  }

  // 4. Gofile → resolve via Gofile API (guest account → content → direct URL)
  const gofileMatch = html.match(/href="https:\/\/gofile\.io\/d\/([^"]+)"/);
  if (gofileMatch) {
    const directUrl = await resolveGofile(gofileMatch[1]);
    if (directUrl) {
      streams.push({ url: directUrl, source: 'Gofile', playable: true });
    }
  }

  // 5. Skydrop → resolve via page scraping (look for direct download URL)
  const skydropMatch = html.match(/href="(https:\/\/w1\.skydrop\.sbs\/download\.php\?id=[^"]+)"/);
  if (skydropMatch) {
    const directUrl = await resolveSkydrop(skydropMatch[1]);
    if (directUrl) {
      streams.push({ url: directUrl, source: 'Skydrop', playable: true });
    }
  }

  return streams;
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
    const r1 = fetchBufCurl(fileUrl, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Referer': fileUrl },
      body: 'cf-turnstile-response=',
      timeout: 10000,
    });
    if (r1.status === 200) {
      try {
        const json = JSON.parse(r1.body.toString('utf8'));
        if (json.link) return json.link;
      } catch {}
    }

    // Strategy 2: POST with test token via curl
    const r2 = fetchBufCurl(fileUrl, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Referer': fileUrl },
      body: 'cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX',
      timeout: 10000,
    });
    if (r2.status === 200) {
      try {
        const json = JSON.parse(r2.body.toString('utf8'));
        if (json.link) return json.link;
      } catch {}
    }

    // Strategy 3: Scrape page HTML for video source URLs
    const pageHtml = fetchBufCurl(fileUrl, { headers: { 'Accept': 'text/html' }, timeout: 10000 }).body.toString('utf8');

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
    // Try video at same path with different extensions
    const posterMatch = pageHtml.match(/poster="([^"]+\.(?:webp|jpg|png))"/);
    if (posterMatch) {
      const posterUrl = posterMatch[1];
      const baseUrl = posterUrl.replace(/\/[^/]+$/, '');
      const fileId = posterUrl.match(/\/([a-f0-9]+)\./)?.[1];
      if (fileId) {
        for (const ext of ['.mp4', '.mkv', '/index.m3u8', '_1080p.mp4', '_720p.mp4']) {
          const testUrl = baseUrl + '/' + fileId + ext;
          try {
            const testRes = fetchBufCurl(testUrl, { method: 'GET', timeout: 4000 });
            if (testRes.status === 200) return testUrl;
          } catch {}
        }
      }
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
//   2. GET api.gofile.io/contents/{fileId} → get direct download URL
async function resolveGofile(fileId) {
  try {
    // Step 1: Create guest account via curl
    const acctRes = fetchBufCurl('https://api.gofile.io/accounts', {
      method: 'POST',
      json: true,
      timeout: 15000,
    });
    if (acctRes.status !== 200) return null;
    const acctData = JSON.parse(acctRes.body.toString('utf8'));
    const token = acctData.data?.token;
    if (!token) return null;

    // Step 2: Get file content via curl
    const contentRes = fetchBufCurl(`https://api.gofile.io/contents/${fileId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      json: true,
      timeout: 10000,
    });
    if (contentRes.status !== 200) return null;
    const contentData = JSON.parse(contentRes.body.toString('utf8'));

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
// Skydrop (w1.skydrop.sbs) is a cloud download service.
// The download page may contain direct download links or redirect URLs.
//
// Strategy: Use curl to fetch the page and extract direct URLs.
async function resolveSkydrop(downloadUrl) {
  try {
    const html = fetchBufCurl(downloadUrl, {
      headers: { 'Referer': MAGICLINKS_BASE + '/', 'Accept': 'text/html' },
      timeout: 10000,
    }).body.toString('utf8');

    // Look for direct download URLs (mkv, mp4, webm)
    const dlMatches = [...html.matchAll(/href="([^"]*(?:download|dl|get)[^"]*\.(?:mkv|mp4|webm)[^"]*)"/gi)];
    if (dlMatches.length > 0) return dlMatches[0][1];

    // Look for JS redirects
    const redirectMatch = html.match(/window\.location\s*=\s*["']([^"']+)["']/);
    if (redirectMatch) return redirectMatch[1];

    // Look for meta refresh redirects
    const metaMatch = html.match(/<meta[^>]+http-equiv="refresh"[^>]+url=([^"']+)/i);
    if (metaMatch) return metaMatch[1];

    // Look for form action URLs and submit
    const formMatch = html.match(/<form[^>]+action="([^"]+)"/i);
    if (formMatch) {
      const actionUrl = formMatch[1].startsWith('http') ? formMatch[1] : new URL(formMatch[1], downloadUrl).href;
      const formRes = fetchBufCurl(actionUrl, {
        method: 'POST',
        headers: { 'Referer': downloadUrl },
        body: '',
        timeout: 8000,
      });
      if (formRes.status === 200) {
        const formHtml = formRes.body.toString('utf8');
        const directMatch = formHtml.match(/(https?:\/\/[^"'\s]+\.(?:mkv|mp4|webm)[^"'\s]*)/i);
        if (directMatch) return directMatch[1];
      }
    }

    // Look for any video/file URLs in the HTML
    const videoMatch = html.match(/(https?:\/\/[^"'\s]+\.(?:mkv|mp4|webm|m3u8)[^"'\s]*)/i);
    if (videoMatch) return videoMatch[1];

    // If the page says "Download Unavailable", the file is expired
    if (html.includes('Download Unavailable') || html.includes('couldn\'t locate your file')) {
      console.log('[KMMovies] Skydrop: file expired/unavailable');
      return null;
    }

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
  for (let i = 0; i < magiclinks.length; i += batchSize) {
    const batch = magiclinks.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(ml => resolveMagiclinks(ml.url)));
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
