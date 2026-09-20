// Task 68: re-verify the animeworld flow end-to-end with the provider's own transport
// (got-scraping) — the site previously hard-CF-blocked Render; sandbox probe shows
// plain curl 200 on the .one domain now. Check every step + measure.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://watchanimeworld.one';
const PLAYER = 'https://play.zephyrix.org';

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    console.log(`[${label}] OK ${Date.now() - t0}ms`);
    return out;
  } catch (e) {
    console.log(`[${label}] FAIL ${Date.now() - t0}ms :: ${String(e && e.message || e).slice(0, 160)}`);
    return null;
  }
}

async function main() {
  // Step 1: search page with got-scraping (provider transport)
  const searchHtml = await timed('search got-scraping', async () => {
    const { gotScraping } = await import('got-scraping');
    const res = await gotScraping({
      url: BASE + '/?s=jujutsu', headers: { 'User-Agent': UA }, timeout: { request: 35000 },
      throwHttpErrors: false, http2: true,
      headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] },
    });
    if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode);
    return res.body;
  });
  if (!searchHtml) return;
  const seriesLink = searchHtml.match(/href="(https:\/\/watchanimeworld\.one\/series\/([^\/"]+)\/)"/);
  console.log('series link:', seriesLink ? seriesLink[1] : 'NONE');

  // Step 2: series page → post id
  const seriesHtml = await timed('series page', () => fetch(seriesLink[1], { headers: { 'User-Agent': UA } }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }));
  const pid = seriesHtml && (seriesHtml.match(/postid-(\d+)/) || seriesHtml.match(/data-post="(\d+)"/));
  console.log('post id:', pid ? pid[1] : 'NONE', '| seasons:', [...new Set((seriesHtml || '').matchAll(/data-post="\d+" data-season="(\d+)"/g))].map(m => m[1]).join(','));

  // Step 3: season ajax → episode link
  const epHtml = await timed('season ajax', () => fetch(`${BASE}/wp-admin/admin-ajax.php?action=action_select_season&season=1&post=${pid[1]}`, { headers: { 'User-Agent': UA, 'Referer': seriesLink[1] } }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }));
  const epLinks = epHtml ? [...epHtml.matchAll(/href="(https:\/\/watchanimeworld\.one\/episode\/([^"]+))"/g)].map(m => m[1]) : [];
  const ep1 = epLinks.find(u => u.includes('1x1/')) || null;
  console.log('episodes found:', epLinks.length, '| S1E1:', ep1);

  // Step 4: episode page → zephyrix hash + player1 base64 languages
  const epData = await timed('episode page', () => fetch(ep1, { headers: { 'User-Agent': UA } }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }));
  if (!epData) return;
  const iframeM = epData.match(/(?:src|data-src)="(https:\/\/play\.zephyrix\.(?:top|org)\/video\/([a-f0-9]+))"/);
  const b64M = epData.match(/player1\.php\?data=([A-Za-z0-9+/=]+)/);
  console.log('zephyrix hash:', iframeM ? iframeM[2] : 'NONE', '| player1 langs:', b64M ? Buffer.from(b64M[1], 'base64').toString().slice(0, 200) : 'NONE');

  // Step 5: getVideo POST (the real stream source)
  const gv = await timed('getVideo', async () => {
    const { gotScraping } = await import('got-scraping');
    const res = await gotScraping({
      url: `${PLAYER}/player/index.php?data=${iframeM[2]}&do=getVideo`, method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/', 'Origin': PLAYER, 'X-Requested-With': 'XMLHttpRequest' },
      body: `hash=${iframeM[2]}&r=${encodeURIComponent(BASE + '/')}`,
      timeout: { request: 35000 }, throwHttpErrors: false,
      headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] },
    });
    if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode + ' body: ' + String(res.body).slice(0, 100));
    return JSON.parse(res.body);
  });
  if (!gv) return;
  const m3u8 = gv.securedLink || gv.videoSource;
  console.log('getVideo keys:', Object.keys(gv).join(','), '| m3u8:', (m3u8 || 'NONE').slice(0, 120));
  if (!m3u8) return;

  // Step 6: liveness probe of final m3u8 (as the provider does)
  const alive = await timed('m3u8 probe', async () => {
    const res = await fetch(m3u8, { headers: { 'Referer': PLAYER + '/', 'User-Agent': UA, Range: 'bytes=0-1023' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    return { status: res.status, ct: res.headers.get('content-type'), html: /text\/html/i.test(res.headers.get('content-type') || '') };
  });
  console.log('probe:', JSON.stringify(alive));
  if (alive && alive.status === 200) {
    const body = await fetch(m3u8, { headers: { Referer: PLAYER + '/', 'User-Agent': UA } }).then(r => r.text());
    const variants = body.split('\n').filter(l => l && !l.startsWith('#'));
    console.log('master lines:', body.split('\n').filter(l => l.startsWith('#EXT-X-STREAM-INF')).length, '| first variant:', variants[0]);
    // audio tracks inside master?
    const audioGroups = [...body.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/g)].map(m => m[0].slice(0, 140));
    console.log('audio tracks:', audioGroups.length);
    audioGroups.slice(0, 6).forEach(a => console.log('  ', a));
  }

  // Step 7: subtitle URL pattern from the provider
  const contentHashM = m3u8.match(/\/cdn\/hls\/([a-f0-9]+)\//);
  console.log('content hash:', contentHashM ? contentHashM[1] : 'NONE');
  if (contentHashM) {
    const sub = await timed('subtitle probe', () => fetch(`${PLAYER}/cdn/down/${contentHashM[1]}/Subtitle/subtitle_eng.srt`, { headers: { Referer: PLAYER + '/', 'User-Agent': UA }, signal: AbortSignal.timeout(12000) }).then(async r => ({ status: r.status, ct: r.headers.get('content-type'), size: (await r.text()).length })));
    console.log('subtitle:', JSON.stringify(sub));
  }
}
main();
