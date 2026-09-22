// Task 82 — videasy/vidking comparison: local E2E of the three SRL-riding
// providers (videasy, videasyto, cineby) + where their stream URLs point +
// whether the vidking.net Referer actually matters for playback.
//
// Context: Task 78 zeroed cineby+videasy ("vidking outage": SRL seed 502/DNS);
// Task 80 noted recovery via moon.quietridge.top CDN. vidking.net itself is
// DNS-dead — this probe verifies that doesn't block playback.
//
// Usage: node scripts/task82_videasy_local.mjs [tmdbId] [movie|tv] [s] [e]

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmdbId = process.argv[2] || '27205';           // Inception
const type = process.argv[3] || 'movie';
const season = process.argv[4] ? parseInt(process.argv[4]) : null;
const episode = process.argv[5] ? parseInt(process.argv[5]) : null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const videasy = require('../src/nuvio/videasy.cjs');
const videasyto = require('../src/nuvio/videasyto.cjs');
const cineby = require('../src/nuvio/cineby.cjs');

function hostOf(u) { try { return new URL(u).host; } catch { return 'invalid'; } }

function summarize(label, streams) {
  if (!Array.isArray(streams) || streams.length === 0) return console.log(`[${label}] 0 streams`);
  const hosts = {};
  for (const s of streams) hosts[hostOf(s.url)] = (hosts[hostOf(s.url)] || 0) + 1;
  const withVkRef = streams.filter(s => s.headers?.Referer?.includes('vidking')).length;
  console.log(`[${label}] ${streams.length} streams | vidking-Referer: ${withVkRef}/${streams.length}`);
  console.log(`   hosts: ${JSON.stringify(hosts)}`);
  const s0 = streams[0];
  console.log(`   first: ${String(s0.name || s0.title || '').slice(0, 90)}`);
  console.log(`          ${s0.url.slice(0, 110)}`);
}

(async () => {
  console.log(`=== videasy-family local E2E: ${type} ${tmdbId}${type === 'tv' ? ` S${season}E${episode}` : ''} ===`);

  // 0. SRL health snapshot
  try {
    const r = await fetch('https://api.speedracelight.com/seed?mediaId=' + tmdbId, { headers: { 'User-Agent': UA, Origin: 'https://www.vidking.net', Referer: 'https://www.vidking.net/' }, signal: AbortSignal.timeout(10000) });
    console.log(`[SRL seed] HTTP ${r.status} ${(await r.text()).slice(0, 70)}`);
  } catch (e) { console.log(`[SRL seed] FAIL ${e.message}`); }

  // 1. videasy (obfuscated wings-decrypt provider)
  try { summarize('videasy', await videasy.getStreams(tmdbId, type === 'tv' ? 'tv' : 'movie', season, episode)); }
  catch (e) { console.log(`[videasy] FAIL ${e.message}`); }

  // 2. videasyto
  try { summarize('videasyto', await videasyto.getStreams(tmdbId, type === 'tv' ? 'tv' : 'movie', season, episode)); }
  catch (e) { console.log(`[videasyto] FAIL ${e.message}`); }

  // 3. cineby
  try { summarize('cineby', await cineby.getStreams(tmdbId, type === 'tv' ? 'tv' : 'movie', season, episode)); }
  catch (e) { console.log(`[cineby] FAIL ${e.message}`); }

  // 4. Referer-dependency check on a real returned stream URL (range probe with
  //    and without the vidking Referer)
  console.log('\n--- Referer-dependency probe ---');
  let probeUrl = null, probeRef = null;
  const s = await videasy.getStreams(tmdbId, type === 'tv' ? 'tv' : 'movie', season, episode).catch(() => []);
  if (s && s.length) { probeUrl = s[0].url; probeRef = s[0].headers?.Referer; }
  if (probeUrl) {
    for (const mode of ['with-vidking-ref', 'no-referer']) {
      try {
        const headers = { 'User-Agent': UA, Range: 'bytes=0-255' };
        if (mode === 'with-vidking-ref' && probeRef) { headers.Referer = probeRef; headers.Origin = new URL(probeRef).origin; }
        const r = await fetch(probeUrl, { headers, signal: AbortSignal.timeout(12000), redirect: 'follow' });
        const buf = new Uint8Array(await r.arrayBuffer());
        const magic = buf.slice(4, 8).toString() === 'ftyp' ? 'MP4' : (buf[0] === 0x1a && buf[1] === 0x45) ? 'MKV' : (buf[0] === 0x47 && buf[188] === 0x47) ? 'TS' : '#EXTM3U' === buf.slice(0, 7).toString() ? 'HLS' : `bytes:${[...buf.slice(0, 4)].map(b => b.toString(16)).join(' ')}`;
        console.log(`[${mode}] HTTP ${r.status} ct=${r.headers.get('content-type') || '-'} magic=${magic} final=${(r.url || '').slice(0, 70)}`);
      } catch (e) { console.log(`[${mode}] FAIL ${e.message.slice(0, 90)}`); }
    }
  } else console.log('no stream URL returned to probe');
})().catch(e => console.error('FATAL', e));
