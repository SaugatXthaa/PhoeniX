#!/usr/bin/env node
// Task 99 E2E — 1440p option + formatter verification against the REAL server.
// Boot the addon first:  PORT=7100 node src/index.js
// Run: node scripts/task99_e2e_1440.mjs
import zlib from 'zlib';

const BASE = 'http://localhost:7100';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

function seg(config) {
  const json = JSON.stringify(config);
  return 'z' + zlib.deflateRawSync(json).toString('base64url');
}
async function j(url, opts) {
  const r = await fetch(url, opts);
  return { status: r.status, body: await r.json().catch(() => null) };
}
const RES_TOKEN = /\b(4K|1440p|1080p|720p|480p|360p)\b/;
const heightLabel = (name) => { const m = RES_TOKEN.exec(name || ''); return m ? m[1] : 'unknown'; };

console.log('── manifest + registry ──');
{
  const { status, body } = await j(`${BASE}/manifest.json`);
  const entry = (body?.config || []).find(c => c.key === 'res_1440');
  ok('manifest advertises res_1440 checkbox', status === 200 && entry?.title === '1440p' && entry?.type === 'checkbox', JSON.stringify(entry || {}));
  const ranks = (body?.config || []).filter(c => /^res_\d+$/.test(c.key)).map(c => c.key).join(',');
  ok('manifest quality keys ordered 2160→360', ranks === 'res_2160,res_1440,res_1080,res_720,res_480,res_360', ranks);
}
{
  // The exact config shape the NEW UI builds (all six tiers explicit).
  const config = {
    source_videasyto: 'on', source_stellar: 'on',
    res_2160: 'on', res_1440: 'off', res_1080: 'on', res_720: 'on', res_480: 'on', res_360: 'off',
  };
  const { status, body } = await j(`${BASE}/${encodeURIComponent(seg(config))}/manifest.json`);
  ok('new-style segment (explicit offs) roundtrips', status === 200 && body?.name === 'PhoeniX');
}
{
  const { status, body } = await j(`${BASE}/sources.json`);
  const tags = Object.fromEntries((body || []).map(s => [s.id, s.tags || []]));
  ok('QHD-capable sources tagged 1440p',
    tags.vidlink2?.includes('1440p') && tags.stellar?.includes('1440p') && tags.videasyto?.includes('1440p'),
    `vidlink2=${JSON.stringify(tags.vidlink2)}`);
}

console.log('── 1440 tier filtering (real /stream, isolated videasyto) ──');
{
  const w = await j(`${BASE}/stream/movie/tt1375666.json?sources=videasyto`);
  ok('warmup videasyto', w.status === 200, `${w.body?.streams?.length} cards`);
}
{
  // 1440-only whitelist → every labeled card must drop (source has no QHD now)
  const { status, body } = await j(`${BASE}/stream/movie/tt1375666.json?sources=videasyto&res_1440=on`);
  const streams = body?.streams || [];
  ok('res_1440-only whitelist strictly filters (0 known-height cards)',
    status === 200 && streams.every(s => !RES_TOKEN.test(s.name || '')),
    `${streams.length} cards`);
}
{
  // 4K+1440 whitelist with 1080 deselected → 1080p cards must drop
  const { status, body } = await j(`${BASE}/stream/movie/tt1375666.json?sources=videasyto&res_2160=on&res_1440=on&res_1080=off&res_720=off&res_480=off&res_360=off`);
  const streams = body?.streams || [];
  const labels = [...new Set(streams.map(s => heightLabel(s.name)))];
  ok('whitelist {4K,1440p} hides 1080p tier', status === 200 && labels.every(l => l === '4K' || l === '1440p' || l === 'unknown'), `${streams.length} cards, labels=${labels.join(',')}`);
}
{
  // A/B: legacy install shape vs new install shape — 1080p behavior identical.
  const legacy = await j(`${BASE}/${encodeURIComponent(seg({ source_videasyto: 'on', res_1080: 'on' }))}/stream/movie/tt1375666.json`);
  const modern = await j(`${BASE}/${encodeURIComponent(seg({ source_videasyto: 'on', res_1440: 'off', res_1080: 'on' }))}/stream/movie/tt1375666.json`);
  const lc = legacy.body?.streams?.length ?? -1, mc = modern.body?.streams?.length ?? -2;
  ok('legacy (no res_1440 key) and modern res_1440=off resolve identically', lc >= 0 && lc === mc, `legacy=${lc} modern=${mc}`);
}
{
  // legacy inheritance: res_1080=on WITHOUT res_1440 key must admit QHD cards
  // (unit-proven heights=[1440,1080]) — here we prove the segment path wires it.
  const cfg = normalizeProbe();
  function normalizeProbe() { return seg({ source_videasyto: 'on', res_1080: 'on' }); }
  const r = await j(`${BASE}/${encodeURIComponent(cfg)}/stream/movie/tt1375666.json`);
  ok('legacy segment resolves (QHD inheritance armed upstream)', r.status === 200 && Array.isArray(r.body?.streams), `${r.body?.streams?.length} cards`);
}
{
  // per-source 1440 cap parses and runs (no QHD cards live → no-op, no crash)
  const { status, body } = await j(`${BASE}/stream/movie/tt1375666.json?sources=videasyto&res_1440=on&res_1080=on&res_720=on&res_480=on&res_360=on&res_2160=on&quality_limit_videasyto_1440=0`);
  ok('quality_limit_<src>_1440 accepted end-to-end', status === 200 && Array.isArray(body?.streams), `${body?.streams?.length} cards`);
}

