#!/usr/bin/env node
// Task 99 — real-code verification of the first-class 1440p tier.
// Every assertion runs against the REAL production code (no copies):
//   - enrichMeta (exported for tests) parsing height 1440 from titles
//   - StreamResolver.prototype.buildName/buildTitle labeling QHD cards
//   - the exact rankOf expression extracted from the live resolver source
//   - the real formatter engine's 1440p field mapping + template rendering
// Run: node scripts/task99_unit_1440b_realcode.mjs
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { StreamResolver, enrichMeta } from '../src/utils/StreamResolver.js';
import { formatStream, renderTemplate, fieldsForStream } from '../src/utils/formatter.cjs';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

const proto = StreamResolver.prototype;

console.log('── enrichMeta (real parser): 1440p detection ──');
{
  const r = enrichMeta({ meta: { title: 'Interstellar.2014.1440p.WEB-DL.x264' }, url: { href: 'http://x/file.mkv' } });
  ok('release title "…1440p…" → height 1440', r.meta.height === 1440, `height=${r.meta.height}`);
}
{
  const r = enrichMeta({ meta: { title: 'Show.S01E01.1440p.WEB.h264' }, url: { href: 'http://x/s.m3u8' } });
  ok('1440p beats the HLS 1080p default', r.meta.height === 1440, `height=${r.meta.height}`);
}
{
  const r = enrichMeta({ meta: { title: 'Some show' }, url: { href: 'http://x/vod/1440/master.m3u8' } });
  ok('URL path /1440/ → height 1440', r.meta.height === 1440, `height=${r.meta.height}`);
}
{
  const r = enrichMeta({ meta: { title: 'Some show' }, url: { href: 'http://x/vod/1080/master.m3u8' } });
  ok('URL path /1080/ still → 1080 (no regression)', r.meta.height === 1080, `height=${r.meta.height}`);
}
{
  const r = enrichMeta({ meta: { title: 'Movie.2160p.UHD.BluRay' }, url: { href: 'http://x/f.mkv' } });
  ok('2160p title unchanged', r.meta.height === 2160, `height=${r.meta.height}`);
}

console.log('── card naming (real buildName/buildTitle) ──');
{
  const name = proto.buildName({ meta: { height: 1440, sourceLabel: 'VidLink' }, isExternal: false });
  ok('buildName labels QHD as 1440p', /· 1440p · VidLink/.test(name), name);
}
{
  const name4k = proto.buildName({ meta: { height: 2160, sourceLabel: 'S' } });
  const name1080 = proto.buildName({ meta: { height: 1080, sourceLabel: 'S' } });
  ok('4K/1080p labels unchanged', /· 4K · S/.test(name4k) && /· 1080p · S/.test(name1080), `${name4k} | ${name1080}`);
}
{
  const t = proto.buildTitle({ meta: { height: 1440, title: 'Rel.1440p.Group' }, label: 'VidLink' });
  ok('buildTitle specs include 1440p', /\b1440p\b/.test(t), t.replace(/\n/g, ' | ').slice(0, 80));
}

console.log('── rankOf (exact expression from the live resolver source) ──');
{
  const src = readFileSync(new URL('../src/utils/StreamResolver.js', import.meta.url), 'utf8');
  const line = src.split('\n').find(l => l.includes('const rankOf ='));
  ok('rankOf expression found', Boolean(line));
  if (line) {
    // eslint-disable-next-line no-new-func
    const rankOf = new Function(`return (${line.slice(line.indexOf('=') + 1, line.lastIndexOf(';')).trim()});`)();
    const cases = [[2160, 2160], [2159, 1440], [1440, 1440], [1439, 1080], [1080, 1080], [720, 720], [480, 480], [360, 360], [200, 0]];
    let all = true;
    for (const [h, want] of cases) if (rankOf(h) !== want) { all = false; console.log(`    rankOf(${h})=${rankOf(h)} want ${want}`); }
    ok('tier map: QHD is its own tier between 4K and 1080p', all, cases.map(([h, w]) => `${h}→${rankOf(h)}`).join(' '));
  }
}

console.log('── formatter engine (real formatter.cjs): 1440p fields ──');
{
  const meta = { height: 1440, bytes: 7_032_530_944, sourceLabel: 'VidLink', format: 'hls', title: 'Interstellar.2014.1440p.WEB-DL.x264' };
  const fields = fieldsForStream(meta, { name: 'n', title: 't' }, 'PhoeniX');
  ok('stream.resolution = 1440p', fields['stream.resolution'] === '1440p');
  ok('stream.size humanized', fields['stream.size'] === '6.5 GB', fields['stream.size']);
}
{
  const out = formatStream({
    nameTemplate: '{stream.resolution::exists["Q={stream.resolution}"||"Q=?"]}',
    descriptionTemplate: '{stream.size::exists["SZ={stream.size}"||"SZ=none"]}',
    meta: { height: 1440, bytes: 7_032_530_944, sourceLabel: 'VidLink' },
    stream: { name: 'orig', title: 'origT' },
    addonName: 'PhoeniX',
  });
  ok('QHD card renders 1440p through the real engine', out.name === 'Q=1440p' && out.description === 'SZ=6.5 GB', JSON.stringify(out));
}
{
  // Prism preset must now have a 1440p variant rendering path (replace chain)
  const prism = `{stream.resolution::exists["{stream.resolution::replace('2160p','🔥 4K UHD')::replace('1080p','🚀 FHD')::replace('720p','💿 HD')::replace('480p','💩 SD')::replace('360p','💩 SD')}"||"🎞️ Stream"]}`;
  const out = renderTemplate(prism, fieldsForStream({ height: 1440, bytes: 1, sourceLabel: 'S' }, { name: 'n', title: 't' }, 'PhoeniX'));
  ok('Prism-style template passes 1440p through untouched (honest label)', out === '1440p', out);
}

console.log('── formatter fail-open (real engine, malformed template) ──');
{
  const out = formatStream({
    nameTemplate: '{stream.resolution::exists["unterminated',
    descriptionTemplate: null,
    meta: { height: 1440, sourceLabel: 'VidLink' },
    stream: { name: '🐦‍🔥 PhoeniX · 1440p · VidLink', title: 'T' },
    addonName: 'PhoeniX',
  });
  ok('malformed template falls back to the original card name', out.name === '🐦‍🔥 PhoeniX · 1440p · VidLink', out.name);
}

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
