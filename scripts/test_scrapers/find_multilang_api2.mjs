// Check public multi-language anime APIs that provide Japanese/English/Spanish dubs
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// 1. Check Crunchyroll public API (unauthenticated endpoints)
console.log('=== Crunchyroll API ===');
const crUrls = [
  'https://api.crunchyroll.com/content/v1/tenant_networks',
  'https://beta-api.crunchyroll.com/cms/v2/tenant/configs',
  'https://www.crunchyroll.com/content/v1/tenant_networks',
];
for (const url of crUrls) {
  try {
    const r = await gotScraping.get(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
      timeout: { request: 8000 }, throwHttpErrors: false,
    });
    console.log(`${url}: ${r.statusCode} | ${r.body?.slice(0, 200)}`);
  } catch (e) { console.log(`${url}: ERR`); }
}

// 2. Check AniWatch/HiAnime API endpoints (scraping-based)
console.log('\n=== AniWatch/HiAnime ===');
for (const domain of ['aniwatch.to', 'hianime.to', 'aniwatch.nz', 'aniwatch.dk']) {
  try {
    const r = await gotScraping.head(`https://${domain}/`, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }) },
      timeout: { request: 5000 }, throwHttpErrors: false, followRedirect: true,
    });
    console.log(`https://${domain}/: ${r.statusCode}`);
  } catch { /* skip */ }
}

// 3. Check if there's a public API for multi-language anime
// The "Consumet" API was popular but is now mostly dead. Let's check alternatives.
console.log('\n=== Alternative anime APIs ===');
const altApis = [
  'https://api.malsync.moe/',
  'https://api.aniapi.com/v1/',
  'https://graphql.anilist.co/',
  'https://api.jikan.moe/v4/',
];
for (const url of altApis) {
  try {
    const r = await gotScraping.get(url, {
      headers: { 'Accept': 'application/json' },
      timeout: { request: 5000 }, throwHttpErrors: false,
    });
    console.log(`${url}: ${r.statusCode} | ${r.body?.slice(0, 100)}`);
  } catch { /* skip */ }
}

// 4. Check if "antova" might be using the same API as our existing anime sources
// Our AniKage source uses anicore.tv API which might support multi-language
console.log('\n=== Check AniKage API for multi-language ===');
const anikageUrls = [
  'https://prox.anicore.tv/api/sources',
  'https://anikage.cc/api/sources',
  'https://prox.anicore.tv/m3u8/test',
];
for (const url of anikageUrls) {
  try {
    const r = await gotScraping.get(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
      timeout: { request: 5000 }, throwHttpErrors: false,
    });
    console.log(`${url}: ${r.statusCode} | ${r.body?.slice(0, 200)}`);
  } catch { /* skip */ }
}

// 5. Check 5Clover — PenguPlay lists "5Clover (Hidden)" which might be related
console.log('\n=== Check 5Clover ===');
const cloverUrls = [
  'https://5clover.to',
  'https://api.5clover.to',
  'https://5clover.xyz',
];
for (const url of cloverUrls) {
  try {
    const r = await gotScraping.head(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }) },
      timeout: { request: 5000 }, throwHttpErrors: false, followRedirect: true,
    });
    console.log(`${url}: ${r.statusCode}`);
  } catch { /* skip */ }
}
