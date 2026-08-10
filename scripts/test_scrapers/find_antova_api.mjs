// Search for "antova" as a domain/API — maybe it's not AniLibria at all
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// Check if "antova" is a separate API service
const domains = [
  'https://antova.to',
  'https://antova.tv',
  'https://antova.cc',
  'https://antova.app',
  'https://antova.me',
  'https://antova.org',
  'https://antova.net',
  'https://antova.io',
  'https://api.antova.to',
  'https://api.antova.tv',
  'https://antova.xyz',
  'https://antova.online',
  'https://antova.site',
  'https://antova.stream',
  'https://antova.anilibria.top',
  'https://anilibria.top/api/v1/anime/antova',
];

for (const url of domains) {
  try {
    const r = await gotScraping.head(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
      timeout: { request: 5000 }, throwHttpErrors: false, followRedirect: true,
    });
    if (r.statusCode !== 0 && !r.statusCode.toString().startsWith('E')) {
      console.log(`${url}: ${r.statusCode} | CT: ${r.headers['content-type'] || 'none'}${r.headers.location ? ' | Location: ' + r.headers.location : ''}`);
    }
  } catch (e) {
    // DNS failure
    if (!e.message.includes('ENOTFOUND') && !e.message.includes('getaddrinfo')) {
      console.log(`${url}: ERR ${e.message.slice(0, 60)}`);
    }
  }
}

// Check if the old AniLibria API has a different endpoint structure
console.log('\n=== Check AniLibria API for multi-language endpoints ===');
const anilibriaEndpoints = [
  'https://anilibria.top/api/v1/anime/releases/jujutsu-kaisen',
  'https://anilibria.top/api/v2/anime/releases/jujutsu-kaisen',
  'https://anilibria.top/api/v1/anime/releases/jujutsu-kaisen/players',
  'https://anilibria.top/api/v1/anime/releases/jujutsu-kaisen/videos',
  'https://anilibria.top/api/v1/anime/releases/jujutsu-kaisen/sources',
  'https://anilibria.top/api/v1/anime/releases/jujutsu-kaisen/languages',
  'https://anilibria.top/api/v1/anime/releases/jujutsu-kaisen/dubs',
  'https://anilibria.top/api/v1/anime/releases/jujutsu-kaisen/voices',
];

for (const url of anilibriaEndpoints) {
  try {
    const r = await gotScraping.get(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
      timeout: { request: 8000 }, throwHttpErrors: false, http2: true,
    });
    if (r.statusCode === 200) {
      const body = r.body.slice(0, 300);
      console.log(`${url.split('/').pop()}: ${r.statusCode} | ${body}`);
    } else {
      console.log(`${url.split('/').pop()}: ${r.statusCode}`);
    }
  } catch (e) { console.log(`${url}: ERR`); }
}

// Check if there's a separate "antova" API that provides multi-language anime
console.log('\n=== Search GitHub for penguplay/antova source code ===');
// The PenguPlay source might be on GitHub
const githubUrls = [
  'https://api.github.com/search/repositories?q=penguplay+stremio',
  'https://api.github.com/search/code?q=antova+stremio+addon',
];
for (const url of githubUrls) {
  try {
    const r = await gotScraping.get(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: { request: 10000 }, throwHttpErrors: false,
    });
    if (r.statusCode === 200) {
      const d = JSON.parse(r.body);
      console.log(`${url}: ${d.total_count || 0} results`);
      for (const item of (d.items || []).slice(0, 3)) {
        console.log(`  - ${item.full_name || item.name}: ${item.html_url}`);
      }
    }
  } catch (e) { console.log(`${url}: ERR ${e.message.slice(0, 60)}`); }
}
