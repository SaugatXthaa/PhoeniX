// Task 68: diagnose zephyrix CDN 403 on the signed m3u8 + inspect getVideo fields
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://watchanimeworld.one';
const PLAYER = 'https://play.zephyrix.org';

async function main() {
  // fresh getVideo
  const ep = await fetch('https://watchanimeworld.one/episode/jujutsu-kaisen-1x1/', { headers: { 'User-Agent': UA } }).then(r => r.text());
  const hash = ep.match(/(?:src|data-src)="https:\/\/play\.zephyrix\.org\/video\/([a-f0-9]+)"/)[1];
  const { gotScraping } = await import('got-scraping');
  const res = await gotScraping({
    url: `${PLAYER}/player/index.php?data=${hash}&do=getVideo`, method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/', 'Origin': PLAYER, 'X-Requested-With': 'XMLHttpRequest' },
    body: `hash=${hash}&r=${encodeURIComponent(BASE + '/')}`,
    timeout: { request: 35000 }, throwHttpErrors: false,
    headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] },
  });
  const gv = JSON.parse(res.body);
  console.log('== getVideo fields ==');
  for (const [k, v] of Object.entries(gv)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    console.log(`  ${k}: ${String(s).slice(0, 180)}`);
  }

  const m3u8 = gv.securedLink || gv.videoSource;
  const variants = [
    ['no headers at all', {}],
    ['UA only', { 'User-Agent': UA }],
    ['UA+referer player', { 'User-Agent': UA, 'Referer': PLAYER + '/' }],
    ['UA+referer site', { 'User-Agent': UA, 'Referer': BASE + '/' }],
    ['UA+origin+referer player', { 'User-Agent': UA, 'Origin': PLAYER, 'Referer': PLAYER + '/' }],
    ['full browser', { 'User-Agent': UA, 'Referer': PLAYER + '/', 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Origin': PLAYER, 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' }],
  ];
  for (const [label, headers] of variants) {
    try {
      const r = await fetch(m3u8, { headers, redirect: 'follow', signal: AbortSignal.timeout(10000) });
      const ct = r.headers.get('content-type');
      console.log(`[${label}] ${r.status} ${ct}`);
      if (r.status === 200) {
        const body = await r.text();
        console.log('   first 300:', body.slice(0, 300).replace(/\n/g, ' | '));
        break;
      }
    } catch (e) { console.log(`[${label}] ERR ${String(e.message).slice(0, 80)}`); }
  }

  // also probe the videoSource .txt variant if different
  if (gv.videoSource && gv.videoSource !== m3u8) {
    try {
      const r = await fetch(gv.videoSource, { headers: { 'User-Agent': UA, Referer: PLAYER + '/' }, signal: AbortSignal.timeout(10000) });
      console.log('[videoSource txt] ' + r.status + ' ' + r.headers.get('content-type'));
    } catch (e) { console.log('[videoSource txt] ERR ' + e.message); }
  }

  // and the plain hls field
  if (gv.hls) {
    try {
      const r = await fetch(gv.hls, { headers: { 'User-Agent': UA, Referer: PLAYER + '/' }, signal: AbortSignal.timeout(10000) });
      console.log('[hls field] ' + r.status + ' ' + r.headers.get('content-type') + ' -> ' + String(gv.hls).slice(0, 100));
    } catch (e) { console.log('[hls field] ERR ' + e.message); }
  }

  // HEAD-style byte range with got-scraping chrome JA3 (maybe TLS fingerprint matters)
  try {
    const r = await gotScraping({ url: m3u8, headers: { 'User-Agent': UA, Referer: PLAYER + '/' }, timeout: { request: 12000 }, throwHttpErrors: false, headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] } });
    console.log('[got-scraping probe] ' + r.statusCode + ' ' + r.headers['content-type']);
  } catch (e) { console.log('[got-scraping probe] ERR ' + String(e.message).slice(0, 100)); }
}
main();
