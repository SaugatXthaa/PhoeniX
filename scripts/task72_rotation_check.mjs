// Task 72: rotation check — did the vidking/speedracelight ecosystem move?
import { gotScraping } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const probe = async (name, url, extra = {}) => {
  try {
    const r = await gotScraping.get(url, { headers: { 'User-Agent': UA, ...extra }, timeout: { request: 15000 }, throwHttpErrors: false, http2: false, responseType: 'buffer' });
    const head = r.body.toString().slice(0, 90).replace(/\s+/g, ' ');
    console.log(`${name}: ${r.statusCode} ${r.body.length}B | ${head}`);
    return r;
  } catch (e) { console.log(`${name}: ERR ${e.message.slice(0, 80)}`); return null; }
};

// 1. sibling TLDs
for (const d of ['vidking.to', 'vidking.cc', 'vidking.com', 'vidking.pro', 'speedracelight.net', 'speedracelight.to']) {
  try {
    const q = await fetch(`https://1.1.1.1/dns-query?name=${d}&type=A`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) }).then(r => r.json());
    const ips = (q.Answer || []).map(a => a.data).join(',');
    console.log(`DoH ${d}: ${q.Status === 0 ? `OK ${ips}` : `status=${q.Status}`}`);
  } catch (e) { console.log(`DoH ${d}: ERR`); }
}

// 2. cineby.by still iframes vidking?
const cb = await probe('cineby.by home', 'https://cineby.by/');
if (cb) {
  const h = cb.body.toString();
  const refs = [...new Set([...h.matchAll(/(vidking[a-z0-9.-]*|speedracelight[a-z0-9.-]*|[a-z0-9-]+\.(?:to|cc|app|pro|net|com))/gi)].map(m => m[0]))]
    .filter(d => !/cineby|w3|schema|google|fonts|static|cloudflare|jsdelivr|twitter|facebook|apple|z-index/.test(d)).slice(0, 20);
  console.log('cineby.by domains:', refs.join(', '));
}

// 3. videasy player config (their own service)
await probe('player.videasy.net', 'https://player.videasy.net/movie/tt15239678');
const ve = await probe('videasy.net', 'https://videasy.net/');
if (ve) {
  const h = ve.body.toString();
  const refs = [...new Set([...h.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1]))]
    .filter(d => !/videasy|w3|schema|google|fonts|cloudflare|jsdelivr|sentry/.test(d)).slice(0, 15);
  console.log('videasy.net domains:', refs.join(', '));
}

// 4. wayback: vidking.net recent snapshot state
try {
  const wb = await fetch('https://archive.org/wayback/available?url=vidking.net&timestamp=20260920', { signal: AbortSignal.timeout(15000) }).then(r => r.json());
  console.log('wayback vidking:', JSON.stringify(wb?.archived_snapshots || {}).slice(0, 200));
} catch (e) { console.log('wayback: ERR', e.message.slice(0, 60)); }
