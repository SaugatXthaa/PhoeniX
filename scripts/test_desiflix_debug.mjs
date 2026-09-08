// Debug script: test why https.get times out for DesiFlix API
import https from 'https';

const STREMIO_UA = 'Stremio/4.4.137 (Windows; x64)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const urls = [
  ['manifest root',    'https://manifest.desitvhub.eu.org/manifest.json', STREMIO_UA],
  ['stream tt15239678', 'https://manifest.desitvhub.eu.org/stream/movie/tt15239678.json', STREMIO_UA],
  ['stream browser UA', 'https://manifest.desitvhub.eu.org/stream/movie/tt15239678.json', BROWSER_UA],
];

for (const [label, url, ua] of urls) {
  const t0 = Date.now();
  console.log(`\n=== ${label} ===`);
  console.log(`URL: ${url}`);
  console.log(`UA: ${ua}`);
  await new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': ua,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      agent: new https.Agent({ keepAlive: false }),
    }, (res) => {
      console.log(`Status: ${res.statusCode} after ${Date.now() - t0}ms`);
      console.log(`Headers: ${JSON.stringify(res.headers, null, 2)}`);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        console.log(`Redirect to: ${nextUrl}`);
        res.resume();
        return resolve();
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve();
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        console.log(`Body length: ${body.length} bytes in ${Date.now() - t0}ms`);
        try {
          const j = JSON.parse(body);
          if (Array.isArray(j.streams)) {
            console.log(`Streams: ${j.streams.length}`);
            j.streams.slice(0, 3).forEach((s, i) => {
              console.log(`  ${i+1}. ${s.title || s.name} → ${s.url?.slice(0, 80)}...`);
            });
          } else if (j.id) {
            console.log(`Manifest OK: id=${j.id} name=${j.name}`);
          }
        } catch (e) {
          console.log(`Parse error: ${e.message}`);
        }
        resolve();
      });
    });
    req.on('error', (e) => {
      console.log(`Error after ${Date.now() - t0}ms: ${e.message}`);
      resolve();
    });
    req.setTimeout(15000, () => {
      req.destroy(new Error(`timeout after 15000ms`));
      console.log(`TIMEOUT after ${Date.now() - t0}ms`);
      resolve();
    });
  });
}
