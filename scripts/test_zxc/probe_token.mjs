// Check what methods are allowed on /backend/token
import { gotScraping } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Try OPTIONS to see allowed methods
const optionsRes = await gotScraping({
  method: 'OPTIONS',
  url: 'https://player.zxcprime.xyz/backend/token',
  headers: {
    'User-Agent': UA,
    'Origin': 'https://player.zxcprime.xyz',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  },
  timeout: { request: 10000 },
  throwHttpErrors: false,
});
console.log('OPTIONS /backend/token →', optionsRes.statusCode);
console.log('Headers:', JSON.stringify(optionsRes.headers, null, 2));

// Try POST with more complete browser headers
console.log('\n--- POST with full browser headers ---');
const postRes = await gotScraping.post('https://player.zxcprime.xyz/backend/token', {
  headers: {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'Origin': 'https://player.zxcprime.xyz',
    'Referer': 'https://player.zxcprime.xyz/embed/movie/155',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  },
  body: JSON.stringify({
    c81f7a42d9e253b16f408: '155',
    '9e3c7bd314af65281d0e49b73': 'de37b25f0968b6118056b2864264172d1752a0471563ef3f65f3423eaad7386e',
    '54d8b21fc9a374e60b1fd': '1786376856724',
  }),
  timeout: { request: 15000 },
  throwHttpErrors: false,
});
console.log('Status:', postRes.statusCode);
console.log('Headers:', JSON.stringify(postRes.headers, null, 2));
console.log('Body:', postRes.body.slice(0, 500));

// Try also with cf-Access-Jwt-Requirement or other CF headers
// Try GET with parameters instead of POST body (in case backend treats them the same)
console.log('\n--- GET /backend/token?id=155&... ---');
const getRes = await gotScraping.get('https://player.zxcprime.xyz/backend/token?c81f7a42d9e253b16f408=155&9e3c7bd314af65281d0e49b73=de37b25f0968b6118056b2864264172d1752a0471563ef3f65f3423eaad7386e&54d8b21fc9a374e60b1fd=1786376856724', {
  headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://player.zxcprime.xyz/embed/movie/155' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Status:', getRes.statusCode);
console.log('Body:', getRes.body.slice(0, 500));

// Maybe it's a 405 because Cloudflare thinks we're a bot. Let me try got-scraping with headerGenerator
console.log('\n--- gotScraping with useHeaderGenerator ---');
const { HeaderGenerator } = await import('header-generator');
const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });
const headers = hg.getHeaders({ httpVersion: '2' });
console.log('Generated headers:', headers);

const postRes2 = await gotScraping.post('https://player.zxcprime.xyz/backend/token', {
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    c81f7a42d9e253b16f408: '155',
    '9e3c7bd314af65281d0e49b73': 'de37b25f0968b6118056b2864264172d1752a0471563ef3f65f3423eaad7386e',
    '54d8b21fc9a374e60b1fd': '1786376856724',
  }),
  timeout: { request: 15000 }, throwHttpErrors: false,
  http2: true,
});
console.log('Status:', postRes2.statusCode);
console.log('Body:', postRes2.body.slice(0, 500));
