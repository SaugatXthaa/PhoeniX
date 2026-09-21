// Task 72: characterize the speedracelight outage — constant 502 or intermittent windows?
import { gotScraping } from 'got-scraping';

const H = { 'Origin': 'https://www.vidking.net', 'Referer': 'https://www.vidking.net/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124', 'Accept': 'application/json' };
const results = [];
const RUN_MS = 150000; // 2.5 min
const t0 = Date.now();
let n = 0;
while (Date.now() - t0 < RUN_MS) {
  n++;
  const s = await gotScraping.get('https://api.speedracelight.com/seed?mediaId=693134', { headers: H, timeout: { request: 12000 }, throwHttpErrors: false, http2: false }).catch(e => ({ statusCode: 0, body: e.message }));
  const code = s.statusCode;
  results.push(code);
  // also probe DNS state of vidking.net each round
  let dns = '?';
  try {
    const q = await fetch(`https://1.1.1.1/dns-query?name=www.vidking.net&type=A`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(6000) }).then(r => r.json());
    dns = q.Status === 0 ? 'OK' : `SERV(${q.Status})`;
  } catch { dns = 'doh-err'; }
  console.log(`probe ${String(n).padStart(2)} @${Math.round((Date.now() - t0) / 1000)}s: seed=${code} vidkingDNS=${dns}`);
  await new Promise(r => setTimeout(r, 15000));
}
const counts = results.reduce((a, c) => (a[c] = (a[c] || 0) + 1, a), {});
console.log('summary:', JSON.stringify(counts));
