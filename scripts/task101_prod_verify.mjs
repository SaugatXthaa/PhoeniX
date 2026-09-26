#!/usr/bin/env node
// Task 101 prod verify — wait for deploy of 4bfd7f3, then verify on prod:
//   1. /configure serves v=104 assets (deploy marker)
//   2. legacy /api/formatter-preview (no samples) still returns 4 built-ins
//   3. scenario-driven preview (samples array) renders through the prod engine
//   4. real stream: formatter config renders per template on live cards
//      (glyph + no-token-leak + count parity vs unformatted control)
//   5. malformed scenario samples fail open to the built-ins on prod

const BASE = process.env.PROD_BASE || 'https://ignatiusphoenix-5zrn.onrender.com';
const zlib = (await import('node:zlib')).default;
let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};
const seg = (c) => 'z' + zlib.deflateRawSync(JSON.stringify(c)).toString('base64url');
async function j(url, opts = {}, timeout = 90000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    return { status: r.status, text: await r.text() };
  } finally { clearTimeout(t); }
}

console.log(`prod: ${BASE}`);
console.log('── 1. waiting for v=104 deploy marker ──');
let deployed = false;
for (let i = 0; i < 40; i++) {
  const { status, text } = await j(`${BASE}/configure`, {}, 60000).catch(() => ({ status: 0, text: '' }));
  if (status === 200 && text.includes('v=104')) { deployed = true; break; }
  process.stdout.write(`  attempt ${i + 1}: status=${status} ${text.includes('v=103') ? '(still v=103)' : ''}\n`);
  await new Promise(r => setTimeout(r, 30000));
}
ok(deployed, 'configure page serves v=104 assets');

console.log('── 2. legacy preview (no samples) ──');
{
  const { status, text } = await j(`${BASE}/api/formatter-preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '{stream.resolution} · {stream.source}', description: '{stream.title}' }),
  });
  const out = JSON.parse(text);
  ok(status === 200 && out.ok === true, 'ok:true');
  ok(out.samples?.length === 4, '4 built-in samples', `got ${out.samples?.length}`);
}

console.log('── 3. scenario-driven preview on prod engine ──');
{
  const { text } = await j(`${BASE}/api/formatter-preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '{stream.resolution}{stream.proxied[" · proxied"||""]}{stream.source::exists[" · {stream.source}"||""]}',
      description: '{stream.title} · {stream.size::sbytes} · {stream.encode}',
      samples: [{
        label: 'Scenario · movie',
        meta: { height: 2160, bytes: 51611776512, title: 'Dune Part Two', sourceLabel: '4KHDHub', serverName: '10Gbps', sourceType: 'BluRay Remux', format: 'mkv', codec: 'HEVC', audioCodec: 'TrueHD', audioChannels: '5.1', hdr: 'DV,HDR10', releaseGroup: 'FRAM', countryCodes: ['en', 'hi'], subtitles: [{ lang: 'en' }] },
        stream: { name: 'x', title: 'y' },
        url: 'https://dl.example.com/Dune.mkv', requestType: 'movie', requestId: 'tt15239678',
      }],
    }),
  });
  const out = JSON.parse(text);
  const s = out.samples?.[0];
  ok(out.ok === true && s, 'scenario sample rendered');
  ok(s?.name?.includes('2160p · 4KHDHub') === true, 'name glyphs correct', JSON.stringify(s?.name));
  ok(s?.description?.includes('51.6 GB') === true, 'base-10 size on prod', JSON.stringify(s?.description));
}

console.log('── 4. malformed samples fail open on prod ──');
{
  const { text } = await j(`${BASE}/api/formatter-preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '{stream.resolution} · {stream.source}', description: '{stream.title}',
      samples: [null, 'junk', { label: 'empty' }],
    }),
  });
  const out = JSON.parse(text);
  ok(out.samples?.length === 4, 'built-ins render when nothing valid', `got ${out.samples?.length}`);
}

console.log('── 5. real stream: formatter honored on live cards ──');
{
  const src = (await import('node:fs')).readFileSync('public/configure.js', 'utf8');
  const code = src.slice(src.indexOf('const FORMATTER_PRESETS'), src.indexOf('function detectFormatterPreset'));
  const PRESETS = new Function(`${code}; return FORMATTER_PRESETS;`)();
  const cfg = Object.fromEntries([['source_videasyto', 'on'], ['source_vidlink2', 'on'], ['formatter_name', PRESETS.prism.name], ['formatter_description', PRESETS.prism.description]]);
  const t0 = Date.now();
  const fmt = await j(`${BASE}/${encodeURIComponent(seg(cfg))}/stream/movie/tt1375666.json`, {}, 120000);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const streams = JSON.parse(fmt.text).streams || [];
  const ctl = await j(`${BASE}/${encodeURIComponent(seg(Object.fromEntries([['source_videasyto', 'on'], ['source_vidlink2', 'on']])))}/stream/movie/tt1375666.json`, {}, 120000);
  const control = JSON.parse(ctl.text).streams || [];
  ok(fmt.status === 200 && streams.length > 0, `formatted stream 200 with cards (${streams.length} @${dt}s; control ${control.length})`);
  const LEAK = /\{(?:stream|addon)\./;
  const bad = streams.filter(s => !/^(🔥4K UHD|✨ QHD|🚀 FHD|💿 HD|💩 Low Quality|💩 Unknown)$/.test(s.name || ''));
  ok(bad.length === 0, `every name on-glyph (Prism)`, bad.length ? JSON.stringify(bad[0].name?.slice(0, 40)) : '');
  ok(!streams.some(s => LEAK.test(s.name || '') || LEAK.test(s.title || '')), 'zero token leakage');
  ok(control.length === 0 || control.length === streams.length, 'count parity vs control', `${streams.length} vs ${control.length}`);
}

console.log(`\nPROD VERIFY: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
