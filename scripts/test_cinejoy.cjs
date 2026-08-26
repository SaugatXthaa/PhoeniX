/**
 * Cinejoy Scraper — 100% Pure Node.js (NO Playwright)
 * ====================================================
 * Fully reverse-engineered from BToEzF61.js (Aug 2026).
 *
 * Flow:
 *   1. GET /servers → pick server
 *   2. Build payload: "/<server>/movie?imdb=<imdb>&title=<title>&tmdb=<tmdb>&year=<year>"
 *   3. Generate rid:
 *      - W = 16 random bytes, d = 12 random bytes
 *      - HKDF-SHA256(base_key, salt=W, info="lumen-wire-v2|c2s") → gcmKey(32) + maskKey(32) + maskIV(16)
 *      - AES-GCM encrypt payload → ciphertext + tag
 *      - inner = [0x02] + d(12) + ciphertext + tag(16)
 *      - AES-CTR mask inner → masked
 *      - rid = base64url(W + masked)
 *   4. GET /challenge?rid=<rid> → {v,b,s,e,n,r,p,d,k,g}
 *   5. Solve PoW (scrypt):
 *      - salt = SHA-256("pow2-salt|" + s + "|" + b)
 *      - For i=0,1,...: hash = scrypt("pow2|"+b+"|"+s+"|"+i, salt, N=4096, r=8, p=1, dkLen=32)
 *      - If leadingZeroBits(hash) >= d: c = i
 *   6. X-At = base64(JSON.stringify({...challenge, c}))
 *   7. GET /<rid> with header X-At → encrypted blob
 *   8. Decrypt blob:
 *      - keyMaterial = first 16 bytes
 *      - HKDF-SHA256(base_key, salt=keyMaterial, info="lumen-wire-v2|s2c") → same key split
 *      - AES-CTR unmask rest → inner
 *      - Check inner[0] == 0x02
 *      - AES-GCM decrypt inner[1:13] (IV) + inner[13:-16] (ct) + inner[-16:] (tag)
 *      → JSON: {"stream":[{"type":"hls","playlist":"https://help.earthcleaner.cc/playlist/<id>.m3u8"}]}
 *   9. GET playlist with header Referer: https://cinejoy.to/
 *
 * Install: npm install axios
 * Usage:  node cinejoy_scraper_clean.js movie 693134
 */

'use strict';

const axios = require('axios');
const crypto = require('crypto');

const CINEJOY_ORIGIN = 'https://cinejoy.to';
const SHEGU_API = 'https://api.shegu.st';
const EARTHCDN = 'https://help.earthcleaner.cc';
const TMDB_KEY = '8476a7ab80ad76f0936744df0430e67c';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Static HKDF base key (pc XOR wc arrays from BToEzF61.js, verified live)
const BASE_KEY = Buffer.from('4e46ba8a98e390508fab1bd9207d15516bec11b8a0b21f8fc1e1e66c9e95abef', 'hex');

// Constants (deobfuscated: T0=2, $=16, c0=12, S0=16)
const MARKER = 2;
const W_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

