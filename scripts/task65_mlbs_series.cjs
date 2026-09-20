// Task 65: local trace of movielinkbd series path (GoT S1E1)
const path = require('path');
const mod = require(path.join(process.cwd(), 'src/nuvio/movielinkbd.cjs'));

(async () => {
  const t0 = Date.now();
  // GoT = tmdb 1399, S1E1
  const streams = await mod.getStreams('1399', 'tv', 1, 1, {});
  console.log('streams:', streams.length, 'in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  for (const s of streams.slice(0, 8)) {
    console.log(` - [${s.quality}] ${String(s.filename || '').slice(0, 70)}`);
    console.log(`   ${String(s.url).slice(0, 110)}`);
  }
  if (!streams.length) {
    // drill into search + page manually
    const name = 'Game of Thrones';
    const base = await mod.getBase({}, {});
    console.log('base:', base);
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
