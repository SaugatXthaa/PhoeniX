// Try different URL variations and methods to find the working endpoint
import { gotScraping } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HOSTS = [
  'https://player.zxcprime.xyz',
  'https://zxcprime.icu',
  'https://zxcprime.xyz',
  'https://zxcstream.xyz',
];

const PATHS = [
  '/backend/token',
  '/backend_/token',
  '/api/backend/token',
  '/api/token',
  '/backend_/embed/sentinel',
  '/backend/embed/sentinel',
];

const body = JSON.stringify({
  c81f7a42d9e253b16f408: '155',
  '9e3c7bd314af65281d0e49b73': 'de37b25f0968b6118056b2864264172d1752a0471563ef3f65f3423eaad7386e',
  '54d8b21fc9a374e60b1fd': '1786376856724',
});

for (const host of HOSTS) {
  for (const path of PATHS) {
    const url = `${host}${path}`;
    try {
      const res = await gotScraping.post(url, {
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'Origin': host,
          'Referer': `${host}/embed/movie/155`,
        },
        body,
        timeout: { request: 10000 },
        throwHttpErrors: false,
        followRedirect: false,
      });
      console.log(`POST ${url} → ${res.statusCode} (len ${res.body.length})`);
      if (res.statusCode === 200 || (res.statusCode >= 300 && res.statusCode < 400)) {
        console.log(`  body: ${res.body.slice(0, 500)}`);
        if (res.headers.location) console.log(`  Location: ${res.headers.location}`);
      }
    } catch (e) {
      console.log(`POST ${url} → ERR: ${e.message}`);
    }
  }
  console.log('');
}

// Also try GET on sentinel directly with our generated token to see what response we get
console.log('--- Direct GET tests on sentinel with arbitrary params ---');
for (const host of HOSTS) {
  const url = `${host}/backend_/embed/sentinel?c81f7a42d9e253b16f408=155&b=movie&54d8b21fc9a374e60b1fd=1786376856724&b7f18e4c25d963a50ef81c4a9=fake&9e3c7bd314af65281d0e49b73=de37b25f0968b6118056b2864264172d1752a0471563ef3f65f3423eaad7386e`;
  try {
    const res = await gotScraping.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': `${host}/embed/movie/155`,
      },
      timeout: { request: 10000 },
      throwHttpErrors: false,
    });
    console.log(`GET ${host}/backend_/embed/sentinel?... → ${res.statusCode}`);
    if (res.statusCode !== 404) {
      console.log(`  body: ${res.body.slice(0, 500)}`);
    }
  } catch (e) {
    console.log(`GET ${host}/backend_/embed/sentinel → ERR: ${e.message}`);
  }
}
