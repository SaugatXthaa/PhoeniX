// Task 68: local provider test — series (JJK S1E1) + movie (JJK 0)
const { getStreams } = await import('../src/nuvio/animeworld.cjs');

async function run(label, args) {
  const t0 = Date.now();
  const streams = await getStreams(...args);
  console.log(`\n[${label}] ${streams.length} stream(s) in ${Date.now() - t0}ms`);
  for (const s of streams) {
    console.log('  name:', s.name, '| title:', s.title, '| quality:', s.quality);
    console.log('  url:', s.url.slice(0, 110));
    console.log('  headers:', JSON.stringify(s.headers));
    console.log('  audioTracks:', JSON.stringify(s.audioTracks), '| hasMultipleAudio:', s.hasMultipleAudio);
    console.log('  subtitles:', s.subtitles.length);
  }
  return streams;
}

// JJK S1E1 — TMDB 95479
const s = await run('JJK S1E1 (series)', [95479, 'tv', 1, 1]);
// JJK 0 movie — TMDB 810693 (correct id; 635302 is Demon Slayer Mugen Train)
await run('JJK 0 (movie)', [810693, 'movie']);

// verify the shipped URL actually returns a playlist with delivery headers
if (s.length) {
  const r = await fetch(s[0].url, { headers: s[0].headers, signal: AbortSignal.timeout(12000) });
  const body = r.ok ? await r.text() : '';
  console.log('\n[delivery check] status:', r.status, r.headers.get('content-type'),
    '| variants:', (body.match(/EXT-X-STREAM-INF/g) || []).length,
    '| audio tracks:', (body.match(/TYPE=AUDIO/g) || []).length,
    '| max res:', Math.max(0, ...[...body.matchAll(/RESOLUTION=\d+x(\d+)/g)].map(m => +m[1])));
}
