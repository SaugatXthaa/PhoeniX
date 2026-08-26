// Final verification test for CineSu + Fshare (the 2 working cinepro ports).
// Does NOT require TMDB API key — calls extractors directly with known URLs.

import { Fetcher } from '../src/utils/Fetcher.js';
import { CineSu } from '../src/extractor/CineSu.js';
import { Fshare } from '../src/extractor/Fshare.js';

const logger = {
  log: (...args) => console.log(...args),
  info: (...args) => console.log('[info]', ...args),
  warn: (...args) => console.log('[warn]', ...args),
  error: (...args) => console.log('[error]', ...args),
};
const fetcher = new Fetcher(logger);
const ctx = {
  hostUrl: new URL('http://localhost:7077'),
  id: 'final-test',
  ip: '127.0.0.1',
  config: { multi: 'on', en: 'on' },
};

let pass = 0, fail = 0;

// === CineSu ===
console.log('\n=== CineSu (movie 27256) ===');
const cinesu = new CineSu(fetcher, logger);
const cinesuResults = await cinesu.extract(
  ctx,
  new URL('https://cine.su/v1/stream/master/movie/27256.m3u8'),
  { sourceLabel: 'CineSu', sourceId: 'cinesu', title: 'Test Movie' },
);
if (cinesuResults.length > 0 && cinesuResults[0].format === 'hls') {
  console.log(`PASS — ${cinesuResults.length} HLS stream(s) returned`);
  console.log(`  URL: ${cinesuResults[0].url.href}`);
  pass++;
} else {
  console.log(`FAIL — expected HLS stream, got ${cinesuResults.length} results`);
  fail++;
}

// === CineSu TV ===
console.log('\n=== CineSu (tv 1399/1/1) ===');
const cinesuTvResults = await cinesu.extract(
  ctx,
  new URL('https://cine.su/v1/stream/master/tv/1399/1/1.m3u8'),
  { sourceLabel: 'CineSu', sourceId: 'cinesu', title: 'Test TV' },
);
if (cinesuTvResults.length > 0 && cinesuTvResults[0].format === 'hls') {
  console.log(`PASS — ${cinesuTvResults.length} HLS stream(s) returned`);
  pass++;
} else {
  console.log(`FAIL — expected HLS stream, got ${cinesuTvResults.length} results`);
  fail++;
}

// === Fshare ===
console.log('\n=== Fshare (tt0468569 The Dark Knight) ===');
const fshare = new Fshare(fetcher, logger);
const fshareResults = await fshare.extract(
  ctx,
  new URL('https://fsharetv.cc/movie/tt0468569'),
  { sourceLabel: 'FshareTV', sourceId: 'fshare', title: 'The Dark Knight (2008)' },
);
if (fshareResults.length > 0) {
  console.log(`PASS — ${fshareResults.length} stream(s) returned`);
  for (const r of fshareResults.slice(0, 3)) {
    console.log(`  • ${r.format} ${r.url.href.slice(0, 90)}`);
  }
  pass++;
} else {
  console.log(`FAIL — expected streams, got 0`);
  fail++;
}

console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
