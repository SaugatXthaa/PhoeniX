const { fetchWithCurl } = await import('/home/z/my-project/ignatiusphoenix/src/utils/cf-fetch.cjs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ID = 'v2nR5TEd7BKsl-LthitvAUkabqrDwuG8Y5HHJxm9Da42dgK2ftg6VGQFkc-47ZGmMSUtLT7eGcaV0hmCfjD03VJyEF';
const url = `https://cinefreak.net/generate.php?id=${encodeURIComponent(ID)}`;
const { gotScraping } = await import('got-scraping');

// a) gotScraping
try {
  const r = await gotScraping(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, timeout: { request: 12000 }, throwHttpErrors: false });
  const hasGo = /\bgo=(\d{9,12}\.[0-9a-fA-F]{8,40})/.test(String(r.body));
  console.log(`gotScraping: ${r.statusCode} ${r.body.length}B hasGo=${hasGo} challenge=${/challenge-platform|__CF\$cv/.test(String(r.body))} securing=${/Securing/.test(String(r.body))}`);
} catch (e) { console.log('gotScraping FAIL:', e.message); }

// b) native fetch
try {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
  const body = await r.text();
  const hasGo = /\bgo=(\d{9,12}\.[0-9a-fA-F]{8,40})/.test(body);
  console.log(`native fetch: ${r.status} ${body.length}B hasGo=${hasGo} challenge=${/challenge-platform|__CF\$cv/.test(body)} securing=${/Securing/.test(body)}`);
} catch (e) { console.log('native FAIL:', e.message); }

// c) curl
try {
  const buf = await fetchWithCurl(url, { headers: { Referer: 'https://cinefreak.net/' }, maxTimeSec: 12, userAgent: UA });
  const body = buf.toString('utf8');
  const hasGo = /\bgo=(\d{9,12}\.[0-9a-fA-F]{8,40})/.test(body);
  console.log(`curl: 200 ${body.length}B hasGo=${hasGo} challenge=${/challenge-platform|__CF\$cv/.test(body)} securing=${/Securing/.test(body)}`);
} catch (e) { console.log('curl FAIL:', e.message); }
