#!/usr/bin/env node
// Task 101: unit-check the client scenario model (module-level code extracted
// from configure.js) and its roundtrip through /api/formatter-preview.
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:7100';
let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

const src = fs.readFileSync('public/configure.js', 'utf8');
const start = src.indexOf('const SCENARIO_FIELD_DEFAULTS');
const end = src.indexOf('const initialSelectedQualities');
if (start < 0 || end < 0) { console.error('scenario block not found'); process.exit(1); }
const mod = new Function(`${src.slice(start, end)}\nreturn { PREVIEW_SCENARIOS, SCENARIO_FIELD_DEFAULTS, scenarioWithDefaults, parseScenarioCodes, buildScenarioSample, GB };`)();

const { PREVIEW_SCENARIOS, buildScenarioSample } = mod;

console.log('== scenario model ==');
ok(PREVIEW_SCENARIOS.length === 5, '5 scenarios (usenet excluded)', `got ${PREVIEW_SCENARIOS.length}`);
ok(PREVIEW_SCENARIOS.some(s => s.id === 'season-pack'), 'season-pack present');
ok(!PREVIEW_SCENARIOS.some(s => /usenet/i.test(s.id + s.label)), 'no usenet scenario');
for (const s of PREVIEW_SCENARIOS) {
  const f = s.fields;
  ok(f && typeof f === 'object' && Array.isArray(buildScenarioSample(f).meta.countryCodes), `scenario "${s.id}" builds a valid sample`);
}

console.log('== season-pack roundtrip through the real engine ==');
{
  const sp = PREVIEW_SCENARIOS.find(s => s.id === 'season-pack');
  const sample = buildScenarioSample(sp.fields);
  const r = await fetch(`${BASE}/api/formatter-preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '{stream.resolution}{metadata.season::exists[" s{metadata.season}"||""]}{metadata.episode::exists["e{metadata.episode}"||" no-ep"]}',
      description: '{stream.size::sbytes} · {stream.source}',
      samples: [sample],
    }),
  });
  const j = await r.json();
  const s = j.samples?.[0];
  ok(j.ok === true, 'endpoint ok');
  ok(s?.name === '2160p s2 no-ep', 'season filled, episode null → " no-ep" branch', JSON.stringify(s?.name));
  ok(s?.description?.includes('90.2 GB') === true, '84 GiB → 90.2 GB base-10 smart', JSON.stringify(s?.description));
  ok(s?.description?.includes('UHDMovies') === true, 'source label flows through', JSON.stringify(s?.description));
}

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
