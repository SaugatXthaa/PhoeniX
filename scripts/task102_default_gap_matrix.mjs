#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Task 102 — DEFAULT PRESET = the pre-formatter-UI PhoeniX format.
// "No gaps" matrix: Default preset + all 7 templates × all scenarios
// (built-in samples + the 5 configure-UI scenarios) × user-imported
// templates, plus the old-default config migration. Run with the local
// server already up (PORT=7100) for the live parts.
//   node scripts/task102_default_gap_matrix.mjs [baseUrl]
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://127.0.0.1:7100';

let pass = 0, fail = 0, info = 0;
function ok(cond, label, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
function note(msg) { info++; console.log(`  INFO  ${msg}`); }

const LEAK = /\{(?:stream|addon|service|metadata|user|config|debug|tools)\.|invalid_expression|unknown_variableType|unknown_propertyName|unknown_(?:string|number|array|boolean|object)_modifier|cannot_coerce_boolean|unrenderable_list|unable_to_compare/;

async function postPreview(body) {
  const res = await fetch(`${BASE}/api/formatter-preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json();
}

// ── extract FORMATTER_PRESETS straight from the shipped UI ───────────────
function loadPresets() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'configure.js'), 'utf8');
  const start = src.indexOf('const FORMATTER_PRESETS');
  const end = src.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('FORMATTER_PRESETS block not found in configure.js');
  const block = src.slice(start, end + 3);
  return new Function(`${block}\nreturn FORMATTER_PRESETS;`)();
}
const PRESETS = loadPresets();

// ── mirror the configure-UI scenarios exactly (public/configure.js) ──────
const GB = 1024 ** 3;
function scenarioSample(fields) {
  const parseCodes = (v) => String(v || '').split(',').map((c) => c.trim()).filter(Boolean).slice(0, 8);
  return {
    label: fields.requestType === 'series' ? 'Scenario · episode' : 'Scenario · movie',
    meta: {
      height: Number(fields.height) || 0,
      bytes: Math.round((Number(fields.sizeGb) > 0 ? Number(fields.sizeGb) : 0) * GB),
      bandwidth: Math.round((Number(fields.bitrateKbps) > 0 ? Number(fields.bitrateKbps) : 0) * 1000),
      title: fields.title, sourceLabel: fields.sourceLabel, serverName: fields.serverName,
      streamingPlatform: fields.network, sourceType: fields.quality, format: fields.format,
      codec: fields.codec, audioCodec: fields.audioCodec, audioChannels: fields.audioChannels,
      hdr: fields.hdr, releaseGroup: fields.releaseGroup,
      countryCodes: parseCodes(fields.languages),
      subtitles: parseCodes(fields.subtitles).map((c) => ({ lang: c })),
    },
    stream: { name: fields.fallbackName, title: fields.fallbackTitle },
    url: fields.url, requestType: fields.requestType, requestId: fields.requestId,
  };
}
const SCENARIOS = [
  { id: 'remux4k', fields: { sourceLabel: '4KHDHub', serverName: '10Gbps', addonName: 'PhoeniX', fallbackName: '🐦‍🔥 PhoeniX · 4K · 4KHDHub · 10Gbps', fallbackTitle: 'x', url: 'https://dl.example.com/Dune.Part.Two.2024.2160p.BluRay.Remux.HEVC.mkv', title: 'Dune Part Two', height: 2160, sizeGb: 48.1, bitrateKbps: '', quality: 'BluRay Remux', codec: 'HEVC', audioCodec: 'TrueHD', audioChannels: '5.1', hdr: 'DV,HDR10', releaseGroup: 'FRAM', format: 'mkv', languages: 'en,hi', subtitles: 'en', network: '', requestType: 'movie', requestId: 'tt15239678' } },
  { id: 'webdl1080', fields: { sourceLabel: 'HDHub4u', serverName: '', addonName: 'PhoeniX', fallbackName: '🐦‍🔥 PhoeniX · 1080p · HDHub4u', fallbackTitle: 'x', url: 'https://cdn.example/The.Batman.2022.1080p.WEB-DL.mp4', title: 'The Batman', height: 1080, sizeGb: 3.0, bitrateKbps: '', quality: 'Web-DL', codec: 'AVC', audioCodec: 'DD+', audioChannels: '5.1', hdr: '', releaseGroup: 'HDHub4u', format: 'mp4', languages: 'hi,en', subtitles: '', network: '', requestType: 'movie', requestId: 'tt1877830' } },
  { id: 'qhd1440', fields: { sourceLabel: 'VidLink', serverName: '', addonName: 'PhoeniX', fallbackName: '🐦‍🔥 PhoeniX · 1440p · VidLink', fallbackTitle: 'x', url: 'https://addon.example/proxy?url=https%3A%2F%2Fcdn.example%2Finter.m3u8', title: 'Interstellar', height: 1440, sizeGb: 6.5, bitrateKbps: '', quality: 'Web-DL', codec: 'x264', audioCodec: '', audioChannels: '', hdr: 'HDR', releaseGroup: '', format: 'hls', languages: 'en', subtitles: '', network: '', requestType: 'movie', requestId: 'tt0816692' } },
  { id: 'season-pack', fields: { sourceLabel: 'UHDMovies', serverName: '', addonName: 'PhoeniX', fallbackName: '🐦‍🔥 PhoeniX · 4K · UHDMovies', fallbackTitle: 'x', url: 'https://dl.example.com/Series.Title.S02.COMPLETE.2160p.WEB-DL.DV.HDR10.DDP5.1.H.265.mkv', title: 'Series Title', height: 2160, sizeGb: 84, bitrateKbps: '', quality: 'Web-DL', codec: 'HEVC', audioCodec: 'DD+', audioChannels: '5.1', hdr: 'DV,HDR10', releaseGroup: '', format: 'mkv', languages: 'en', subtitles: 'en', network: '', requestType: 'series', requestId: 'tt0903747:2:' } },
  { id: 'anime', fields: { sourceLabel: 'HiAnime', serverName: 'MegaPlay', addonName: 'PhoeniX', fallbackName: '🐦‍🔥 PhoeniX · 1080p · HiAnime · MegaPlay', fallbackTitle: 'x', url: 'https://addon.example/proxy?url=https%3A%2F%2Fcdn.example%2Ffrieren.m3u8', title: 'Sousou no Frieren', height: 1080, sizeGb: '', bitrateKbps: '', quality: 'Web-DL', codec: 'HEVC', audioCodec: 'AAC', audioChannels: '', hdr: '', releaseGroup: 'SubsPlease', format: 'hls', languages: 'ja,en', subtitles: 'en', network: '', requestType: 'series', requestId: 'tt209867:2:1' } },
];

// ══════════════════════ 1. offline units (no server) ═════════════════════
console.log('== 1. config migration — old simplified Default pair → native (offline) ==');
{
  const { normalizeConfig } = await import(path.join(ROOT, 'src', 'utils', 'addonConfig.cjs'));
  const OLD = {
    name: '🐦‍🔥 PhoeniX · {stream.resolution::exists["{stream.resolution}"||""]}{stream.source::exists[" · {stream.source}"||""]}',
    description: '{stream.title}',
  };
  let r = normalizeConfig({ formatter_name: OLD.name, formatter_description: OLD.description });
  ok(r.formatterName === null && r.formatterDescription === null && r.hasAny === false, 'exact old pair → unset (native builder runs)');

  r = normalizeConfig({ formatter_name: OLD.name, formatter_description: OLD.description, res_1080: 'on' });
  ok(r.formatterName === null && r.formatterDescription === null && r.hasAny === true, 'old pair alongside real keys → formatter dropped, real keys kept');

  r = normalizeConfig({ formatter_name: OLD.name, formatter_description: 'custom desc' });
  ok(r.formatterName !== null && r.formatterDescription === 'custom desc', 'old name + custom description → kept (user intent)');

  r = normalizeConfig({ formatter_name: 'custom name', formatter_description: OLD.description });
  ok(r.formatterName === 'custom name' && r.formatterDescription !== null, 'custom name + old description → kept (user intent)');

  // engine fail-open: empty template → fallback passthrough
  const fmtMod = await import(path.join(ROOT, 'src', 'utils', 'formatter.cjs'));
  const formatter = fmtMod.default ?? fmtMod;
  const out = formatter.formatStream({
    nameTemplate: '', descriptionTemplate: '',
    meta: { height: 2160, sourceLabel: 'X' }, stream: { name: 'native-name', title: 'native-title' },
    addonName: 'PhoeniX',
  });
  ok(out.name === 'native-name' && out.description === 'native-title', 'formatStream with empty templates → native fallback passthrough');
}

// ══════════════════════ 2. live: Default preset preview ══════════════════
console.log('== 2. Default preset preview — native builder through the endpoint ==');
{
  const out = await postPreview({ name: '', description: '' });
  ok(out.ok === true, 'endpoint reachable');
  ok(Array.isArray(out.samples) && out.samples.length === 4, '4 built-in samples render', `got ${out.samples?.length}`);
  ok(out.defaults && out.defaults.name === '' && out.defaults.description === '', 'defaults = empty templates (native preset)');
  for (const s of out.samples) {
    ok(typeof s.name === 'string' && s.name.startsWith('🐦‍🔥 PhoeniX'), `native name for [${s.label}]`, JSON.stringify(s.name));
    ok(typeof s.description === 'string' && s.description.split('\n').length >= 3, `native multi-line description for [${s.label}]`, JSON.stringify(s.description?.slice(0, 60)));
    ok(!LEAK.test(s.name) && !LEAK.test(s.description), `no token leakage for [${s.label}]`);
  }
  const remux = out.samples.find((s) => s.label === '4K Remux');
  ok(remux && remux.name.includes('· 4K ·') && remux.name.includes('4KHDHub') && remux.name.includes('10Gbps'), 'name keeps quality · source · server chain', JSON.stringify(remux?.name));
  ok(remux && /💾 .+GB/.test(remux.description), 'description has native size line (bytes package style)', JSON.stringify(remux?.description?.match(/💾.*/)?.[0]));
  ok(remux && remux.description.includes('Audio: 🇺🇸 English, 🇮🇳 Hindi'), 'description has paired flag+language Audio line');
  ok(remux && remux.description.includes('🔗'), 'description has native source-link line');

  const batman = out.samples.find((s) => s.label === '1080p Web-DL');
  ok(batman && batman.description.includes('· MP4'), 'mp4 container tagged in specs line');
  const inter = out.samples.find((s) => s.label === '1440p QHD');
  ok(inter && inter.name.includes('1440p'), '1440p quality in native name');
}

// ══════════════════════ 3. live: Default × every scenario ════════════════
console.log('== 3. Default preset × all 5 UI scenarios (native look per scenario) ==');
{
  for (const sc of SCENARIOS) {
    const out = await postPreview({ name: '', description: '', samples: [scenarioSample(sc.fields)] });
    const s = out.samples?.[0];
    ok(out.ok && s && typeof s.name === 'string' && s.name.startsWith('🐦‍🔥 PhoeniX'), `[${sc.id}] native name`, JSON.stringify(s?.name));
    ok(out.ok && s && !LEAK.test(s.name) && !LEAK.test(String(s.description)), `[${sc.id}] no leakage`);
    if (sc.id === 'season-pack') {
      const season = await postPreview({
        name: 'S{metadata.season}E{metadata.episode}',
        description: 'x',
        samples: [scenarioSample(sc.fields)],
      });
      ok(season.samples?.[0]?.name === 'S2E', 'season-pack requestId tt…:2: → metadata.season=2, episode null', JSON.stringify(season.samples?.[0]?.name));
    }
    if (sc.id === 'qhd1440') {
      const proxied = await postPreview({
        name: '{stream.proxied["P"||"D"]}',
        description: 'x',
        samples: [scenarioSample(sc.fields)],
      });
      ok(proxied.samples?.[0]?.name === 'P', 'proxied scenario URL detected as proxied');
    }
  }
}

// ══════════════════════ 4. live: all templates × all inputs ══════════════
console.log('== 4. all 7 templates × (4 built-ins + 5 scenarios) — zero leakage ==');
{
  const builtins = (await postPreview({ name: 'x', description: 'x' })).samples;
  ok(Array.isArray(builtins) && builtins.length === 4, 'endpoint alive for matrix');
  let combos = 0;
  let bad = 0;
  for (const [key, preset] of Object.entries(PRESETS)) {
    for (const sc of SCENARIOS) {
      const out = await postPreview({ name: preset.name, description: preset.description, samples: [scenarioSample(sc.fields)] });
      const s = out.samples?.[0];
      combos++;
      const leak = s && (LEAK.test(String(s.name)) || LEAK.test(String(s.description)));
      if (!out.ok || !s || leak || !String(s.name).trim()) { bad++; console.log(`      bad combo: ${key} × ${sc.id} → ${JSON.stringify(s?.name?.slice(0, 60))}`); }
    }
  }
  ok(combos === Object.keys(PRESETS).length * SCENARIOS.length && bad === 0, `all ${combos} template×scenario combos render clean`, `${bad} bad`);
}

// ══════════════════════ 5. live: user-imported template surface ══════════
console.log('== 5. user-imported template using EVERY registry field ==');
{
  const { FIELDS } = (await import(path.join(ROOT, 'src', 'utils', 'formatter.cjs')));
  const everyStream = FIELDS.stream.map((f) => `{stream.${f}}`).join('');
  const everyMeta = FIELDS.metadata.map((f) => `{metadata.${f}}`).join('');
  const everyUser = FIELDS.user.map((f) => `{user.${f}}`).join('');
  const big = `${everyStream}|${everyMeta}|${everyUser}|{addon.name}{config.addonName}{service.id}{service.cached}`;
  const out = await postPreview({ name: big.slice(0, 20000), description: 'ok', samples: [scenarioSample(SCENARIOS[0].fields)] });
  const s = out.samples?.[0];
  ok(out.ok && !!s, 'imported every-field template renders');
  ok(s && !LEAK.test(String(s.name)) && !LEAK.test(String(s.description)), 'imported every-field template leaks nothing');
  ok(s && String(s.name).length > 0, 'imported template name non-empty');

  // malformed templates fail open to the native card text
  const bad1 = await postPreview({ name: '{stream.resolution::exists["unterminated', description: '{stream.~~bad', samples: [scenarioSample(SCENARIOS[0].fields)] });
  const b = bad1.samples?.[0];
  ok(bad1.ok && b && !LEAK.test(String(b.name)) && !LEAK.test(String(b.description)), 'malformed templates fail open (no engine markers)');
  ok(b && String(b.name).startsWith('🐦‍🔥 PhoeniX'), 'malformed → native fallback name', JSON.stringify(b?.name));
}

// ══════════════════════ 6. live: real streams — Default vs migrated ══════
console.log('== 6. real streams: unconfigured vs old-default-migrated config ==');
{
  const seg = (obj) => 'z' + zlib.deflateRawSync(Buffer.from(JSON.stringify(obj))).toString('base64url');
  const OLD = {
    name: '🐦‍🔥 PhoeniX · {stream.resolution::exists["{stream.resolution}"||""]}{stream.source::exists[" · {stream.source}"||"\"]}',
    description: '{stream.title}',
  };
  const migrated = seg({ source_4khdhub: 'on', res_2160: 'on', res_1080: 'on', formatter_name: OLD.name, formatter_description: OLD.description });
  const plain = seg({ source_4khdhub: 'on', res_2160: 'on', res_1080: 'on' });
  const MOVIE = 'tt1375666';
  const streamUrl = (s) => `${BASE}/${s}/stream/movie/${MOVIE}.json`;
  const [a, b] = await Promise.all([fetch(streamUrl(plain)), fetch(streamUrl(migrated))]);
  const A = await a.json(), B = await b.json();
  const aCards = A.streams || [], bCards = B.streams || [];
  ok(aCards.length > 10, 'unconfigured install returns cards', `got ${aCards.length}`);
  ok(bCards.length > 10, 'old-default-migrated install returns cards', `got ${bCards.length}`);
  const nativeStyle = (c) => c.name?.startsWith('🐦‍🔥 PhoeniX') && typeof c.title === 'string' && /\n/.test(c.title);
  ok(aCards.every(nativeStyle), 'unconfigured cards are native format');
  ok(bCards.every(nativeStyle), 'migrated cards are native format (no simplified template)');
  const leakCards = bCards.filter((c) => LEAK.test(c.name || '') || LEAK.test(c.title || ''));
  ok(leakCards.length === 0, 'migrated cards leak nothing');
  if (aCards.length !== bCards.length) note(`count differs across the two live runs (live-source flakiness, not formatter): ${aCards.length} vs ${bCards.length}`);
  else ok(true, `count parity across runs (${aCards.length})`);
}

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL / ${info} INFO`);
process.exit(fail ? 1 : 0);
