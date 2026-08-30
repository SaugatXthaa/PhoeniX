// Debug gigle432ski fetch with got-scraping
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const { gotScraping } = await import('got-scraping');

  // Get fresh URL first
  const apiRes = await gotScraping.get('https://vidbolt.xyz/api/proxy?path=%2Fscrape%2FVidRock%2Fmovie%2F27205%3FtmdbId%3D27205%26title%3DInception%26year%3D2010', {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    timeout: { request: 10000 }, http2: true,
  });
  const data = JSON.parse(apiRes.body);
  const lyra = data.sources[0];
  const url = lyra.url;
  const headers = { ...lyra.headers, Accept: '*/*' };
  console.log('Fresh URL host:', new URL(url).hostname);
  console.log('Headers:', JSON.stringify(headers));

  // Test 1: GET without Range
  console.log('\nTest 1: GET without Range');
  try {
    const r = await gotScraping.get(url, { headers, timeout: { request: 8000 }, throwHttpErrors: false, followRedirect: true, http2: true });
    console.log('  Status:', r.statusCode, '| Body length:', r.body.length, '| Is HLS:', r.body.includes('#EXTM3U'));
    if (r.statusCode !== 200) console.log('  Body preview:', r.body.slice(0, 200));
    else console.log('  First 5 lines:', r.body.split('\n').slice(0, 5).join('\n  '));
  } catch (e) { console.log('  Error:', e.message); }

  // Test 2: GET with Range bytes=0-1023
  console.log('\nTest 2: GET with Range bytes=0-1023');
  try {
    const r = await gotScraping.get(url, { headers: { ...headers, Range: 'bytes=0-1023' }, timeout: { request: 8000 }, throwHttpErrors: false, followRedirect: true, http2: true });
    console.log('  Status:', r.statusCode, '| Body length:', r.body.length, '| Is HLS:', r.body.includes('#EXTM3U'));
  } catch (e) { console.log('  Error:', e.message); }

  // Test 3: Compare with cdn1.ngcorp.dad (which works)
  console.log('\nTest 3: Atlas stream (cdn1.ngcorp.dad)');
  try {
    const r = await gotScraping.get('https://cdn1.ngcorp.dad/e/DwYRNhFGRkRQWVI/master.m3u8', { headers, timeout: { request: 8000 }, throwHttpErrors: false, followRedirect: true, http2: true });
    console.log('  Status:', r.statusCode, '| Body length:', r.body.length, '| Is HLS:', r.body.includes('#EXTM3U'));
  } catch (e) { console.log('  Error:', e.message); }
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
