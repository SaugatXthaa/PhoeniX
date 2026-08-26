// Debug Cinejoy TV flow — check what URL is being generated
const crypto = require('crypto');
const axios = require('axios');

const SHEGU_API = 'https://api.shegu.st';
const TMDB_KEY = '8476a7ab80ad76f0936744df0430e67c';
const BASE_KEY = Buffer.from('4e46ba8a98e390508fab1bd9207d15516bec11b8a0b21f8fc1e1e66c9e95abef', 'hex');
const MARKER = 2, W_LEN = 16, IV_LEN = 12, TAG_LEN = 16;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const client = axios.create({ timeout: 15000, headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': 'https://cinejoy.to/', 'Origin': 'https://cinejoy.to' } });

function deriveKeys(keyMaterial, purpose) {
  const info = Buffer.from(`lumen-wire-v2|${purpose}`, 'utf8');
  const d = Buffer.from(crypto.hkdfSync('sha256', BASE_KEY, keyMaterial, info, 80));
  return { gcmKey: d.slice(0, 32), maskKey: d.slice(32, 64), maskIV: d.slice(64, 80) };
}

function generateRid(payload) {
  const W = crypto.randomBytes(W_LEN);
  const d = crypto.randomBytes(IV_LEN);
  const { gcmKey, maskKey, maskIV } = deriveKeys(W, 'c2s');
  const aad = Buffer.from('lumen-wire-v2|c2s', 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', gcmKey, d);
  cipher.setAAD(aad);
  const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const inner = Buffer.concat([Buffer.from([MARKER]), d, enc, tag]);
  const ctr = crypto.createCipheriv('aes-256-ctr', maskKey, maskIV);
  const masked = Buffer.concat([ctr.update(inner), ctr.final()]);
  return Buffer.concat([W, masked]).toString('base64url');
}

function decryptBlob(blobBase64) {
  const buf = Buffer.from(blobBase64, 'base64url');
  const keyMaterial = buf.slice(0, W_LEN);
  const rest = buf.slice(W_LEN);
  const { gcmKey, maskKey, maskIV } = deriveKeys(keyMaterial, 's2c');
  const aad = Buffer.from('lumen-wire-v2|s2c', 'utf8');
  const ctr = crypto.createDecipheriv('aes-256-ctr', maskKey, maskIV);
  const inner = Buffer.concat([ctr.update(rest), ctr.final()]);
  if (inner[0] !== MARKER) throw new Error(`Invalid marker: ${inner[0]}`);
  const iv = inner.slice(1, 1 + IV_LEN);
  const ct = inner.slice(1 + IV_LEN, -TAG_LEN);
  const tag = inner.slice(-TAG_LEN);
  const dec = crypto.createDecipheriv('aes-256-gcm', gcmKey, iv);
  dec.setAAD(aad);
  dec.setAuthTag(tag);
  const decrypted = Buffer.concat([dec.update(ct), dec.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function solvePoW(challenge) {
  const { b, s, n, r, p, d } = challenge;
  const saltHash = crypto.createHash('sha256').update(`pow2-salt|${s}|${b}`).digest();
  const maxmem = 128 * r * (n + p) * 2;
  for (let i = 0; i < 1000000; i++) {
    const hash = crypto.scryptSync(`pow2|${b}|${s}|${i}`, saltHash, 32, { N: n, r, p, maxmem });
    let lz = 0;
    for (const byte of hash) {
      if (byte === 0) { lz += 8; continue; }
      lz += Math.clz32(byte) - 24;
      break;
    }
    if (lz >= d) return i;
  }
  throw new Error('PoW solver failed');
}

async function testTv(tmdbId, season, episode) {
  // Get TMDB details
  const tmdbR = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}`, {
    params: { api_key: TMDB_KEY, append_to_response: 'external_ids' },
    timeout: 8000,
  });
  const date = tmdbR.data.first_air_date || '';
  const title = tmdbR.data.name || '';
  const year = date ? String(parseInt(date.slice(0, 4))) : '';
  const imdbId = tmdbR.data.external_ids?.imdb_id || '';
  console.log(`TMDB: ${title} (${year}) imdb=${imdbId}`);

  // Get servers
  const serversR = await client.get(`${SHEGU_API}/servers`);
  const servers = serversR.data.servers || [];
  console.log(`Servers: ${servers.map(s => s.name).join(', ')}`);

  // Try different payload formats for TV
  const server = servers[0]?.name || 'Lisbon';
  const formats = [
    { name: 'tv with season/episode', payload: `/${server}/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}` },
    { name: 'tv with imdb', payload: `/${server}/tv?imdb=${imdbId}&tmdb=${tmdbId}&season=${season}&episode=${episode}` },
    { name: 'series', payload: `/${server}/series?tmdb=${tmdbId}&season=${season}&episode=${episode}` },
    { name: 'tv with title', payload: `/${server}/tv?title=${encodeURIComponent(title)}&tmdb=${tmdbId}&season=${season}&episode=${episode}` },
  ];

  for (const f of formats) {
    console.log(`\n=== ${f.name} ===`);
    console.log(`Payload: ${f.payload}`);
    try {
      const rid = generateRid(f.payload);
      const chR = await client.get(`${SHEGU_API}/challenge`, { params: { rid } });
      const challenge = chR.data;
      const c = solvePoW(challenge);
      const xAt = Buffer.from(JSON.stringify({ ...challenge, c })).toString('base64');
      const blobR = await client.get(`${SHEGU_API}/${rid}`, { headers: { 'X-At': xAt }, responseType: 'text' });
      const decrypted = decryptBlob(blobR.data);
      console.log(`Decrypted:`, JSON.stringify(decrypted).slice(0, 500));
    } catch (e) {
      console.log(`ERR: ${e.response?.status || ''} ${e.message.slice(0, 100)}`);
      if (e.response?.data) console.log(`Body: ${JSON.stringify(e.response.data).slice(0, 200)}`);
    }
  }
}

testTv(95479, 1, 1).catch(e => console.error(e.message));
