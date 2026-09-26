#!/usr/bin/env node
// Task 100 — inject the authentic AIOStreams formatter definitions (usenet
// stripped) into public/configure.js as FORMATTER_PRESETS, replacing the
// previous derived presets. Byte-exact via JSON → JSON.stringify embedding.
import fs from 'fs';

const defs = JSON.parse(fs.readFileSync('scripts/task100_aiostreams_defs.json', 'utf8'));
const labels = {
  torrentio: 'Torrentio', torbox: 'TorBox', gdrive: 'Google Drive',
  lightgdrive: 'Light Google Drive', minimalisticgdrive: 'Minimalistic',
  prism: 'Prism', tamtaro: 'TamTaro',
};
const entries = Object.entries(defs).map(([key, def]) => {
  const label = labels[key] || key;
  // JSON.stringify gives valid JS string literals (double-quoted, escaped)
  return `  ${JSON.stringify(key)}: {\n    label: ${JSON.stringify(label)},\n    name: ${JSON.stringify(def.name)},\n    description: ${JSON.stringify(def.description)},\n  },`;
});

const block = `// Authentic AIOStreams community formatter templates (the reference
// implementation's built-in definitions; usenet-release scenarios removed).
// Rendered by the same engine the resolver runs — see /api/formatter-preview
// for live truth on this addon's fields.
const FORMATTER_PRESETS = {
${entries.join('\n')}
};`;

let src = fs.readFileSync('public/configure.js', 'utf8');
const start = src.indexOf('const FORMATTER_PRESETS = {');
if (start < 0) { console.error('FORMATTER_PRESETS start not found'); process.exit(1); }
const endMarker = '\n};';
const end = src.indexOf(endMarker, start);
if (end < 0) { console.error('FORMATTER_PRESETS end not found'); process.exit(1); }
src = src.slice(0, start) + block + src.slice(end + endMarker.length);

// LS key for the saved-template library
if (!src.includes('savedTemplates:')) {
  src = src.replace(
    'const LS = {\n  theme: "phoenix-theme",',
    'const LS = {\n  theme: "phoenix-theme",\n  savedTemplates: "phoenix-formatter-templates",'
  );
}

fs.writeFileSync('public/configure.js', src);
console.log('injected', Object.keys(defs).length, 'presets');
