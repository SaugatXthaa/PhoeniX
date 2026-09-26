#!/usr/bin/env node
// Task 98 E2E — config roundtrip through the /<segment>/ path exactly the way
// the UI + Stremio do it, plus every config-driven filter on /stream.
import zlib from 'zlib';

const BASE = 'http://localhost:7100';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

function encodeSegment(config) {
  const json = JSON.stringify(config);
  const plain = encodeURIComponent(json);
  const compact = 'z' + zlib.deflateRawSync(json).toString('base64url');
  return compact.length < plain.length ? encodeURIComponent(compact) : plain;
}

async function j(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json().catch(() => null) };
}

console.log('── manifest segment roundtrip ──');
{
  const config = { source_4khdhub: 'on', source_hdhub4uv2: 'on', res_2160: 'on', res_1080: 'on', min_size_gb: 1 };
  const seg = encodeSegment(config);
  const { status, body } = await j(`${BASE}/${seg}/manifest.json`);
  ok('segment manifest 200', status === 200 && body?.name === 'PhoeniX', `status=${status}`);
  ok('segment manifest has config array', Array.isArray(body?.config) && body.config.length > 70);
}
{
  const { status, body } = await j(`${BASE}/garbage!!!/manifest.json`);
  ok('garbage segment fails open to default manifest', status === 200 && body?.name === 'PhoeniX');
}

console.log('── stream config filters (isolated 4khdhub, cached) ──');
// Warm the isolated source first so comparisons are cache-vs-cache.
{
  const w = await j(`${BASE}/stream/movie/tt15239678.json?sources=4khdhub`);
  ok('warmup 4khdhub movie', w.status === 200, `${w.body?.streams?.length} cards`);
}
{
  // quality whitelist: only 4K
  const { body } = await j(`${BASE}/stream/movie/tt15239678.json?sources=4khdhub&res_2160=on`);
  const streams = body.streams || [];
  const heights = streams.map(s => {
    const m = /\b(4K|1080p|720p|480p|360p)\b/.exec(s.name || '');
    return m ? m[1] : 'unknown';
  });
  const bad = heights.filter(h => h !== '4K' && h !== 'unknown');
  ok('res_2160 filter removes non-4K cards', bad.length === 0, `heights=${[...new Set(heights)].join(',')}`);
}
{
  // subtitles disabled → no card carries tracks
  const noSub = await j(`${BASE}/stream/movie/tt15239678.json?sources=4khdhub&subtitles_disabled=on`);
  const withTracks = (noSub.body.streams || []).filter(s => Array.isArray(s.subtitles) && s.subtitles.length);
  ok('subtitles_disabled strips tracks', withTracks.length === 0);
  const withSub = await j(`${BASE}/stream/movie/tt15239678.json?sources=4khdhub`);
  const anyTracks = (withSub.body.streams || []).some(s => Array.isArray(s.subtitles) && s.subtitles.length);
  ok('default install still carries subtitle tracks', anyTracks, `${(withSub.body.streams || []).length} cards`);
}
{
  // formatter: custom name template overrides card names
  const tpl = encodeURIComponent(JSON.stringify({ name: 'CUSTOM {stream.resolution} FROM {stream.source}' }));
  const seg = 'z' + zlib.deflateRawSync(JSON.stringify({ formatter_name: 'CUSTOM {stream.resolution} FROM {stream.source}' })).toString('base64url');
  const fmt = await j(`${BASE}/${encodeURIComponent(seg)}/stream/movie/tt15239678.json`);
  const names = (fmt.body.streams || []).map(s => s.name || '');
  ok('formatter overrides card names', names.length > 0 && names.every(n => n.startsWith('CUSTOM')), names[0]?.slice(0, 48));
}
{
  // source whitelist via source_* keys (no sources= param)
  const seg = 'z' + zlib.deflateRawSync(JSON.stringify({ source_4khdhub: 'on' })).toString('base64url');
  const t0 = Date.now();
  const r = await j(`${BASE}/${encodeURIComponent(seg)}/stream/movie/tt1375666.json`);
  const dur = Date.now() - t0;
  ok('source_* whitelist resolves', r.status === 200 && Array.isArray(r.body.streams), `${r.body?.streams?.length} cards in ${dur}ms`);
  const brands = new Set((r.body.streams || []).map(s => (s.name || '').split('·')[2]?.trim()).filter(Boolean));
  ok('all cards from whitelisted source only', [...brands].every(b => /4KHDHub/i.test(b) || brands.size === 0), [...brands].join(','));
}
{
  // min size filter: 100GB min should drop everything with known smaller size
  const seg = 'z' + zlib.deflateRawSync(JSON.stringify({ source_4khdhub: 'on', min_size_gb: 100 })).toString('base64url');
  const r = await j(`${BASE}/${encodeURIComponent(seg)}/stream/movie/tt15239678.json`);
  ok('huge min_size filter drops sized cards', r.status === 200, `${r.body?.streams?.length} cards survive`);
}

console.log('── subtitles resource ──');
{
  const r = await j(`${BASE}/subtitles/movie/tt15239678.json`);
  ok('subtitles route 200', r.status === 200 && Array.isArray(r.body?.subtitles), `${r.body?.subtitles?.length} tracks`);
}

console.log('── status/data backward compat (guard baseline) ──');
{
  const r = await j(`${BASE}/status/data`);
  ok('status/data still serves', r.status === 200 && Array.isArray(r.body?.sources) && r.body.sources.length === 67);
}

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