class CinejoyScraper {
  constructor() {
    this.client = axios.create({
      timeout: 15000,
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
                 'Referer': CINEJOY_ORIGIN + '/', 'Origin': CINEJOY_ORIGIN },
    });
  }

  async listServers() {
    const r = await this.client.get(`${SHEGU_API}/servers`);
    return (r.data || {}).servers || [];
  }

  async getSubtitles(tmdbId, isMovie = true, season = null, episode = null) {
    const params = { type: isMovie ? 'movie' : 'tv', tmdb: tmdbId };
    if (!isMovie && season != null && episode != null) { params.season = season; params.episode = episode; }
    const r = await this.client.get('https://subtitles.shegu.st/subtitles', { params });
    return (r.data || {}).subtitles || [];
  }

  async _getTmdbDetails(tmdbId, mediaType) {
    try {
      const r = await axios.get(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}`, {
        params: { api_key: TMDB_KEY, append_to_response: 'external_ids' },
        timeout: 8000,
      });
      const date = r.data.release_date || r.data.first_air_date || '';
      return {
        title: r.data.title || r.data.name || '',
        year: date ? String(parseInt(date.slice(0, 4))) : '',
        imdbId: r.data.external_ids?.imdb_id || r.data.imdb_id || '',
      };
    } catch { return { title: '', year: '', imdbId: '' }; }
  }

  /** Derive gcmKey(32) + maskKey(32) + maskIV(16) via HKDF-SHA256. */
  _deriveKeys(keyMaterial, purpose) {
    const info = Buffer.from(`lumen-wire-v2|${purpose}`, 'utf8');
    const d = Buffer.from(crypto.hkdfSync('sha256', BASE_KEY, keyMaterial, info, 80));
    return { gcmKey: d.slice(0, 32), maskKey: d.slice(32, 64), maskIV: d.slice(64, 80) };
  }

  /** Generate the rid (encrypted request ID). */
  _generateRid(payload, purpose = 'c2s') {
    const W = crypto.randomBytes(W_LEN);
    const d = crypto.randomBytes(IV_LEN);
    const { gcmKey, maskKey, maskIV } = this._deriveKeys(W, purpose);
    const aad = Buffer.from(`lumen-wire-v2|${purpose}`, 'utf8');

    // AES-GCM encrypt payload
    const cipher = crypto.createCipheriv('aes-256-gcm', gcmKey, d);
    cipher.setAAD(aad);
    const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Inner: marker + d + ciphertext + tag
    const inner = Buffer.concat([Buffer.from([MARKER]), d, enc, tag]);

    // AES-CTR mask
    const ctr = crypto.createCipheriv('aes-256-ctr', maskKey, maskIV);
    const masked = Buffer.concat([ctr.update(inner), ctr.final()]);

    return Buffer.concat([W, masked]).toString('base64url');
  }

  /** Decrypt the response blob. */
  _decryptBlob(blobBase64, purpose = 's2c') {
    const buf = Buffer.from(blobBase64, 'base64url');
    const keyMaterial = buf.slice(0, W_LEN);
    const rest = buf.slice(W_LEN);
    const { gcmKey, maskKey, maskIV } = this._deriveKeys(keyMaterial, purpose);
    const aad = Buffer.from(`lumen-wire-v2|${purpose}`, 'utf8');

    // AES-CTR unmask
    const ctr = crypto.createDecipheriv('aes-256-ctr', maskKey, maskIV);
    const inner = Buffer.concat([ctr.update(rest), ctr.final()]);

    if (inner[0] !== MARKER) throw new Error(`Invalid marker: ${inner[0]} (expected ${MARKER})`);

    const iv = inner.slice(1, 1 + IV_LEN);
    const ct = inner.slice(1 + IV_LEN, -TAG_LEN);
    const tag = inner.slice(-TAG_LEN);

    const dec = crypto.createDecipheriv('aes-256-gcm', gcmKey, iv);
    dec.setAAD(aad);
    dec.setAuthTag(tag);
    const decrypted = Buffer.concat([dec.update(ct), dec.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  }

  /** Solve the scrypt PoW challenge. */
  _solvePoW(challenge) {
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
    throw new Error('PoW solver failed after 1M iterations');
  }

  /** Build the X-At token (standard base64, NOT base64url). */
  _buildXAt(challenge, c) {
    return Buffer.from(JSON.stringify({ ...challenge, c })).toString('base64');
  }

  /** Main entry: get streams for a movie or TV episode. */
  async getMovieStreams(tmdbId, title = '') {
    return this._getStreams(tmdbId, 'movie', null, null, title);
  }

  async getSeriesStreams(tmdbId, season, episode, title = '') {
    return this._getStreams(tmdbId, 'tv', season, episode, title);
  }

  async _getStreams(tmdbId, mediaType, season, episode, title) {
    // 1. Get servers + TMDB metadata
    const [servers, tmdbInfo] = await Promise.all([
      this.listServers(),
      this._getTmdbDetails(tmdbId, mediaType),
    ]);
    const server = servers[0]?.name || 'Lisbon';

    // 2. Build payload path
    const params = new URLSearchParams();
    if (tmdbInfo.imdbId) params.set('imdb', tmdbInfo.imdbId);
    if (tmdbInfo.title) params.set('title', tmdbInfo.title);
    params.set('tmdb', String(tmdbId));
    if (tmdbInfo.year) params.set('year', tmdbInfo.year);
    if (season != null) params.set('season', String(season));
    if (episode != null) params.set('episode', String(episode));

    const sorted = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const query = sorted.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    const payload = `/${server}/${mediaType}?${query}`;

    // 3. Generate rid
    const rid = this._generateRid(payload);

    // 4. Fetch challenge
    const chR = await this.client.get(`${SHEGU_API}/challenge`, { params: { rid } });
    const challenge = chR.data;
    if (challenge.v !== 2) throw new Error(`Unsupported challenge version: ${challenge.v}`);

    // 5. Solve PoW
    const c = this._solvePoW(challenge);

    // 6. Build X-At
    const xAt = this._buildXAt(challenge, c);

    // 7. Fetch blob
    const blobR = await this.client.get(`${SHEGU_API}/${rid}`, {
      headers: { 'X-At': xAt },
      responseType: 'text',
    });

    // 8. Decrypt blob
    const decrypted = this._decryptBlob(blobR.data);
    if (!decrypted.stream?.[0]?.playlist) {
      throw new Error(`No stream URL: ${JSON.stringify(decrypted).slice(0, 300)}`);
    }

    // 9. Parse master playlist
    return this._parseMasterPlaylist(decrypted.stream[0].playlist, title || `tmdb-${tmdbId}`);
  }

  async _parseMasterPlaylist(masterUrl, title) {
    const r = await this.client.get(masterUrl, { headers: { 'Referer': CINEJOY_ORIGIN + '/' } });
    const lines = r.data.split('\n').map(l => l.trim()).filter(Boolean);
    const streams = [];
    let inf = {};
    let audioUrl = null;

    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
        const m = line.match(/URI="([^"]+)"/);
        if (m) audioUrl = m[1];
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = line.slice('#EXT-X-STREAM-INF:'.length);
        inf = {
          bandwidth: parseInt(a.match(/BANDWIDTH=(\d+)/)?.[1] || 0),
          resolution: a.match(/RESOLUTION=([^,]+)/)?.[1] || '',
          codecs: a.match(/CODECS="([^"]+)"/)?.[1] || '',
        };
      } else if (line.startsWith('http') && inf.bandwidth) {
        const h = parseInt(inf.resolution.split('x')[1] || 0);
        streams.push({
          title, quality: h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 360 ? '360p' : 'unknown',
          url: line, bandwidth: inf.bandwidth, resolution: inf.resolution,
          codecs: inf.codecs, audioUrl, source: 'cinejoy',
          behaviorHints: { notWebReady: true, headers: { Referer: CINEJOY_ORIGIN + '/' } },
        });
        inf = {};
      }
    }
    return streams;
  }
}

// CLI
if (require.main === module) (async () => {
  const s = new CinejoyScraper();
  const mediaType = process.argv[2] || 'movie';
  const tmdbId = process.argv[3] || '693134';
  const season = mediaType === 'tv' ? parseInt(process.argv[4]) : null;
  const episode = mediaType === 'tv' ? parseInt(process.argv[5]) : null;

  console.log(`Cinejoy Pure JS — ${mediaType} ${tmdbId}${season ? ' S'+season+'E'+episode : ''}`);
  const t0 = Date.now();
  try {
    const streams = mediaType === 'movie'
      ? await s.getMovieStreams(tmdbId)
      : await s.getSeriesStreams(tmdbId, season, episode);
    console.log(`\n✓ ${streams.length} stream(s) in ${Date.now()-t0}ms:`);
    for (const st of streams) {
      console.log(`  [${st.quality}] ${st.resolution} ${st.bandwidth}bps`);
      console.log(`    ${st.url}`);
    }
  } catch (e) { console.error(`✗ ${e.message}`); }
})();

module.exports = { CinejoyScraper };
