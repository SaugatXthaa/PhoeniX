// Task 68: subtitle path discovery + movie page + catalog breadth checks
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://watchanimeworld.one';
const PLAYER = 'https://play.zephyrix.org';
const H = { 'User-Agent': UA };

async function main() {
  // 1. Movie page structure (JJK 0)
  const mv = await fetch(BASE + '/movies/jujutsu-kaisen-0/', { headers: H }).then(r => r.text());
  const mvHash = mv.match(/(?:src|data-src)="(https:\/\/play\.zephyrix\.(?:top|org)\/video\/([a-f0-9]+))"/);
  const mvB64 = mv.match(/player1\.php\?data=([A-Za-z0-9+/=]+)/);
  console.log('movie page: hash =', mvHash ? mvHash[2] : 'NONE', '| langs =', mvB64 ? 'YES' : 'NO');
  if (mvB64) console.log('  langs:', Buffer.from(mvB64[1], 'base64').toString().slice(0, 220));

  // 2. zephyrix getVideo for the movie → subtitle probing on the CDN
  if (mvHash) {
    const { gotScraping } = await import('got-scraping');
    const res = await gotScraping({
      url: `${PLAYER}/player/index.php?data=${mvHash[2]}&do=getVideo`, method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + '/', 'Origin': PLAYER, 'X-Requested-With': 'XMLHttpRequest' },
      body: `hash=${mvHash[2]}&r=${encodeURIComponent(BASE + '/')}`,
      timeout: { request: 35000 }, throwHttpErrors: false,
      headerGeneratorOptions: { browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] },
    });
    const gv = JSON.parse(res.body);
    const m3u8 = gv.securedLink || gv.videoSource;
    console.log('movie m3u8:', (m3u8 || 'NONE').slice(0, 100));
    const ch = (m3u8.match(/\/cdn\/hls\/([a-f0-9]+)\//) || [])[1];
    console.log('content hash:', ch);

    // subtitle path conventions to probe
    const paths = [
      `/cdn/down/${ch}/Subtitle/subtitle_eng.srt`,
      `/cdn/down/${ch}/Subtitle/subtitle_jpn.srt`,
      `/cdn/down/${ch}/Subtitle/eng.srt`,
      `/cdn/down/${ch}/Subtitle/en.srt`,
      `/cdn/down/${ch}/subtitle_eng.srt`,
      `/cdn/hls/${ch}/Subtitle/subtitle_eng.srt`,
      `/cdn/hls/${ch}/subtitles/eng.vtt`,
      `/cdn/down/${ch}/Subtitle/subtitle.srt`,
    ];
    for (const p of paths) {
      try {
        const r = await fetch(PLAYER + p, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
        const t = r.status === 200 ? await r.text() : '';
        console.log(`  ${p.slice(ch.length * -1)}: ${r.status} ${r.headers.get('content-type')}${r.status === 200 ? ' size=' + t.length + ' head=' + t.slice(0, 40).replace(/\n/g, ' ') : ''}`);
      } catch (e) { console.log(`  ${p}: ERR`); }
    }

    // master playlist subtitle entries?
    const body = await fetch(m3u8, { headers: { 'User-Agent': UA } }).then(r => r.text());
    const subLines = body.split('\n').filter(l => /SUBTITLES|captions|TYPE=SUB/i.test(l));
    console.log('SUBTITLES entries in master:', subLines.length, subLines.slice(0, 2));
  }

  // 3. Catalog breadth: movies listing + cartoon + kdrama searches
  const moviesPage = await fetch(BASE + '/movies/', { headers: H }).then(r => r.text());
  const movieLinks = [...new Set([...moviesPage.matchAll(/href="(https:\/\/watchanimeworld\.one\/movies\/([^\/"]+)\/)"/g)].map(m => m[1]))];
  console.log('\nmovies catalog (first page):', movieLinks.length);
  movieLinks.slice(0, 10).forEach(l => console.log('  ', l.replace(BASE + '/movies/', '')));

  for (const q of ['doraemon', 'squid game', 'lookism', 'naruto', 'solo leveling']) {
    try {
      const sh = await fetch(BASE + '/?s=' + encodeURIComponent(q), { headers: H }).then(r => r.text());
      const links = [...new Set([...sh.matchAll(/href="(https:\/\/watchanimeworld\.one\/(series|movies)\/([^\/"]+)\/)"/g)].map(m => m[2] + ':' + m[3]))];
      console.log(`search "${q}":`, links.slice(0, 6).join(' | ') || 'NONE');
    } catch (e) { console.log(`search "${q}": ERR`); }
  }

  // 4. category pages (cartoons?)
  for (const c of ['cartoon', 'anime', 'kdrama', 'hindi-dubbed']) {
    try {
      const r = await fetch(`${BASE}/category/${c}/`, { headers: H });
      console.log(`category/${c}: ${r.status} size=${(await r.text()).length}`);
    } catch (e) { console.log(`category/${c}: ERR`); }
  }
}
main();
