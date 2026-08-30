// Test all CinebyRocks streams to identify which CDNs return playable URLs.
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const { Fetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'Fetcher.js')).href);
  const fetcher = new Fetcher(logger);

  const { createSources } = await import(pathToFileURL(path.join(projectRoot, 'src', 'source', 'index.js')).href);
  const sources = createSources(fetcher);
  const cbr = sources.find(s => s.id === 'cinebyrocks');

  // Get raw streams from scraper directly to inspect URLs
  const scraper = require(path.join(projectRoot, 'src', 'nuvio', 'cineby_rocks.cjs'));
  const streams = await scraper.getStreams('27205', 'movie');

  console.log('=== Testing each stream URL ===\n');
  for (const s of streams) {
    const isIframe = s.type === 'iframe';
    const label = isIframe ? 'IFRAME' : 'DIRECT';
    console.log(`[${label}] ${s.name} | q=${s.quality}`);
    console.log(`  url: ${s.url.slice(0, 130)}`);

    // Test reachability
    try {
      const headers = s.behaviorHints?.proxyHeaders?.request || { 'User-Agent': 'Mozilla/5.0' };
      const res = await fetch(s.url, {
        method: 'GET',
        headers: { ...headers, Range: 'bytes=0-3' },
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      });
      const body = res.status === 200 ? await res.text() : '';
      const isVideo = body.startsWith('#EXTM3U') || body.length === 4 || res.headers.get('content-type')?.includes('video');
      console.log(`  → HTTP ${res.status} | ${res.headers.get('content-type') || '?'} | ${isVideo ? '✅ PLAYABLE' : '❌ NOT VIDEO'}`);
    } catch (e) {
      console.log(`  → ERROR: ${e.message}`);
    }
    console.log();
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
