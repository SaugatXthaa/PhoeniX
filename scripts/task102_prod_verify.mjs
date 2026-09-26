#!/usr/bin/env node
// Task 102 — PROD VERIFY: Default preset = native pre-UI format + manifest
// subtitles bugfix, on the deployed Render service.
//   node scripts/task102_prod_verify.mjs [baseUrl]
import zlib from 'node:zlib';

const BASE = (process.argv[2] || 'https://ignatiusphoenix-5zrn.onrender.com').replace(/\/$/, '');
let pass = 0, fail = 0;
const ok = (c, l, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); } };
const seg = (o) => 'z' + zlib.deflateRawSync(Buffer.from(JSON.stringify(o))).toString('base64url');

// 0. wait for the v=105 deploy marker
console.log(`base: ${BASE}`);
let html = '';
for (let i = 0; i < 40; i++) {
  try {
    html = await (await fetch(`${BASE}/configure`)).text();
    if (html.includes('v=105')) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 15000));
}
ok(html.includes('v=105'), 'deployed assets at v=105', html.match(/v=10\d/)?.[0] || 'no version found');

// 1. Default preset preview → native pre-UI format through the REAL builder
const pv = await fetch(`${BASE}/api/formatter-preview`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '', description: '' }),
}).then((r) => r.json());
ok(pv.ok && pv.samples?.length === 4, 'empty templates → 4 native-format sample cards', `${pv.samples?.length}`);
ok(pv.defaults?.name === '' && pv.defaults?.description === '', 'defaults = empty preset');
const remux = pv.samples?.find((s) => s.label === '4K Remux');
ok(remux?.name?.startsWith('🐦‍🔥 PhoeniX · 4K · 4KHDHub · 10Gbps'), 'native name chain (quality · source · server)', JSON.stringify(remux?.name));
ok(remux?.description?.split('\n').length >= 3 && remux?.description?.includes('🔗'), 'native multi-line description with source-link line');
const LEAK = /\{(?:stream|addon|service|metadata|user|config|debug|tools)\./;
ok(pv.samples?.every((s) => !LEAK.test(s.name) && !LEAK.test(s.description)), 'zero token leakage on native cards');

// 2. subtitles_disabled manifest bugfix
const manOff = await fetch(`${BASE}/${seg({ subtitles_disabled: 'on' })}/manifest.json`).then((r) => r.json());
ok(!manOff.resources.some((r) => r === 'subtitles' || r?.name === 'subtitles'), 'subtitles_disabled → manifest drops subtitles resource');
const manOn = await fetch(`${BASE}/${seg({})}/manifest.json`).then((r) => r.json());
ok(manOn.resources.some((r) => r === 'subtitles' || r?.name === 'subtitles'), 'empty config manifest keeps subtitles resource');

// 3. old-default migration on prod: a real stream request with the OLD pair
//    saved in config must render NATIVE cards (not the simplified template).
const OLD = {
  name: '🐦‍🔥 PhoeniX · {stream.resolution::exists["{stream.resolution}"||""]}{stream.source::exists[" · {stream.source}"||""]}',
  description: '{stream.title}',
};
const cfg = seg({ source_4khdhub: 'on', res_2160: 'on', res_1080: 'on', max_timeout: 15, formatter_name: OLD.name, formatter_description: OLD.description });
const st = await fetch(`${BASE}/${cfg}/stream/movie/tt1375666.json`, {
  headers: { 'accept': 'application/json' },
  signal: AbortSignal.timeout(90000),
}).then((r) => r.json());
const cards = st.streams || [];
ok(cards.length > 3, 'migrated-config stream returns cards', `${cards.length}`);
ok(cards.every((c) => c.name?.startsWith('🐦‍🔥 PhoeniX') && /\n/.test(c.title || '')), 'migrated cards are NATIVE format (multi-line titles)');
ok(!cards.some((c) => c.title && c.title === 'Inception'), 'migrated cards do NOT render the old simplified bare-title description');
ok(cards.every((c) => !LEAK.test(c.name) && !LEAK.test(c.title || '')), 'migrated cards leak nothing');

// 4. default preset via saved config (no formatter keys) → identical native look
const plain = seg({ source_4khdhub: 'on', res_2160: 'on', res_1080: 'on', max_timeout: 15 });
const st2 = await fetch(`${BASE}/${plain}/stream/movie/tt1375666.json`, {
  headers: { 'accept': 'application/json' },
  signal: AbortSignal.timeout(90000),
}).then((r) => r.json());
const cards2 = st2.streams || [];
ok(cards2.length > 3, 'default-preset stream returns cards', `${cards2.length}`);
ok(cards2.every((c) => c.name?.startsWith('🐦‍🔥 PhoeniX') && /\n/.test(c.title || '')), 'default-preset cards are native format');

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
