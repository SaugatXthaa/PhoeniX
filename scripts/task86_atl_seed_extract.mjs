// Task 86: extract current Atlantic gate seeds from live site bundle
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
import fs from 'fs';

async function get(url, opts = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://atlantic.st/', ...(opts.headers || {}) }, signal: AbortSignal.timeout(15000) });
  const body = await res.text();
  console.log(`[get] ${url} → ${res.status} len=${body.length}`);
  return body;
}

// 1. SPA shell → find the index-*.js bundle
const shell = await get('https://atlantic.st/');
const indexJs = shell.match(/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[0];
console.log('index bundle:', indexJs);
if (!indexJs) { console.log('shell head:', shell.slice(0, 500)); process.exit(1); }

// 2. index bundle → find gate js + seeds
const idx = await get('https://atlantic.st/' + indexJs);
fs.writeFileSync('/tmp/atl_index_cur.js', idx);

// gate file references
const gateRefs = [...new Set(idx.match(/aphrodite-gate-[A-Za-z0-9_-]+\.js/g) || [])];
console.log('gate bundles referenced:', gateRefs);

// inline seed candidates in index bundle: hex strings 32+ bytes near gate version strings
const versions = [...new Set(idx.match(/[ab]\.[a-z0-9]+\.v\d+/g) || [])];
console.log('gate version strings:', versions);

// 3. fetch each gate bundle
for (const g of gateRefs) {
  const body = await get('https://atlantic.st/assets/' + g.replace(/^assets\//, ''));
  fs.writeFileSync('/tmp/atl_' + g, body);
  console.log('  --- ' + g + ' head:', body.slice(0, 200).replace(/\s+/g, ' '));
  // hex seed candidates (64 hex chars)
  const hexSeeds = [...new Set(body.match(/[0-9a-f]{64}/g) || [])];
  console.log('  64-hex candidates:', hexSeeds.slice(0, 5));
  // version strings
  const vers = [...new Set(body.match(/[ab]\.[a-z0-9]+\.v\d+/g) || [])];
  console.log('  versions:', vers);
  // bootstrap URL
  const bu = body.match(/https:\/\/[a-z0-9.]+\/[a-z/]*handshake[a-z/]*/g) || body.match(/https:\/\/cdn\.[a-z0-9.]+\/[a-z/]*index[a-z/]*/g);
  console.log('  bootstrap urls:', bu);
}
