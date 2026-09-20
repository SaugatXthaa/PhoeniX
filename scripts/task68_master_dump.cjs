// Task 68: dump full master.m3u8 (audio+subtitle tracks) + isolate the 403 trigger header
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://watchanimeworld.one';
const PLAYER = 'https://play.zephyrix.org';

async function main() {
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
  const m3u8 = gv.securedLink;
  console.log('signed m3u8:', m3u8.slice(0, 110));

  const body = await fetch(m3u8, { headers: { 'User-Agent': UA } }).then(r => r.text());
  console.log('=== FULL MASTER ===');
  console.log(body);

  // header isolation for the 403
  const combos = [
    ['UA only', { 'User-Agent': UA }],
    ['UA+Range', { 'User-Agent': UA, Range: 'bytes=0-1023' }],
    ['UA+Referer site', { 'User-Agent': UA, Referer: BASE + '/' }],
    ['UA+Referer player', { 'User-Agent': UA, Referer: PLAYER + '/' }],
    ['UA+Origin player', { 'User-Agent': UA, Origin: PLAYER }],
    ['UA+Referer+Origin+Range', { 'User-Agent': UA, Referer: PLAYER + '/', Origin: PLAYER, Range: 'bytes=0-1023' }],
  ];
  for (const [label, headers] of combos) {
    try {
      const r = await fetch(m3u8, { headers, redirect: 'follow', signal: AbortSignal.timeout(10000) });
      console.log(`[${label}] ${r.status} ${r.headers.get('content-type')}`);
    } catch (e) { console.log(`[${label}] ERR ${String(e.message).slice(0, 60)}`); }
  }

  // fetch one audio variant + video variant to verify they play and check resolution
  const lines = body.split('\n');
  const videoIdx = lines.findIndex(l => l.startsWith('#EXT-X-STREAM-INF'));
  if (videoIdx >= 0) {
    const attrs = lines[videoIdx];
    const resM = attrs.match(/RESOLUTION=(\d+x(\d+))/);
    console.log('\nvideo variant resolution:', resM ? resM[1] : '?');
    const vUrl = new URL(lines[videoIdx + 1], m3u8).href;
    const vr = await fetch(vUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    const vBody = await vr.text();
    console.log('video variant:', vr.status, vr.headers.get('content-type'), '| segments:', vBody.split('\n').filter(l => l && !l.startsWith('#')).length, '| first seg:', vBody.split('\n').filter(l => l && !l.startsWith('#'))[0]);
    const segUrl = new URL(vBody.split('\n').filter(l => l && !l.startsWith('#'))[0], vUrl).href;
    const sr = await fetch(segUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    console.log('segment probe:', sr.status, sr.headers.get('content-type'), sr.headers.get('content-length'), 'bytes');
  }
}
main();
