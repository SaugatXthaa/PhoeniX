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
const { execFileSync } = require('child_process');

const PROVIDER_NAME = 'KMMovies';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const KMMOVIES_BASE = 'https://kmmovies.pics';
const MAGICLINKS_BASE = 'https://w3.magiclinks.lol';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function fetchBufCurl(url, { headers = {}, timeout = 30000 } = {}) {
  const finalHeaders = { 'User-Agent': UA, 'Accept': '*/*', ...headers };
  const args = ['-sL', '--max-time', String(Math.floor(timeout / 1000))];
  for (const [k, v] of Object.entries(finalHeaders)) args.push('-H', `${k}: ${v}`);
  args.push(url);
  try {
    const out = execFileSync('curl', args, { maxBuffer: 50 * 1024 * 1024, timeout: timeout + 5000, encoding: 'buffer' });
    return { status: 200, body: out };
  } catch (e) { throw new Error(`curl failed: ${(e.message || '').slice(0, 80)}`); }
}

function fetchBufNode(url, { headers = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': '*/*', ...headers }, timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
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

  // 3. Vikingfile → vikingfile.com/f/<id> → needs Turnstile captcha (not directly playable)
  //    But the file IS there and can be streamed once the captcha is solved.
  const vikingfileMatch = html.match(/href="https:\/\/vikingfile\.com\/f\/([^"]+)"/);
  if (vikingfileMatch) {
    streams.push({ url: `https://vik1ngfile.site/f/${vikingfileMatch[1]}`, source: 'Vikingfile', playable: false });
  }

  // 4. Gofile → gofile.io/d/<id> → needs guest token (may require premium for large files)
  const gofileMatch = html.match(/href="https:\/\/gofile\.io\/d\/([^"]+)"/);
  if (gofileMatch) {
    streams.push({ url: `https://gofile.io/d/${gofileMatch[1]}`, source: 'Gofile', playable: false });
  }

  // 5. Skydrop → w1.skydrop.sbs/download.php?id=<id> → needs JS
  const skydropMatch = html.match(/href="(https:\/\/w1\.skydrop\.sbs\/download\.php\?id=[^"]+)"/);
  if (skydropMatch) {
    streams.push({ url: skydropMatch[1], source: 'Skydrop', playable: false });
  }

  return streams;
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
