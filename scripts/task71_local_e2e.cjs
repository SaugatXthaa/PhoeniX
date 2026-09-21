// Task 71: local E2E — verify the 4 fixes + no regression on key sources
const { spawn } = require('child_process');
const child = spawn('node', ['src/index.js'], { env: { ...process.env, PORT: '4676', STREAM_CLIENT_BUDGET_MS: '40000' }, stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', d => process.stderr.write(d));
const BASE = 'http://127.0.0.1:4676';
(async () => {
  for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) }); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
  const jget = async (u, t = 70000) => (await fetch(u, { signal: AbortSignal.timeout(t) })).json();

  // 1. Atlantic — artemis flat fallback + aphrodite unsigned fallback (Dune 2)
  const atl = await jget(`${BASE}/debug/source/atlantic?type=movie&id=tmdb:693134`);
  console.log(`[1] atlantic Dune2: count=${atl.count} (expect >=1: artemis flat)`);
  (atl.logs || []).filter(l => /artemis|aphrodite|gate|media-playlist|getStreams done/.test(l)).slice(0, 8).forEach(l => console.log('    |', l.slice(0, 130)));

  // 2. HindMoviez — ip-class 401 keep (Dune 2)
  const hmz = await jget(`${BASE}/debug/source/hindmoviez?type=movie&id=tmdb:693134`);
  console.log(`[2] hindmoviez Dune2: count=${hmz.count} (expect >=1)`);
  (hmz.logs || []).filter(l => /liveness|Returning/.test(l)).slice(0, 5).forEach(l => console.log('    |', l.slice(0, 130)));

  // 3. Raflix — parallel stages (isolated timing + count)
  const rf = await jget(`${BASE}/debug/source/raflix?type=movie&id=tmdb:693134`);
  console.log(`[3] raflix Dune2: count=${rf.count} in ${rf.durationMs}ms (expect >0, <20s)`);

  // 4. ZXCStream — route burat (sentinel upstream 502 today — expect honest zero w/ burat 200 in logs)
  const zxc = await jget(`${BASE}/debug/source/zxcstream?type=movie&id=tmdb:693134`);
  console.log(`[4] zxcstream Dune2: count=${zxc.count} (sentinel upstream-down today → 0 ok)`);
  (zxc.logs || []).slice(0, 6).forEach(l => console.log('    |', l.slice(0, 130)));

  // 5. No-regression: key sources quick check
  for (const [id, type, rid] of [['4khdhub','movie','tmdb:693134'], ['peckle','movie','tmdb:693134'], ['uhdmovies','movie','tmdb:693134'], ['cinewave','movie','tmdb:693134']]) {
    const r = await jget(`${BASE}/debug/source/${id}?type=${type}&id=${rid}`);
    console.log(`[5] ${id}: count=${r.count}`);
  }

  // 6. Merged sanity (cache warm from above probes)
  const st = await jget(`${BASE}/stream/movie/tmdb:693134.json`, 120000);
  const streams = st.streams || [];
  const fourK = streams.filter(s => /· 4K/.test(s.name || '')).length;
  const html = streams.filter(s => /\.(html?)($|\?)/i.test(s.url || '')).length;
  const subs = streams.filter(s => (s.subtitles || []).length > 0).length;
  const atlCards = streams.filter(s => /Atlantic/.test(s.name || '')).length;
  const hmzCards = streams.filter(s => /HindMoviez/i.test(s.name || '')).length;
  console.log(`[6] merged Dune2: ${streams.length} cards | 4K=${fourK} | html=${html} | subs ${subs}/${streams.length} | atlantic=${atlCards} | hindmoviez=${hmzCards}`);

  child.kill('SIGKILL');
  process.exit(0);
})().catch(e => { console.error('FATAL', e); child.kill('SIGKILL'); process.exit(1); });
