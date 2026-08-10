// Test AniPriv8 streams to debug loading screen issue
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });
const API_BASE = 'https://anipriv8.online';

// Step 1: Get an AniPriv8 stream URL
async function resolveAniList(name) {
  const query = `
    query($search: String) {
      Page(page: 1, perPage: 5) {
        media(type: ANIME, search: $search, sort: [SEARCH_MATCH, POPULARITY_DESC]) {
          id idMal title { romaji english } format
        }
      }
    }`;
  const res = await gotScraping.post('https://graphql.anilist.co', {
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables: { search: name } }),
    timeout: { request: 15000 }, throwHttpErrors: false,
  });
  if (res.statusCode !== 200) return [];
  return JSON.parse(res.body)?.data?.Page?.media || [];
}

const media = await resolveAniList('Jujutsu Kaisen');
const anilistId = media[0]?.id;
console.log(`AniList ID: ${anilistId} (${media[0]?.title?.english})`);

// Test with anikuro provider
for (const provider of ['anikuro', 'animeheaven']) {
  for (const audio of ['sub', 'dub']) {
    const r = await gotScraping.get(`${API_BASE}/api/secure/pipeline/${provider}/soft-subs/${anilistId}/1/${audio}`, {
      headers: { 'Accept': 'application/json' },
      timeout: { request: 20000 }, throwHttpErrors: false,
    });
    console.log(`\n${provider}/${audio}: ${r.statusCode}`);
    if (r.statusCode === 200) {
      try {
        const d = JSON.parse(r.body);
        console.log(`  streams: ${d.streams?.length || 0}`);
        for (const s of (d.streams || []).slice(0, 2)) {
          console.log(`    quality=${s.quality} type=${s.type} url=${s.url?.slice(0, 100)}`);
        }
      } catch (e) { console.log(`  parse error: ${e.message}`); }
    }
  }
}

// Now fetch the actual stream URL (token URL)
console.log('\n=== Fetch actual stream URL ===');
const apiRes = await gotScraping.get(`${API_BASE}/api/secure/pipeline/anikuro/soft-subs/${anilistId}/1/sub`, {
  headers: { 'Accept': 'application/json' },
  timeout: { request: 20000 }, throwHttpErrors: false,
});
const data = JSON.parse(apiRes.body);
const streamUrl = data.streams?.[0]?.url;
if (!streamUrl) { console.log('No stream URL'); process.exit(0); }
const fullUrl = streamUrl.startsWith('http') ? streamUrl : `${API_BASE}${streamUrl}`;
console.log(`Full stream URL: ${fullUrl.slice(0, 200)}`);

// Try to fetch the stream URL directly
console.log('\n=== Direct fetch ===');
const directRes = await gotScraping.get(fullUrl, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
  timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
});
console.log(`Status: ${directRes.statusCode} | CT: ${directRes.headers['content-type']} | Body len: ${directRes.body?.length || 0}`);
console.log(`First 500 chars:\n${directRes.body?.slice(0, 500)}`);

// What does the body look like? Check if it's m3u8
const bodyStr = directRes.body || '';
const isM3u8 = bodyStr.trimStart().startsWith('#EXTM3U');
console.log(`\nIs HLS: ${isM3u8}`);

// Check URL pattern
const urlObj = new URL(fullUrl);
console.log(`\nURL components:`);
console.log(`  host: ${urlObj.hostname}`);
console.log(`  path: ${urlObj.pathname}`);
console.log(`  ends with .m3u8: ${urlObj.pathname.endsWith('.m3u8')}`);
console.log(`  contains /m3u8/: ${urlObj.pathname.includes('/m3u8/')}`);
console.log(`  contains /stream/: ${urlObj.pathname.includes('/stream/')}`);
