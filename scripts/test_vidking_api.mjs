// Standalone test of vidking's speedracelight API
// Mirrors the JS crypto extracted from vidking.net's VideoPlayer chunk

import https from 'https';
import http from 'http';

const API_BASE = 'https://api.speedracelight.com';
const TMDB_BASE = 'https://db.speedracelight.com/3';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function fetchJson(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const proto = u.protocol === 'https:' ? https : http;
    const req = proto.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'en',
        'Origin': 'https://www.vidking.net',
        'Referer': 'https://www.vidking.net/',
        ...headers,
      },
      timeout: 15000,
      family: 4,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return resolve(fetchJson(new URL(res.headers.location, urlStr).href, headers));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// === Crypto ported from vidking VideoPlayer chunk ===
const Hl = [1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580];
const _f = [1732584193,4023233417,2562383102,271733878];
const Js = 61, Sf = 8, ms = 2654435769;
const Ys = [109, 118, 109, 49]; // "mvm1"

const bf = l => (l * (l + 1) & 1) === 0;
const If = l => (l * (l + 1) & 1) === 1;

function ci(l) {
  l >>>= 0;
  l ^= l >>> 16;
  l = Math.imul(l, 2246822507) >>> 0;
  l ^= l >>> 13;
  l = Math.imul(l, 3266489909) >>> 0;
  l ^= l >>> 16;
  return l >>> 0;
}

function ps(l, o) {
  l >>>= 0;
  o &= 31;
  if (o === 0) return l >>> 0;
  return (l << o | l >>> 32 - o) >>> 0;
}

function Af(l) {
  let o = _f[0] >>> 0;
  for (let e = 0; e < l.length; e++) {
    o = ps((o ^ Math.imul(l.charCodeAt(e), Hl[e & 15])) >>> 0, 5);
  }
  return ci(o);
}

function wf(l) {
  const o = new Array(256);
  for (let i = 0; i < 256; i++) o[i] = i;
  let e = 0;
  for (let i = 0; i < 256; i++) {
    e = (e + o[i] + l.charCodeAt(i % l.length)) & 255;
    const r = o[i];
    o[i] = o[e];
    o[e] = r;
  }
  return o;
}

function vf(l) {
  let o = 2166136261;
  for (let e = 0; e < l.length; e++) {
    o = Math.imul(o ^ l.charCodeAt(e), 16777619) >>> 0;
  }
  return ci(o);
}

function Nf(l, o, e) {
  return ((l ^ o) >>> 0 | (l & o & e) >>> 0) >>> 0;
}

function Rf(l, o) {
  if (If(l.length)) return { S: wf(l), acc: Af(l) };
  const e = new Array(Js);
  let i = ci(vf(l) ^ ci(o >>> 0 ^ ms)) >>> 0;
  for (let r = 0; r < Sf; r++) {
    if (bf(r)) {
      const n = i % Js;
      i = ps(i + ms >>> 0, 7 + (r & 7));
      e[n] = (i ^ ci(i)) >>> 0;
      i = ci(i + n >>> 0);
    } else {
      e[r] = Hl[r & 15];
    }
  }
  return { S: e, acc: ci(i ^ 2779096485) >>> 0 };
}

function Cf(l, o) {
  const e = l.S;
  let i = l.acc;
  const r = i % Js;
  const n = 0 - +(r in e);
  const u = e[r] >>> 0;
  const d = Math.imul(ms, o + 1) >>> 0;
  let g = Nf(i, (u ^ d) >>> 0, n);
  g = (ps(g + i >>> 0, r & 31) ^ ps(i, Math.imul(r, 7) & 31)) >>> 0;
  i = ci(g + ms >>> 0);
  e[r] = i >>> 0;
  l.acc = i;
  return i >>> 0;
}

function xf(l, o, e) {
  const i = Rf(l, o);
  const r = new Uint8Array(e);
  let n = 0;
  for (let u = 0; u < e;) {
    const d = Cf(i, n++);
    r[u++] = d & 255;
    if (u < e) r[u++] = d >>> 8 & 255;
    if (u < e) r[u++] = d >>> 16 & 255;
    if (u < e) r[u++] = d >>> 24 & 255;
  }
  return r;
}

function Df(l) {
  const o = l.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(l.length / 4) * 4, '=');
  const e = Buffer.from(o, 'base64').toString('binary');
  const i = new Uint8Array(e.length);
  for (let r = 0; r < e.length; r++) i[r] = e.charCodeAt(r);
  return i;
}

function Pf(l, o, e) {
  const i = Df(l);
  const r = xf(o, e, i.length);
  for (let n = 0; n < i.length; n++) i[n] ^= r[n];
  for (let n = 0; n < Ys.length; n++) {
    if (i[n] !== Ys[n]) throw new Error('decrypt failed: bad seed or tampered payload');
  }
  return Buffer.from(i.subarray(Ys.length)).toString('utf8');
}

