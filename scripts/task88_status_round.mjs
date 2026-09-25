// Task 88: fresh status round (user: "Yes do it" — continue the egress-class watch + acer migration follow-up).
// Task 87 already: (a) re-checked the 4 egress-class sources — hindmoviez recovered, IP unchanged 74.220.48.71;
// (b) RE'd acer — NO migration target (live JS = same surface, requestOnline dead, no alt hosts);
// (c) shipped canary + DEFINITIVE_MISS + 30min negative cache (2f214ea), verified on prod.
// This round: confirm prod is on f84df71, catch any Render IP rotation SINCE Task 87, re-probe the
// egress-class sources, check acer upstream limiter state, and one merged leak-scan round.
const PROD = 'https://ignatiusphoenix-5zrn.onrender.com';
const PREV_IP = '74.220.48.71'; // Tasks 83/87

const MOVIE1 = 'tmdb:693134';    // Dune: Part Two
const MOVIE2 = 'tmdb:27205';     // Inception
const SERIES1 = 'tmdb:1396:1:1'; // Breaking Bad S1E1
const ANIME1 = 'tmdb:95479:1:1'; // Jujutsu Kaisen S1E1

import fs from 'fs';
const OUT = '/tmp/task88_status.json';
const report = { at: new Date().toISOString(), health: {}, egress: {}, probes: [], acerUpstream: {}, merged: {} };

// ---- Step 0: health ----
try {
  const h = await fetch(`${PROD}/health`, { signal: AbortSignal.timeout(30000) }).then(r => r.json());
  report.health = {
    bootAt: h.bootAt, status: h.status, sourceCount: (h.sources || []).length,
    hasAcer: (h.sources || []).includes('acermovies'),
    hasKmmovies: (h.sources || []).includes('kmmovies'),
    hasAnimezey: (h.sources || []).includes('animezey'),
    hasHindmoviez: (h.sources || []).includes('hindmoviez'),
    keepaliveRootHits: h.keepalive?.rootHits,
  };
  console.log('HEALTH:', JSON.stringify(report.health));
  console.log('EXPECT bootAt >= 2026-09-24T21:01:35Z (f84df71 deploy marker)');
} catch (e) { report.health = { error: e.message }; console.log('HEALTH FAIL:', e.message); }

// ---- Step 1: egress IP ----
for (const svc of ['https://api.ipify.org?format=json', 'https://ipinfo.io/json']) {
  try {
    const u = `${PROD}/debug/rawfetch?url=${encodeURIComponent(svc)}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    const body = j.body ?? JSON.stringify(j).slice(0, 400);
    const parsed = JSON.parse(body);
    if (parsed.ip) {
      report.egress = { ip: parsed.ip, via: svc, rotated: parsed.ip !== PREV_IP };
      break;
    }
  } catch (e) { console.log(`egress svc ${svc} failed: ${e.message}`); }
}
console.log('EGRESS:', JSON.stringify(report.egress), '| prev', PREV_IP,
  report.egress.rotated ? '→ ROTATION!' : '→ no rotation');

// ---- Step 2: egress-class + acer probes ----
const PROBES = [
  ['acermovies', 'movie', MOVIE2, 'Inception'],
  ['acermovies', 'movie', MOVIE1, 'Dune2'],
  ['acermovies', 'series', SERIES1, 'BB'],
  ['kmmovies', 'movie', MOVIE2, 'Inception'],
  ['animezey', 'anime', ANIME1, 'JJK'],
  ['hindmoviez', 'movie', MOVIE2, 'Inception'],
];

async function probeOne([id, type, rid, label]) {
  const url = `${PROD}/debug/source/${id}?type=${type}&id=${encodeURIComponent(rid)}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({}));
    const results = j.results || j.streams || [];
    const logs = String(j.logs || '');
    const sig = {
      cooldown: /cooldown/i.test(logs),
      negativeCache: /negative cache/i.test(logs),
      definitiveMiss: /definitive miss|DefinitiveMiss/i.test(logs),
      fromCache: /fromCache/i.test(logs),
    };
    const entry = {
      id, type, label, status: r.status, count: results.length,
      ms: Date.now() - t0, durMs: j.durationMs, sig,
      logTail: logs.split('\n').slice(-4).join(' | ').slice(0, 400),
    };
    console.log(`PROBE ${id}/${label}: count=${entry.count} ms=${entry.ms} durMs=${entry.durMs} sig=${JSON.stringify(sig)}`);
    if (entry.logTail) console.log(`   tail: ${entry.logTail}`);
    return entry;
  } catch (e) {
    const entry = { id, type, label, error: e.message, ms: Date.now() - t0 };
    console.log(`PROBE ${id}/${label}: ERROR ${e.message}`);
    return entry;
  }
}

for (const p of PROBES) {
  report.probes.push(await probeOne(p));
  await new Promise(res => setTimeout(res, 1500)); // gentle pacing
}

// ---- Step 3: acer upstream limiter state (direct POST /api/search via rawfetch) ----
try {
  const payload = JSON.stringify({ searchQuery: 'superman' });
  const u = `${PROD}/debug/rawfetch?url=${encodeURIComponent('https://api2.acermovies.fun/api/search')}` +
    `&method=POST&ct=application%2Fjson&body=${encodeURIComponent(payload)}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  const body = String(j.body ?? '');
  let n = 0; try { n = (JSON.parse(body).results || []).length; } catch {}
  report.acerUpstream = { status: j.status, results: n, bodyHead: body.slice(0, 160) };
  console.log('ACER UPSTREAM search:', JSON.stringify(report.acerUpstream));
} catch (e) { report.acerUpstream = { error: e.message }; console.log('ACER UPSTREAM FAIL:', e.message); }

// ---- Step 4: merged leak-scan (Inception, one round) ----
try {
  const t0 = Date.now();
  const r = await fetch(`${PROD}/stream/movie/tmdb:27205.json`, { signal: AbortSignal.timeout(90000) });
  const j = await r.json().catch(() => ({}));
  const streams = j.streams || [];
  const magnets = streams.filter(s => /^magnet:/i.test(s.url || '')).length;
  const html = streams.filter(s => /^https?:\/\/[^\/]*\.(html?|php)([?#]|$)/i.test(s.url || '')).length;
  const brands = {};
  for (const s of streams) {
    const m = /PhoeniX ·([^·]*)·([^·]*)·/.exec(s.title || '');
    const b = m ? m[1].trim() : '?';
    brands[b] = (brands[b] || 0) + 1;
  }
  report.merged = {
    status: r.status, count: streams.length, ms: Date.now() - t0,
    cc: r.headers.get('cache-control'), magnets, html,
    brands: Object.fromEntries(Object.entries(brands).sort((a, b) => b[1] - a[1]).slice(0, 12)),
  };
  console.log('MERGED:', JSON.stringify(report.merged));
} catch (e) { report.merged = { error: e.message }; console.log('MERGED FAIL:', e.message); }

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nSaved ${OUT}`);
console.log('VERDICT:',
  report.egress.rotated ? 'IP ROTATED — full egress recheck warranted' : 'IP unchanged',
  '| acer probes:', report.probes.filter(p => p.id === 'acermovies').map(p => `${p.label}=${p.count}`).join(' '),
  '| kmmovies:', report.probes.find(p => p.id === 'kmmovies')?.count,
  '| animezey:', report.probes.find(p => p.id === 'animezey')?.count,
  '| hindmoviez:', report.probes.find(p => p.id === 'hindmoviez')?.count,
  '| merged:', report.merged.count, 'cards,', report.merged.magnets, 'magnets,', report.merged.html, 'html');
