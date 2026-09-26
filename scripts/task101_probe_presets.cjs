#!/usr/bin/env node
// Task 101 probe: actual engine output per preset (names + descriptions) for
// building exact regression expectations.
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:7100';
const src = fs.readFileSync('public/configure.js', 'utf8');
const code = src.slice(src.indexOf('const FORMATTER_PRESETS'), src.indexOf('function detectFormatterPreset'));
const PRESETS = new Function(code + '; return FORMATTER_PRESETS;')();

const samples = [
  { label: '4K Remux', meta: { height: 2160, bytes: 51611776512, sourceLabel: '4KHDHub', serverName: '10Gbps', countryCodes: ['en', 'hi'], format: 'mp4', title: 'Dune Part Two', sourceType: 'BluRay Remux', codec: 'HEVC', audioCodec: 'TrueHD', audioChannels: '5.1', hdr: 'DV,HDR10', releaseGroup: 'FRAM' }, stream: { name: 'X · 4K · 4KHDHub · 10Gbps', title: 'Dune Part Two · 2024 · HDR · DTS-HD MA 5.1 · 48.1 GB' }, url: 'https://dl.example.com/Dune.mkv', requestType: 'movie', requestId: 'tt1' },
  { label: 'series', meta: { height: 1080, bytes: 0, sourceLabel: 'HiAnime', serverName: 'MegaPlay', countryCodes: ['ja', 'en'], format: 'hls', title: 'Frieren', sourceType: 'Web-DL', codec: 'HEVC', audioCodec: 'AAC' }, stream: { name: 'X · 1080p · HiAnime · MegaPlay', title: 'Frieren · S2E1 · Sub+Dub' }, url: 'https://addon.example/proxy?url=https%3A%2F%2Ff.m3u8', requestType: 'series', requestId: 'tt3:2:1' },
];

(async () => {
  const only = process.argv.slice(2);
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (only.length && !only.includes(key)) continue;
    const r = await fetch(`${BASE}/api/formatter-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: preset.name, description: preset.description, samples }),
    });
    const j = await r.json();
    console.log(`### ${key}`);
    for (const s of j.samples) {
      console.log(`  [${s.label}] NAME=${JSON.stringify(s.name)}`);
      console.log(`  [${s.label}] DESC=${JSON.stringify(s.description).slice(0, 500)}`);
      if (s.error) console.log(`  [${s.label}] ERR=${s.error}`);
    }
  }
})();
