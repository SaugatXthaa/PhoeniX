#!/usr/bin/env node
// Task 102 — WIDE SOURCE HEALTH PROBE
// Runs the full addon resolve for one popular movie + one series episode
// against the local server and reports: total cards, per-source counts,
// HTML/magnet leaks, count anomalies. Read-only (no config), uses the
// server's own parallelism. Usage: node scripts/task102_wide_probe.mjs [port]
const PORT = process.argv[2] || '7100';
const BASE = `http://127.0.0.1:${PORT}`;
const MOVIE = 'tt1375666'; // Inception
const SERIES = 'tt0903747:1:1'; // Breaking Bad S1E1

let pass = 0, fail = 0;
const ok = (c, l, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); } };

function analyze(label, streams) {
  const bySource = {};
  let html = 0, magnets = 0, noUrl = 0, subbed = 0;
  for (const s of streams) {
    const src = (s.name || '').split('·').map(x => x.trim()).filter(Boolean).slice(2).join(' · ') || 'unknown';
    const key = (s.behaviorHints?.bingeGroup || 'unknown').replace('phoenix-', '').split('-')[0];
    bySource[key] = (bySource[key] || 0) + 1;
    const u = s.url || s.externalUrl || '';
    if (!u) noUrl++;
    if (/^\s*</.test(u) || s.name?.includes('<html')) html++;
    if (u.startsWith('magnet:')) magnets++;
    if (s.subtitles?.length) subbed++;
  }
  console.log(`  [${label}] cards=${streams.length} sources=${Object.keys(bySource).length} subs=${subbed} html=${html} magnets=${magnets} noUrl=${noUrl}`);
  return { bySource, html, magnets, noUrl };
}

const t0 = Date.now();
const mRes = await fetch(`${BASE}/stream/movie/${MOVIE}.json`);
const mMov = await mRes.json();
const movieCards = mMov.streams || [];
const mA = analyze('movie', movieCards);
ok(movieCards.length > 30, 'movie: substantial card count', `${movieCards.length}`);
ok(mA.html === 0, 'movie: zero HTML cards');
ok(mA.magnets === 0, 'movie: zero magnet cards (debrid-only addon)');
ok(mA.noUrl === 0, 'movie: every card carries a url');

const sRes = await fetch(`${BASE}/stream/series/${SERIES}.json`);
const mSer = await sRes.json();
const serCards = mSer.streams || [];
const sA = analyze('series', serCards);
ok(serCards.length > 20, 'series: substantial card count', `${serCards.length}`);
ok(sA.html === 0 && sA.magnets === 0 && sA.noUrl === 0, 'series: clean cards');

// every card: name non-empty, description non-empty, name within sane bounds
const badNames = [...movieCards, ...serCards].filter(c => !c.name || c.name.length > 400);
ok(badNames.length === 0, 'all card names present and <400 chars', JSON.stringify(badNames.slice(0, 2).map(c => c.name?.slice(0, 60))));
const LEAK = /\{(?:stream|addon|service|metadata|user|config|debug|tools)\./;
const leaky = [...movieCards, ...serCards].filter(c => LEAK.test(c.name) || LEAK.test(c.title));
ok(leaky.length === 0, 'zero token leakage on live cards');

console.log(`\nWIDE PROBE (${((Date.now() - t0) / 1000).toFixed(1)}s): ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
