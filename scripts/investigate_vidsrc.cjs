'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const { gotScraping } = await import('got-scraping');

  // Step 1: vs_src.php
  const apiR = await gotScraping.get('https://vidsrcme.ru/vs_src.php?type=movie&id=27205', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://vidsrcme.ru/embed/movie/27205', 'X-Requested-With': 'XMLHttpRequest' },
    timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
  });
  const srcUrl = JSON.parse(apiR.body).src;
  console.log('Step 1 - src:', srcUrl.slice(0, 60));

  // Step 2: cloudorchestranova page
  const cloudR = await gotScraping.get(srcUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://vidsrcme.ru/' },
    timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
  });
  const playerUrlMatch = cloudR.body.match(/"playerUrl":"([^"]+)"/);
  const playerUrl = playerUrlMatch ? playerUrlMatch[1] : '';
  console.log('Step 2 - playerUrl:', playerUrl.slice(0, 60));

  // Step 3: Fetch the player page
  const fullPlayerUrl = 'https://cloudorchestranova.com' + playerUrl;
  const playerR = await gotScraping.get(fullPlayerUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': srcUrl },
    timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
  });
  console.log('Step 3 - Player page status:', playerR.statusCode, 'length:', playerR.body.length);

  // Look for stream URLs in the player page
  const m3u8 = playerR.body.match(/https?:\/\/[^'"]+\.(m3u8|mp4)[^'"]*/gi);
  if (m3u8) {
    console.log('FOUND STREAM URLS:', m3u8.length);
    for (const u of m3u8.slice(0, 3)) console.log('  ->', u.slice(0, 100));
  }

  // Look for CONFIG
  const configMatch = playerR.body.match(/window\.CONFIG\s*=\s*(\{[^<]+\})/);
  if (configMatch) {
    const raw = configMatch[1].replace(/\\u0026/g, '&');
    try {
      const c = JSON.parse(raw);
      console.log('CONFIG api:', c.api);
      console.log('CONFIG metaApi:', c.metaApi);

      // Try the API with stream_urls
      if (c.api) {
        const apiR2 = await gotScraping.get(c.api, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': fullPlayerUrl },
          timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
        });
        console.log('API status:', apiR2.statusCode, 'length:', apiR2.body.length);

        const data = JSON.parse(apiR2.body);
        if (Array.isArray(data?.data?.stream_urls)) {
          console.log('PLAIN stream_urls found!', data.data.stream_urls.length, 'items');
          for (const s of data.data.stream_urls.slice(0, 3)) console.log('  ->', s.url?.slice(0, 80), '|', s.quality);
        } else if (typeof data?.data?.stream_urls === 'string') {
          console.log('ENCRYPTED stream_urls (string, needs WASM decryption)');
          console.log('Encrypted string length:', data.data.stream_urls.length);
        }
      }
    } catch (e) {
      console.log('JSON parse error:', e.message);
    }
  }
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
