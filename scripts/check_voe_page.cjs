'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const { gotScraping } = await import('got-scraping');
  const url = 'https://voe.sx/e/tttij3lj1xlc';
  const r = await gotScraping.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Accept': 'text/html' },
    timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: true, http2: true,
  });
  console.log('Status:', r.statusCode, '| Body length:', r.body.length);
  const urls = r.body.match(/(https?:\/\/[^'\"<>\s]{10,})/g) || [];
  console.log('Found', urls.length, 'URLs in page');
  const m3u8 = r.body.match(/\.m3u8/gi) || [];
  const mp4 = r.body.match(/\.mp4/gi) || [];
  console.log('m3u8 mentions:', m3u8.length, '| mp4 mentions:', mp4.length);
  const hosts = [...new Set(urls.map(u => { try { return new URL(u).hostname; } catch { return ''; } }).filter(Boolean))];
  console.log('External hosts:', hosts.slice(0, 10).join(', '));
  console.log('\nFirst 1000 chars:', r.body.slice(0, 1000));
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
