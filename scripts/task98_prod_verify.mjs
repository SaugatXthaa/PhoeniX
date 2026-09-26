#!/usr/bin/env node
// Task 98 prod verification — deploy detection + full endpoint sweep on the
// deployed commit (5eed666): manifest config, sources.json, /api/status
// monitor verdicts, /configure + /status pages, segment roundtrip on prod,
// config-filtered /stream, subtitles route, guard contract.
import zlib from 'zlib';

const BASE = 'https://ignatiusphoenix-5zrn.onrender.com';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
async function j(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, signal: AbortSignal.timeout(90_000) });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}
const encodeSegment = (config) => {
  const json = JSON.stringify(config);
  const compact = 'z' + zlib.deflateRawSync(json).toString('base64url');
  return encodeURIComponent(compact.length < encodeURIComponent(json).length ? compact : encodeURIComponent(json) && compact);
};

console.log('=== 1. deploy detection ===');
const env = await j('/debug/env');
console.log('  /debug/env:', JSON.stringify(env.body).slice(0, 200));
ok('service healthy', env.status === 200);

console.log('=== 2. manifest ===');
{
  const m = await j('/manifest.json');
  ok('manifest 200 + 78-key config', m.status === 200 && Array.isArray(m.body?.config) && m.body.config.length === 78, `${m.body?.config?.length} keys`);
  ok('subtitles resource advertised', JSON.stringify(m.body?.resources || []).includes('subtitles'));
  ok('name PhoeniX, configurable', m.body?.name === 'PhoeniX' && m.body?.behaviorHints?.configurable === true);
}

console.log('=== 3. sources.json + /api/status ===');
{
  const s = await j('/sources.json');
  ok('sources.json 67 entries with tags', s.status === 200 && s.body?.length === 67 && (s.body[0].tags?.length || 0) > 0);
  const st = await j('/api/status');
  const providers = Object.values(st.body?.providers || {});
  const up = providers.filter(p => p.status === 'up').length;
  const down = providers.filter(p => p.status === 'down').length;
  const unknown = providers.filter(p => p.status === 'unknown').length;
  ok('/api/status 67 providers', providers.length === 67, `up=${up} down=${down} unknown=${unknown} sweep=${st.body?.sweepCount}`);
  ok('monitor running', st.body?.monitoring === true);
}

console.log('=== 4. pages ===');
{
  for (const [path, min] of [['/configure', 700], ['/', 700], ['/status', 15000], ['/public/configure.css', 30000], ['/public/configure.js', 40000]]) {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(60_000) });
    const text = r.status === 200 ? await r.text() : '';
    ok(`${path} 200`, r.status === 200, `${text.length}B`);
    if (path === '/configure' || path === '/') {
      ok(`${path} no third-party references`, !/pengu|coinsend|t\.me|discord\.gg|donat/i.test(text));
    }
  }
}

console.log('=== 5. segment roundtrip on prod ===');
{
  const config = { source_4khdhub: 'on', res_2160: 'on', res_1080: 'on' };
  const json = JSON.stringify(config);
  const compact = 'z' + zlib.deflateRawSync(json).toString('base64url');
  const seg = encodeURIComponent(compact);
  const m = await j(`/${seg}/manifest.json`);
  ok('segment manifest 200', m.status === 200 && m.body?.name === 'PhoeniX');
}

console.log('=== 6. configured /stream on prod ===');
{
  const t0 = Date.now();
  const r = await j('/stream/movie/tt15239678.json?sources=4khdhub');
  ok('warmup 4khdhub (sources= contract)', r.status === 200 && (r.body?.streams?.length || 0) >= 3, `${r.body?.streams?.length} cards in ${Date.now() - t0}ms`);
  const cfg = await j('/stream/movie/tt15239678.json?sources=4khdhub&res_2160=on');
  const heights = (cfg.body?.streams || []).map(s => { const m = /\b(4K|1080p|720p|480p|360p)\b/.exec(s.name || ''); return m ? m[1] : 'unknown'; });
  ok('res_2160 filter on prod', heights.every(h => h === '4K' || h === 'unknown'), `${heights.length} cards`);
  const sub = await j('/stream/movie/tt15239678.json?sources=4khdhub&subtitles_disabled=on');
  ok('subtitles_disabled on prod', (sub.body?.streams || []).every(s => !s.subtitles?.length));
}

console.log('=== 7. subtitles route + status/data ===');
{
  const sub = await j('/subtitles/movie/tt15239678.json');
  ok('/subtitles works on prod', sub.status === 200 && Array.isArray(sub.body?.subtitles), `${sub.body?.subtitles?.length} tracks`);
  const sd = await j('/status/data');
  ok('/status/data guard contract', sd.status === 200 && sd.body?.sources?.length === 67);
}

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