// === API flow ===
async function getSeed(tmdbId) {
  const url = `${API_BASE}/seed?mediaId=${encodeURIComponent(String(tmdbId))}`;
  const r = await fetchJson(url);
  if (r.status !== 200) throw new Error(`seed request failed: ${r.status}`);
  const j = JSON.parse(r.body);
  return j.seed;
}

async function getMetadata(type, tmdbId) {
  const url = `${TMDB_BASE}/${type}/${tmdbId}?append_to_response=external_ids`;
  const r = await fetchJson(url);
  if (r.status !== 200) throw new Error(`tmdb request failed: ${r.status}`);
  const j = JSON.parse(r.body);
  const title = type === 'movie' ? j.title : j.name;
  const year = type === 'movie'
    ? (j.release_date ? new Date(j.release_date).getFullYear() : '')
    : (j.first_air_date ? new Date(j.first_air_date).getFullYear() : '');
  const imdbId = j.external_ids?.imdb_id || '';
  return { title, year, imdbId };
}

const PROVIDERS = [
  { name: 'Yoru',   endpoint: 'cdn/sources-with-title' },
  { name: 'Cypher', endpoint: 'downloader2/sources-with-title' },
  { name: 'Breach', endpoint: 'm4uhd/sources-with-title' },
  { name: 'Neon',   endpoint: 'vsrc/sources-with-title' },
  { name: 'Vyse',   endpoint: 'hdmovie/sources-with-title' },
  { name: 'Omen',   endpoint: 'lamovie/sources-with-title' },
  { name: 'Raze',   endpoint: 'superflix/sources-with-title' },
];

async function fetchProvider(provider, meta, type, tmdbId, seasonId, episodeId) {
  const seed = await getSeed(tmdbId);
  const u = new URL(`${API_BASE}/${provider.endpoint}`);
  u.searchParams.set('title', meta.title);
  u.searchParams.set('mediaType', type);
  u.searchParams.set('year', String(meta.year));
  u.searchParams.set('episodeId', String(episodeId || 1));
  u.searchParams.set('seasonId', String(seasonId || 1));
  u.searchParams.set('tmdbId', String(tmdbId));
  u.searchParams.set('imdbId', meta.imdbId || '');
  u.searchParams.set('enc', '2');
  u.searchParams.set('seed', seed);
  u.searchParams.set('_t', String(Date.now()));

  console.log(`\n[${provider.name}] GET ${u.toString().slice(0, 120)}...`);
  const r = await fetchJson(u.toString(), {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });

  if (r.status === 401) {
    console.log(`  401 — seed rejected`);
    return null;
  }
  if (r.status !== 200) {
    console.log(`  HTTP ${r.status}`);
    return null;
  }

  let decrypted;
  try {
    decrypted = Pf(r.body, seed, parseInt(tmdbId));
  } catch (e) {
    console.log(`  decrypt failed: ${e.message}`);
    console.log('  raw body (first 200):', r.body.slice(0, 200));
    return null;
  }

  let json;
  try {
    json = JSON.parse(decrypted);
  } catch (e) {
    console.log(`  JSON parse failed: ${e.message}`);
    console.log('  decrypted (first 400):', decrypted.slice(0, 400));
    return null;
  }

  console.log(`  ✅ ${json.sources?.length || 0} sources, ${json.subtitles?.length || 0} subs`);
  if (json.sources) {
    for (const s of json.sources.slice(0, 8)) {
      console.log(`    - ${s.quality}  ${s.type || ''}  ${s.url?.slice(0, 100)}`);
    }
  }
  return json;
}

// === Test: The Dark Knight (tmdb 155, imdb tt0468569, year 2008) ===
console.log('=== Test: The Dark Knight (movie, tmdb 155) ===');
const meta = { title: 'The Dark Knight', year: 2008, imdbId: 'tt0468569' };
console.log('Meta:', meta);
for (const p of PROVIDERS) {
  try {
    await fetchProvider(p, meta, 'movie', 155, null, null);
  } catch (e) {
    console.log(`  [${p.name}] error: ${e.message}`);
  }
}

// === Test: Breaking Bad S1E1 (tmdb 1396, imdb tt0903747, year 2008) ===
console.log('\n\n=== Test: Breaking Bad S1E1 (tv, tmdb 1396) ===');
const meta2 = { title: 'Breaking Bad', year: 2008, imdbId: 'tt0903747' };
console.log('Meta:', meta2);
for (const p of PROVIDERS) {
  try {
    await fetchProvider(p, meta2, 'tv', 1396, 1, 1);
  } catch (e) {
    console.log(`  [${p.name}] error: ${e.message}`);
  }
}

// === Test: Stranger Things S1E1 (tmdb 66732, imdb tt4574334, year 2016) ===
console.log('\n\n=== Test: Stranger Things S1E1 (tv, tmdb 66732) ===');
const meta3 = { title: 'Stranger Things', year: 2016, imdbId: 'tt4574334' };
console.log('Meta:', meta3);
for (const p of PROVIDERS) {
  try {
    await fetchProvider(p, meta3, 'tv', 66732, 1, 1);
  } catch (e) {
    console.log(`  [${p.name}] error: ${e.message}`);
  }
}
