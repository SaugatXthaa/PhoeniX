#!/usr/bin/env node
// Task 99 unit — the 1440p option's config-layer contract (normalizeConfig).
// Covers: new-style explicit on/off, legacy installs (no res_1440 key) inheriting
// the 1080p toggle, per-source caps regex with 1440, and the legacy 1080→1440
// cap mirroring. Run: node scripts/task99_unit_1440.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { normalizeConfig, RANKS } = require('../src/utils/addonConfig.cjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const heightsOf = (raw) => normalizeConfig(raw).heights;

console.log('── RANKS ──');
ok('RANKS carries 1440 between 2160 and 1080',
  JSON.stringify(RANKS) === JSON.stringify([2160, 1440, 1080, 720, 480, 360]),
  RANKS.join('/'));

console.log('── new-style installs (explicit res_1440) ──');
{
  const h = heightsOf({ res_2160: 'on', res_1440: 'on', res_1080: 'on' });
  ok('res_1440=on whitelists the 1440 tier', h.includes(1440), h.join('/'));
}
{
  // The exact config the current UI builds when 1440p is DESELECTED:
  // res_1440=off is explicit, so QHD must drop even though 1080p stays on.
  const h = heightsOf({ res_2160: 'off', res_1440: 'off', res_1080: 'on', res_720: 'on', res_480: 'on', res_360: 'on' });
  ok('res_1440=off drops QHD while 1080p stays', !h.includes(1440) && h.includes(1080), h.join('/'));
}
{
  const cfg = normalizeConfig({ res_1440: 'on' });
  ok('res_1440 alone still forms a strict whitelist', Array.isArray(cfg.heights) && cfg.heights.length === 1 && cfg.heights[0] === 1440 && cfg.hasAny, cfg.heights?.join('/'));
}

console.log('── legacy installs (no res_1440 key — pre-1440p UI) ──');
{
  const h = heightsOf({ res_2160: 'on', res_1080: 'on' });
  ok('legacy 1080p=on → QHD inherits on (was the old tier behavior)', h.includes(1440) && h.includes(1080), h.join('/'));
}
{
  const h = heightsOf({ res_2160: 'on', res_1080: 'off' });
  ok('legacy 1080p=off → QHD stays hidden', !h.includes(1440) && h.includes(2160), h.join('/'));
}
{
  const h = heightsOf({ res_1080: 'on' });
  ok('legacy res_1080 only → strict [1440,1080] whitelist', h.length === 2 && h.includes(1440) && h.includes(1080), h.join('/'));
}

console.log('── per-source caps ──');
{
  const cfg = normalizeConfig({ res_2160: 'on', res_1440: 'on', res_1080: 'on', quality_limit_stellar_1440: '2' });
  ok('quality_limit_<src>_1440 parses', cfg.qualityCaps?.stellar_1440 === 2, JSON.stringify(cfg.qualityCaps || {}));
}
{
  // Legacy mirror: pre-1440p install with a 1080p cap governed QHD too.
  const cfg = normalizeConfig({ res_1080: 'on', quality_limit_stellar_1080: '3' });
  ok('legacy install mirrors _1080 cap onto _1440', cfg.qualityCaps?.stellar_1080 === 3 && cfg.qualityCaps?.stellar_1440 === 3, JSON.stringify(cfg.qualityCaps || {}));
}
{
  // New-style install with explicit res_1440: caps stay independent.
  const cfg = normalizeConfig({ res_1440: 'off', res_1080: 'on', quality_limit_stellar_1080: '3' });
  ok('explicit res_1440 → no legacy cap mirroring', cfg.qualityCaps?.stellar_1080 === 3 && cfg.qualityCaps?.stellar_1440 === undefined, JSON.stringify(cfg.qualityCaps || {}));
}
{
  const cfg = normalizeConfig({ res_1440: 'on', quality_limit_stellar_1440: '0' });
  ok('cap 0 (block tier) works for 1440', cfg.qualityCaps?.stellar_1440 === 0, JSON.stringify(cfg.qualityCaps || {}));
}

console.log('── untouched settings still normalize (spot checks) ──');
{
  const cfg = normalizeConfig({ max_timeout: '9.6', group_by: 'provider', sort_by: 'size', formatter_name: ' X ', min_size_gb: '2.5' });
  ok('timeout clamp + group_by + sort_by + formatter + minGB',
    cfg.maxTimeoutSec === 10 && cfg.groupBy === 'provider' && cfg.sortBy === 'size' && cfg.formatterName === ' X ' && cfg.minBytes === Math.round(2.5 * 1024 ** 3));
}
{
  const cfg = normalizeConfig(null);
  ok('null config fails open (all unset)', !cfg.hasAny && cfg.heights === null && cfg.sourceIds === null);
}
{
  // Stremio native-config installs send 'checked'/'unchecked'… they actually
  // send checkbox values as configured — accept 1/true variants too.
  const h = heightsOf({ res_1440: '1', res_1080: 'true' });
  ok('1/true variants accepted for 1440', h.includes(1440) && h.includes(1080), h.join('/'));
}

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
