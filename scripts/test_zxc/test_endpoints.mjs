// Try the /backend/tmdb/details endpoint first to see if any /backend/* endpoint works
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const BASE = 'https://player.zxcprime.xyz';
const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

async function tryGet(path, extraHeaders = {}) {
  const url = `${BASE}${path}`;
  console.log(`\nGET ${path}`);
  try {
    const res = await gotScraping.get(url, {
      headers: {
        ...hg.getHeaders({ httpVersion: '2' }),
        'Accept': 'application/json, text/plain, */*',
        'Referer': `${BASE}/embed/movie/155`,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        ...extraHeaders,
      },
      timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
    });
    console.log(`Status: ${res.statusCode}`);
    console.log(`Headers: ${JSON.stringify({ allow: res.headers.allow, 'cf-cache-status': res.headers['cf-cache-status'], vary: res.headers.vary, 'content-type': res.headers['content-type'] }, null, 2)}`);
    console.log(`Body (first 800): ${res.body.slice(0, 800)}`);
    return res;
  } catch (e) { console.log(`ERR: ${e.message}`); }
}

// Test endpoints that should be reachable
await tryGet('/backend/tmdb/details/movie/155?language=en-US');
await new Promise(r => setTimeout(r, 3000));
await tryGet('/backend/token');
await new Promise(r => setTimeout(r, 3000));
await tryGet('/backend_/embed/sentinel');
