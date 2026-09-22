// Task 79: fresh-card playprobe — generate a card, IMMEDIATELY fetch it
// through the addon /proxy (validates the browser-header injection at play time)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mod = require('/home/z/my-project/phoenix-analysis/src/nuvio/atlantic.cjs');
const PORT = process.env.PORT || 7081;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  for (let i = 0; i < 3; i++) {
    const streams = await mod.getStreams('693134', 'movie', null, null, {
      title: 'Dune: Part Two', year: '2024', imdbId: 'tt15239678',
      hostUrl: BASE, fetcher: null, ctx: null,
    });
    if (streams.length) {
      const card = streams[0].url;
      console.log('card ready, probing immediately...');
      const r = await fetch(card, { headers: { Range: 'bytes=0-2000' }, signal: AbortSignal.timeout(25000) });
      const body = await r.text();
      console.log(`FRESH playprobe: HTTP ${r.status} | startsM3U8: ${body.startsWith('#EXTM3U')} | len: ${body.length}`);
      if (body.startsWith('#EXTM3U')) console.log(body.split('\n').slice(0, 4).join(' | ').slice(0, 170));
      process.exit(0);
    }
    console.log(`attempt ${i}: 0 cards (upstream window) — retrying`);
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('NO CARDS in 3 attempts (upstream flap window)');
})();
