// Test if DesiFlix stream URLs actually play (HEAD request)
import https from 'https';
import http from 'http';

const STREMIO_UA = 'Stremio/4.4.137 (Windows; x64)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const streams = [
  // vixsrc.to HLS — needs Referer: https://vixsrc.to/
  {
    name: 'vixsrc.to HLS (with Referer)',
    url: 'https://vixsrc.to/playlist/221474?b=1&token=5070293dbf3bfa5e81bfbab5874ad369&expires=1794085787&h=1&lang=en',
    headers: { 'User-Agent': BROWSER_UA, 'Referer': 'https://vixsrc.to/', 'Origin': 'https://vixsrc.to' },
  },
  // s1.flixsix.com MP4 — no Referer
  {
    name: 's1.flixsix.com MP4',
    url: 'https://s1.flixsix.com/movie/hollywood/2024/Dune-Part-Two(WWW.FLIXSIX.COM).mp4',
    headers: { 'User-Agent': BROWSER_UA },
  },
  // s4.flixsix.com MP4 — no Referer
  {
    name: 's4.flixsix.com MP4',
    url: 'https://s4.flixsix.com/movie/world/hindidubbed/2024/Dune-Part-Two-HINDI(WWW.FLIXSIX.COM).mp4',
    headers: { 'User-Agent': BROWSER_UA },
  },
  // manifest.desitvhub.eu.org proxy HLS
  {
    name: 'manifest proxy HLS (rpmplay)',
    url: 'http://manifest.desitvhub.eu.org/api/rpmplay/hls?u=https%3A%2F%2Fhls2.vcdnx.com%2Fhls%2Fa0EySTdBTmoxam1WOXB4RnhFSUR5dz09%2FxfgdYshjhYhj%3D!sdsHsyG',
    headers: { 'User-Agent': STREMIO_UA },
  },
  // manifest.desitvhub.eu.org proxy MP4
  {
    name: 'manifest proxy MP4',
    url: 'http://manifest.desitvhub.eu.org/api/stream?url=https%3A%2F%2F10g4.moviezzwaphd.xyz%2FTelugu%2520Dubbed%2520Movies%2520%5BHollywood%5D%2FDune%3A-Part-Two-(2024)-Telugu-Dubbed-ORG-BRRip-720p-HQ.mp4',
    headers: { 'User-Agent': STREMIO_UA },
  },
];

function head(url, headers, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const t0 = Date.now();
    const req = lib.request(url, {
      method: 'HEAD',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      // Some servers don't support HEAD — try GET with range
      if (res.statusCode === 405 || res.statusCode === 403) {
        res.resume();
        return resolve({ status: res.statusCode, ms: Date.now() - t0, headers: res.headers, note: 'HEAD not supported' });
      }
      res.resume();
      resolve({ status: res.statusCode, ms: Date.now() - t0, headers: res.headers });
    });
    req.on('error', (e) => resolve({ error: e.message, ms: Date.now() - t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout', ms: Date.now() - t0 }); });
    req.end();
  });
}

function get(url, headers, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const t0 = Date.now();
    const req = lib.request(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-1023' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 1024) req.destroy(); });
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, ms: Date.now() - t0, bodyLen: body.length, contentType: res.headers['content-type'], contentRange: res.headers['content-range'] });
      });
      res.on('error', () => resolve({ status: res.statusCode, ms: Date.now() - t0, bodyLen: chunks.length }));
    });
    req.on('error', (e) => resolve({ error: e.message, ms: Date.now() - t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout', ms: Date.now() - t0 }); });
    req.end();
  });
}

for (const s of streams) {
  console.log(`\n=== ${s.name} ===`);
  console.log(`URL: ${s.url.slice(0, 100)}`);
  console.log('HEAD:', await head(s.url, s.headers));
  console.log('GET (range 0-1023):', await get(s.url, s.headers));
}
