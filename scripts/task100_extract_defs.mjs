#!/usr/bin/env node
// Extracts the authentic AIOStreams built-in formatter definitions from the
// fetched formatter-definitions.ts, strips usenet-release scenarios (per the
// user instruction), and writes task100_aiostreams_defs.json.
import fs from 'fs';

const src = fs.readFileSync('/tmp/aio/formatter-definitions.ts', 'utf8');

// Pull each `key: { name: \`...\`, description: \`...\` }` block (backtick templates).
const defs = {};
const re = /(\w+): \{\s*\n\s*name: `([\s\S]*?)`,\s*\n\s*description: `([\s\S]*?)`,\s*\n\s*\}/g;
let m;
while ((m = re.exec(src)) !== null) {
  defs[m[1]] = { name: m[2], description: m[3] };
}

// ── usenet scenario stripping (user: "do not include usenet release") ──────
// prism: drop the usenet-age conditional and the Usenet footer token
defs.prism.description = defs.prism.description
  .replace(`{stream.type::=Usenet["📰 Usenet "||""]}`, '')
  .replace(`{stream.type::=usenet::and::stream.age::exists["📅 {stream.age} "||""]}`, '');
// tamtaro: drop usenet type-replacements, the usenet indexer clause, and the
// NZB-health message block
defs.tamtaro.name = defs.tamtaro.name
  .replace(`::replace('usenet','‍⁽ⁿᶻᵇ⁾‍')`, '')
  .replace(`::replace('stremio-usenet','‏⁽ⁿᶻᵇ⁾')`, '');
defs.tamtaro.description = defs.tamtaro.description
  .replace(`{stream.indexer::exists::and::stream.type::~usenet[" · {stream.indexer::truncate(13)}"||""]}`, '')
  .replace(`{stream.message::length::>0["{stream.message::replace('NZB Health: ✅','✅ ɴᴢʙ')::replace('NZB Health: 🧝','🧝 ɴᴢʙ')::replace('AvailNZB 💚','💚 ɴᴢʙ')::replace('NZB Health: ⚠️','ᴜɴᴠᴇʀɪғɪᴇᴅ ɴᴢʙ')::replace('NZB Health: 🚫','✘ɴᴢʙ')::smallcaps} "||""]}`, '');

const order = ['torrentio', 'torbox', 'gdrive', 'lightgdrive', 'minimalisticgdrive', 'prism', 'tamtaro'];
const out = {};
for (const k of order) {
  if (!defs[k]) { console.error(`MISSING ${k}`); process.exit(1); }
  out[k] = defs[k];
  console.log(`${k}: name=${defs[k].name.length}c desc=${defs[k].description.length}c usenet-left=${/usenet|nzb|NZB/i.test(defs[k].name + defs[k].description)}`);
}
fs.writeFileSync(new URL('./task100_aiostreams_defs.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('written');
