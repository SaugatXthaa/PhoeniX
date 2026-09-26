#!/usr/bin/env node
// Task 99 prod verify — 1440p option + formatter on the deployed service.
// Run: node scripts/task99_prod_verify.mjs
const BASE = 'https://ignatiusphoenix-5zrn.onrender.com';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const j = async (url, opts) => { const r = await fetch(url, opts); return { status: r.status, body: await r.json().catch(() => null) }; };
const RES_TOKEN = /\b(4K|1440p|1080p|720p|480p|360p)\b/;

console.log('── deploy + manifest ──');
{
  const { status, body } = await j(`${BASE}/manifest.json`);
  const entry = (body?.config || []).find(c => c.key === 'res_1440');
  ok('prod manifest advertises res_1440', status === 200 && entry?.title === '1440p', JSON.stringify(entry || {}));
  const ranks = (body?.config || []).filter(c => /^res_\d+$/.test(c.key)).map(c => c.key).join(',');
  ok('quality keys ordered with 1440', ranks === 'res_2160,res_1440,res_1080,res_720,res_480,res_360', ranks);
}
{
  const r = await fetch(`${BASE}/configure`);
  const html = await r.text();
  ok('configure page serves v=101 assets', r.status === 200 && /configure\.js\?v=101/.test(html) && /configure\.css\?v=101/.test(html));
}
{
  const { body } = await j(`${BASE}/sources.json`);
  const tags = Object.fromEntries((body || []).map(s => [s.id, s.tags || []]));
  ok('QHD sources tagged 1440p on prod', tags.vidlink2?.includes('1440p') && tags.stellar?.includes('1440p') && tags.videasyto?.includes('1440p'));
}

console.log('── 1440 tier on prod streams ──');
{
  const w = await j(`${BASE}/stream/movie/tt1375666.json?sources=videasyto`);
  ok('warmup videasyto on prod', w.status === 200, `${w.body?.streams?.length} cards`);
  const q = await j(`${BASE}/stream/movie/tt1375666.json?sources=videasyto&res_1440=on`);
  ok('res_1440-only whitelist strictly filters', q.status === 200 && (q.body?.streams || []).every(s => !RES_TOKEN.test(s.name || '')), `${q.body?.streams?.length} cards`);
  const ab = await j(`${BASE}/stream/movie/tt1375666.json?sources=videasyto&res_1440=off&res_1080=on&res_720=on&res_480=on&res_360=on&res_2160=on`);
  ok('explicit res_1440=off keeps other tiers', ab.status === 200 && (ab.body?.streams || []).length > 0, `${ab.body?.streams?.length} cards`);
}

console.log('── formatter honored on prod streams ──');
{
  const cfg = { source_videasyto: 'on', formatter_name: 'PX {stream.resolution::exists["[{stream.resolution}]"||"[?]"]} {stream.source}', formatter_description: 'SZ{stream.size::exists["={stream.size}"||"=none"]}' };
  const seg = 'z' + Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64url').replace(/\+/g, '-').replace(/\//g, '_');
  // deflate properly via zlib
  const zlib = await import('zlib');
  const seg2 = 'z' + zlib.deflateRawSync(JSON.stringify(cfg)).toString('base64url');
  const r = await j(`${BASE}/${encodeURIComponent(seg2)}/stream/movie/tt1375666.json`);
  const streams = r.body?.streams || [];
  const nameRe = /^PX \[(4K|1440p|1080p|720p|480p|360p|\?)\] .+/;
  const bad = streams.filter(s => !nameRe.test(s.name || '')).length;
  ok('every prod card name rendered per template', streams.length > 0 && bad === 0, `${streams.length} cards, ${bad} bad — e.g. "${streams[0]?.name}"`);
}
{
  const pr = await j(`${BASE}/api/formatter-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'N {stream.resolution}', description: 'D {stream.source}' }) });
  const qhd = (pr.body?.samples || []).find(s => s.label === '1440p QHD');
  ok('preview carries the 1440p QHD sample', pr.body?.ok && qhd?.name === 'N 1440p', qhd?.name);
}

console.log('── real-time status ──');
{
  const { status, body } = await j(`${BASE}/api/status`);
  const providers = Object.values(body?.providers || {});
  const up = providers.filter(p => p?.status === 'up').length;
  ok('/api/status live', status === 200 && providers.length >= 60, `${providers.length} providers, ${up} up`);
}

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
