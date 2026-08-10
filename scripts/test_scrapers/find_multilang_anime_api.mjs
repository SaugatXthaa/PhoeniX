// Check if there's a public multi-language anime API (AniWatch/HiAnime/Consumet)
// that provides Japanese, English, and Spanish dubs
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// 1. Check Consumet API (popular open-source anime API)
console.log('=== Consumet API ===');
const consumetInstances = [
  'https://api.consumet.org',
  'https://consumet-api.herokuapp.com',
  'https://api.consumet.in',
];
for (const base of consumetInstances) {
  try {
    const r = await gotScraping.get(`${base}/`, {
      headers: { 'Accept': 'application/json' },
      timeout: { request: 8000 }, throwHttpErrors: false,
    });
    console.log(`${base}: ${r.statusCode} | ${r.body?.slice(0, 200)}`);
  } catch (e) { console.log(`${base}: ERR`); }
}

// 2. Check AniWatch/HiAnime API
console.log('\n=== AniWatch/HiAnime ===');
const aniwatchUrls = [
  'https://aniwatch.to',
  'https://hianime.to',
  'https://api.aniwatch.to',
];
for (const url of aniwatchUrls) {
  try {
    const r = await gotScraping.head(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }) },
      timeout: { request: 8000 }, throwHttpErrors: false, followRedirect: true,
    });
    console.log(`${url}: ${r.statusCode}${r.headers.location ? ' → ' + r.headers.location : ''}`);
  } catch (e) { console.log(`${url}: ERR`); }
}

// 3. Check Miruro — PenguPlay lists "miruro" as a source too
console.log('\n=== Miruro (listed in PenguPlay sources) ===');
const miruroUrls = [
  'https://miruro.to',
  'https://api.miruro.to',
  'https://miruro.tv',
];
for (const url of miruroUrls) {
  try {
    const r = await gotScraping.get(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
      timeout: { request: 8000 }, throwHttpErrors: false, followRedirect: true,
    });
    console.log(`${url}: ${r.statusCode} | CT: ${r.headers['content-type']} | Body len: ${r.body?.length || 0}`);
    if (r.statusCode === 200 && r.body?.includes('api')) {
      console.log(`  First 300: ${r.body.slice(0, 300)}`);
    }
  } catch (e) { console.log(`${url}: ERR`); }
}

// 4. Check if there's an API that provides multi-language anime episodes
// The key pattern: an API that takes anilist/mal ID + episode and returns
// streams with different audio languages (japanese, english, spanish)
console.log('\n=== Check anime APIs that support multi-language ===');

// Check AllManga API (used by some Stremio addons for multi-language anime)
const allMangaUrls = [
  'https://api.allmanga.to',
  'https://allmanga.to',
];
for (const url of allMangaUrls) {
  try {
    const r = await gotScraping.get(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
      timeout: { request: 8000 }, throwHttpErrors: false,
    });
    console.log(`${url}: ${r.statusCode} | CT: ${r.headers['content-type']}`);
  } catch (e) { console.log(`${url}: ERR`); }
}

// 5. Check if the pengu.uk backend itself has any public API we can probe
console.log('\n=== Probe pengu.uk backend for source list ===');
// The /stream endpoint requires auth, but maybe there's a /sources or /providers endpoint
for (const path of ['/api/sources', '/api/providers', '/api/anime', '/api/antova', '/api/source/antova']) {
  try {
    const r = await gotScraping.get(`https://pengu.uk${path}`, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
      timeout: { request: 5000 }, throwHttpErrors: false,
    });
    if (r.statusCode !== 404) {
      console.log(`${path}: ${r.statusCode} | ${r.body?.slice(0, 200)}`);
    }
  } catch { /* skip */ }
}
