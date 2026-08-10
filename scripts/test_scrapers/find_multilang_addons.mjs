// Search for open-source Stremio anime addons that provide multi-language (JAP/ENG/ESP) streams
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// Search GitHub for stremio anime addons with multi-language/dub support
console.log('=== GitHub search: stremio anime multi-language ===');
const queries = [
  'stremio+anime+dub+spanish',
  'stremio+addon+anime+multiaudio',
  'stremio+crunchyroll+addon',
  'penguplay+source+code',
  'antova+anime+api',
];
for (const q of queries) {
  try {
    const r = await gotScraping.get(`https://api.github.com/search/repositories?q=${q}&per_page=3`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: { request: 10000 }, throwHttpErrors: false,
    });
    if (r.statusCode === 200) {
      const d = JSON.parse(r.body);
      console.log(`\n"${q}": ${d.total_count} repos`);
      for (const item of (d.items || []).slice(0, 3)) {
        console.log(`  - ${item.full_name}: ${item.description?.slice(0, 80) || 'no desc'}`);
      }
    }
  } catch { /* skip */ }
}

// Check known anime Stremio addon URLs
console.log('\n=== Known anime Stremio addons ===');
const addons = [
  'https://anime.kitsu.tv/manifest.json',
  'https://animesuge.strem.fun/manifest.json',
  'https://crunchyroll.strem.fun/manifest.json',
  'https://animetize-api.onrender.com/manifest.json',
  'https://stremio-anime.azurewebsites.net/manifest.json',
];
for (const url of addons) {
  try {
    const r = await gotScraping.get(url, {
      headers: { 'Accept': 'application/json' },
      timeout: { request: 8000 }, throwHttpErrors: false,
    });
    if (r.statusCode === 200) {
      const d = JSON.parse(r.body);
      console.log(`${url}: ${d.name} | idPrefixes: ${d.idPrefixes?.join(',')}`);
    } else {
      console.log(`${url}: ${r.statusCode}`);
    }
  } catch (e) { console.log(`${url}: ERR`); }
}

// Check if "antova" is a known anime streaming site
console.log('\n=== Check antova domains ===');
const antovaDomains = [
  'https://antova.to/anime',
  'https://antova.to/api',
  'https://antova.to/manifest.json',
  'https://antova.stream',
  'https://antova.cc',
  'https://antova.xyz',
  'https://antova.online',
];
for (const url of antovaDomains) {
  try {
    const r = await gotScraping.head(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }) },
      timeout: { request: 5000 }, throwHttpErrors: false, followRedirect: true,
    });
    console.log(`${url}: ${r.statusCode}`);
  } catch { /* DNS fail - skip */ }
}