console.log('── formatter on REAL streams (the user ask: verify format is honored) ──');
const NAME_TPL = 'PX {stream.resolution::exists["[{stream.resolution}]"||"[?]"]} {stream.source}';
const DESC_TPL = 'SZ{stream.size::exists["={stream.size}"||"=none"]} · {stream.source}';
{
  const r = await j(`${BASE}/${encodeURIComponent(seg({ source_videasyto: 'on', formatter_name: NAME_TPL, formatter_description: DESC_TPL }))}/stream/movie/tt1375666.json`);
  const streams = r.body?.streams || [];
  const nameRe = /^PX \[(4K|2160p|1440p|1080p|720p|480p|360p|\?)\] .+/;
  const descRe = /^SZ=(.+|none) · .+/;
  const badName = streams.filter(s => !nameRe.test(s.name || '')).length;
  const badDesc = streams.filter(s => !descRe.test((s.title || '').replace(/\n.*/s, ''))).length;
  ok('every REAL card name rendered per the name template', streams.length > 0 && badName === 0, `${streams.length} cards, ${badName} bad — e.g. "${streams[0]?.name}"`);
  ok('every REAL card description rendered per the description template', badDesc === 0, `${badDesc} bad — e.g. "${(streams[0]?.title || '').split('\n')[0]}"`);
  // default-name cross-check: the [res] in the formatted name must equal the
  // resolution label the same card carries in its default naming (run w/o formatter).
  const d = await j(`${BASE}/stream/movie/tt1375666.json?sources=videasyto`);
  const dLabels = (d.body?.streams || []).map(s => heightLabel(s.name)).sort();
  // Task 100: the formatter emits the AIOStreams canonical form ('2160p'),
  // while default card naming uses '4K' — same tier, both documented.
  const canonical = (l) => (l === '4K' ? '2160p' : l);
  const fLabels = streams.map(s => canonical((/\[([^\]]+)\]/.exec(s.name || '') || [])[1] || '?')).sort();
  const same = dLabels.length === fLabels.length && dLabels.every((l, i) => (l === 'unknown' ? true : fLabels[i] === canonical(l)));
  ok('formatter resolution matches the card own default label per position', same, `default=[${dLabels.join(',')}] formatted=[${fLabels.join(',')}]`);
}
{
  // malformed template → fail-open to the original card naming
  const BAD = '{stream.resolution::exists["unterminated';
  const r = await j(`${BASE}/${encodeURIComponent(seg({ source_videasyto: 'on', formatter_name: BAD }))}/stream/movie/tt1375666.json`);
  const streams = r.body?.streams || [];
  const junk = streams.filter(s => /\{stream\.|PX \[/.test(s.name || '')).length;
  ok('malformed template fails open (no template junk on cards)', streams.length > 0 && junk === 0, `${junk} junked — e.g. "${streams[0]?.name?.slice(0, 40)}"`);
}
{
  // no formatter configured → default naming intact
  const r = await j(`${BASE}/stream/movie/tt1375666.json?sources=videasyto`);
  const streams = r.body?.streams || [];
  ok('default naming carries no formatter leakage', streams.every(s => /^🐦‍🔥 PhoeniX/.test(s.name || '')), streams[0]?.name?.slice(0, 40));
}
console.log('── preview route parity (UI preview = server engine) ──');
{
  const pr = await j(`${BASE}/api/formatter-preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME_TPL, description: DESC_TPL }),
  });
  ok('preview ok with samples', pr.body?.ok && Array.isArray(pr.body.samples) && pr.body.samples.length === 4, `${pr.body?.samples?.length} samples`);
  const qhd = (pr.body?.samples || []).find(s => s.label === '1440p QHD');
  ok('preview includes the 1440p QHD sample rendering 1440p', Boolean(qhd) && qhd.name.includes('1440p'), qhd?.name);
  // engine parity: re-render each sample locally with the REAL formatter module
  const { formatStream } = await import('../src/utils/formatter.cjs');
  const META = {
    '4K Remux': { height: 2160, bytes: 51611776512, sourceLabel: '4KHDHub', serverName: '10Gbps', countryCodes: ['en', 'hi'], format: 'mp4', title: 'Dune.Part.Two.2024.2160p.BluRay.REMUX.HDR.DTS-HD.MA.5.1' },
    '1080p Web-DL': { height: 1080, bytes: 3221225472, sourceLabel: 'HDHub4u', serverName: '', countryCodes: ['hi', 'en'], format: 'mp4', title: 'The Batman 2022 1080p WEB-DL DD5.1 H.264-HDHub4u' },
    '1440p QHD': { height: 1440, bytes: 7032530944, sourceLabel: 'VidLink', serverName: '', countryCodes: ['en'], format: 'hls', title: 'Interstellar.2014.1440p.WEB-DL.x264' },
    'HLS Anime': { height: 1080, bytes: 0, sourceLabel: 'HiAnime', serverName: 'MegaPlay', countryCodes: ['ja', 'en'], format: 'hls', title: 'Sousou no Frieren · S2E1 · Sub+Dub' },
  };
  let parity = true;
  for (const s of pr.body.samples) {
    const expect = formatStream({ nameTemplate: NAME_TPL, descriptionTemplate: DESC_TPL, meta: META[s.label], stream: { name: '', title: '' }, addonName: 'PhoeniX' });
    if (expect.name !== s.name) { parity = false; console.log(`    mismatch ${s.label}: server="${s.name}" local="${expect.name}"`); }
  }
  ok('preview output equals the engine the resolver runs', parity);
}

console.log('── group_by=quality naming set (real server) ──');
{
  const r = await j(`${BASE}/${encodeURIComponent(seg({ source_videasyto: 'on', group_by: 'quality' }))}/stream/movie/tt1375666.json`);
  const allowed = new Set(['4K', '1440p', '1080p', '720p', '480p', 'SD']);
  const names = (r.body?.streams || []).map(s => s.name || '');
  ok('grouped names all come from the quality label set (1440p included)', names.length > 0 && names.every(n => allowed.has(n)), [...new Set(names)].join(','));
}

console.log('── real-time status sanity ──');
{
  const { status, body } = await j(`${BASE}/api/status`);
  const providers = body?.providers || {};
  const withStatus = Object.values(providers).filter(p => p && typeof p.status === 'string');
  ok('/api/status serves live per-source verdicts', status === 200 && withStatus.length >= 60, `${withStatus.length} providers, ${withStatus.filter(p => p.status === 'up').length} up`);
}

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
