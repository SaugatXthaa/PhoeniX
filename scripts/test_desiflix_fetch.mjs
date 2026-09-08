// Test different fetch methods against DesiFlix API
const url = 'https://manifest.desitvhub.eu.org/manifest.json';
const STREMIO_UA = 'Stremio/4.4.137 (Windows; x64)';

// Method 1: Native fetch
console.log('=== Method 1: Native fetch() ===');
const t1 = Date.now();
try {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  const res = await fetch(url, {
    headers: { 'User-Agent': STREMIO_UA, 'Accept': 'application/json' },
    signal: ctrl.signal,
  });
  clearTimeout(to);
  console.log(`Status: ${res.status} in ${Date.now() - t1}ms`);
  const body = await res.text();
  console.log(`Body: ${body.length} bytes`);
} catch (e) {
  console.log(`Failed after ${Date.now() - t1}ms: ${e.message}`);
}

// Method 2: got-scraping
console.log('\n=== Method 2: got-scraping ===');
const t2 = Date.now();
try {
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping(url, {
    timeout: { request: 15000 },
    throwHttpErrors: false,
    headers: { 'User-Agent': STREMIO_UA, 'Accept': 'application/json' },
  });
  console.log(`Status: ${res.statusCode} in ${Date.now() - t2}ms`);
  console.log(`Body: ${res.body.length} bytes`);
} catch (e) {
  console.log(`Failed after ${Date.now() - t2}ms: ${e.message}`);
}

// Method 3: undici (Node 18+ has it built-in)
console.log('\n=== Method 3: undici ===');
const t3 = Date.now();
try {
  const undici = await import('undici');
  const res = await undici.fetch(url, {
    headers: { 'User-Agent': STREMIO_UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  console.log(`Status: ${res.status} in ${Date.now() - t3}ms`);
  const body = await res.text();
  console.log(`Body: ${body.length} bytes`);
} catch (e) {
  console.log(`Failed after ${Date.now() - t3}ms: ${e.message}`);
}

// Method 4: curl-impersonate-style via child_process
console.log('\n=== Method 4: curl via child_process ===');
const t4 = Date.now();
try {
  const { execSync } = await import('child_process');
  const out = execSync(`curl -s -o - -w "\\n___HTTP_CODE:%{http_code}___TIME:%{time_total}" ` +
    `-H "User-Agent: ${STREMIO_UA}" -H "Accept: application/json" ` +
    `--max-time 15 "${url}"`, { encoding: 'utf8' });
  const m = out.match(/___HTTP_CODE:(\d+)___TIME:([\d.]+)/);
  if (m) {
    console.log(`Status: ${m[1]} in ${parseFloat(m[2]) * 1000}ms`);
    console.log(`Body: ${out.length - m[0].length} bytes`);
  }
} catch (e) {
  console.log(`Failed after ${Date.now() - t4}ms: ${e.message}`);
}
