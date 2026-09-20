// Task 70: diagnose 4khdhub greenmotors zero-resolve + desiflix vixsrc liveness
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const one = require('../src/nuvio/4khdhub_one.cjs');
const desiflix = require('../src/nuvio/desiflix.cjs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  // ── 1. 4khdhub.one: Inside Out 2 (1022789) vs Oppenheimer (872585)
  for (const [label, tmdb] of [['inside-out-2', 1022789], ['oppenheimer', 872585]]) {
    const t0 = Date.now();
    try {
      const streams = await one.getStreams(tmdb, 'movie', null, null, null);
      console.log(`[4kh ${label}] count=${streams.length} @${Date.now() - t0}ms`);
      for (const s of streams.slice(0, 4)) console.log(`   ${s.quality} ${s.url.slice(0, 90)}`);
    } catch (e) { console.log(`[4kh ${label}] ERROR ${e.message}`); }
  }

  // ── 2. desiflix API: what does it return today (incl. hosts)?
  const t1 = Date.now();
  try {
    const streams = await desiflix.getStreams(1022789, 'movie', null, null);
    console.log(`[desiflix] raw count=${streams?.length} @${Date.now() - t1}ms`);
    for (const s of (streams || []).slice(0, 6)) {
      let host = '?'; try { host = new URL(s.url).hostname; } catch {}
      console.log(`   host=${host} url=${String(s.url).slice(0, 100)}`);
    }
  } catch (e) { console.log(`[desiflix] ERROR ${e.message}`); }
}

main().then(() => process.exit(0)).catch(e => { console.error('FATAL', e); process.exit(1); });
