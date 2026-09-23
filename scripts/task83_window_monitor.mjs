// Task 83: StellarRip window monitor + AcerMovies cache-fill watch on the NEW
// production deployment (ignatiusphoenix-5zrn.onrender.com, 8b14b15+9bab790).
//
// Context (Task 82/83):
//   - stellar.rip's stream-encrypted step gates Render's egress IP CLASS with
//     minutes-scale flapping windows; token layer always open. A bounded watch
//     catches a cooperative window and playprobes any delivered card.
//   - acer's per-IP 429 ban does NOT cover the fresh Render IP right now; the
//     Task 81 24h fallback cache is empty on every fresh boot (in-memory), so
//     good resolves NOW fill it with popular titles for future bans.
//
// Chunked execution (Bash 10-min limit): --rounds N --offset K. State appends
// to scripts/task83_monitor_state.json; the final chunk prints the summary.

import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { getStreams } = require('/home/z/my-project/phoenix-analysis/src/nuvio/stellarrip.cjs');

const BASE = 'https://ignatiusphoenix-5zrn.onrender.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STATE = '/home/z/my-project/phoenix-analysis/scripts/task83_monitor_state.json';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const rounds = +(args[args.indexOf('--rounds') + 1] || 2);
const offset = +(args[args.indexOf('--offset') + 1] || 0);
const skipSleep = args.includes('--no-sleep');

// per-round plan (6 rounds total): [stellarProdTitle, doLocal, acerTitle]
const TITLES = [
  { tmdb: '693134', label: 'Dune2' },
  { tmdb: '27205', label: 'Inception' },
];
const PLAN = [
  { st: TITLES[0], local: false, acer: { tmdb: '27205', label: 'Inception' } },
  { st: TITLES[1], local: true, acer: { tmdb: '693134', label: 'Dune2' } },
  { st: TITLES[0], local: false, acer: { tmdb: '157336', label: 'Interstellar' } },
  { st: TITLES[1], local: true, acer: { tmdb: '299534', label: 'Endgame' } },
  { st: TITLES[0], local: false, acer: { tmdb: '872585', label: 'Oppenheimer' } },
  { st: TITLES[1], local: true, acer: { tmdb: '238', label: 'Godfather' } },
];

async function jfetch(url, opts = {}, tmo = 120000) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(tmo) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { }
  return { status: r.status, headers: r.headers, text, j };
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { rounds: [] }; }
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

async function playprobe(label, card) {
  const h = card.behaviorHints?.proxyHeaders?.request || {};
  const out = { label, name: card.name, quality: card.quality || card.name?.match(/(\d+p|4K)/i)?.[1] || '?' };
  try {
    const r = await fetch(card.url, { headers: { 'User-Agent': h['User-Agent'] || UA, Referer: h.Referer, Origin: h.Origin }, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    out.master = r.status;
    if (!text.includes('#EXTM3U')) { out.verdict = 'not-m3u8'; return out; }
    const lines = text.split('\n');
    const variants = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const res = lines[i].match(/RESOLUTION=(\d+)x(\d+)/), bw = lines[i].match(/BANDWIDTH=(\d+)/), uri = lines[i + 1];
      if (uri && !uri.startsWith('#')) variants.push({ w: res ? +res[1] : 0, h: res ? +res[2] : 0, bw: bw ? +bw[1] : 0, uri: uri.trim() });
    }
    variants.sort((a, b) => b.bw - a.bw);
    out.variants = variants.map(v => `${v.w}x${v.h}`);
    if (!variants.length) { out.verdict = 'master-ok-no-variants'; return out; }
    const vUrl = new URL(variants[0].uri, card.url).toString();
    const v = await (async () => { try { const rr = await fetch(vUrl, { headers: { 'User-Agent': h['User-Agent'] || UA, Referer: h.Referer, Origin: h.Origin }, signal: AbortSignal.timeout(15000) }); return { status: rr.status, text: await rr.text() }; } catch (e) { return { status: 0, text: String(e) }; } })();
    const segs = v.text.split('\n').filter(l => l && !l.startsWith('#'));
    const init = v.text.split('\n').find(l => l.startsWith('#EXT-X-MAP'))?.match(/URI="([^"]+)"/)?.[1];
    out.variant = v.status; out.segments = segs.length;
    const firstMedia = init ? new URL(init, vUrl).toString() : segs[0] ? new URL(segs[0].trim(), vUrl).toString() : null;
    if (!firstMedia) { out.verdict = 'no-segments'; return out; }
    const sr = await fetch(firstMedia, { headers: { 'User-Agent': h['User-Agent'] || UA, Referer: h.Referer, Origin: h.Origin, Range: 'bytes=0-8191' }, signal: AbortSignal.timeout(15000) });
    const buf = Buffer.from(await sr.arrayBuffer());
    const magic = buf.subarray(4, 8).toString('latin1') === 'ftyp' ? 'fMP4' : buf[0] === 0x47 ? 'MPEG-TS' : 'unknown';
    out.media = sr.status; out.magic = magic;
    out.verdict = (magic === 'fMP4' || magic === 'MPEG-TS') ? 'PLAYABLE' : 'unknown-magic';
  } catch (e) { out.verdict = 'throw:' + (e?.message || e).slice(0, 60); }
  return out;
}

const state = loadState();

for (let k = 0; k < rounds; k++) {
  const idx = offset + k;
  if (idx >= PLAN.length) break;
  const plan = PLAN[idx];
  const rec = { round: idx + 1, at: new Date().toISOString(), st: {}, local: null, acer: {} };
  console.log(`\n===== round ${idx + 1}/${PLAN.length} @ ${rec.at} =====`);

  // 1. prod stellarrip
  {
    const t0 = Date.now();
    const r = await jfetch(`${BASE}/debug/source/stellarrip?type=movie&id=tmdb:${plan.st.tmdb}`, {}, 90000);
    const cards = r.j?.streams || [];
    rec.st = { title: plan.st.label, cards: cards.length, ms: Date.now() - t0, reported: r.j?.durationMs, cachedResp: r.j?.durationMs === 0 };
    console.log(`prod stellar ${plan.st.label}: ${cards.length} cards in ${rec.st.ms}ms (reported ${rec.st.reported}ms${rec.st.cachedResp ? ' CACHED-RESP' : ''})`);
    if (cards.length) {
      rec.st.samples = cards.slice(0, 3).map(c => ({ name: c.name, quality: c.quality, url: c.url?.slice(0, 120) }));
      rec.st.probes = [];
      for (const c of cards.slice(0, 2)) rec.st.probes.push(await playprobe('prod-' + plan.st.label, c));
      console.log('  probes:', rec.st.probes.map(p => `${p.verdict}(${p.master}/${p.media} ${p.magic || ''} ${p.variants || ''})`).join(' | '));
    }
  }

  // 2. local stellarrip (every other round)
  if (plan.local) {
    const cards = await getStreams(plan.st.tmdb, 'movie');
    rec.local = { title: plan.st.label, cards: cards.length };
    console.log(`local stellar ${plan.st.label}: ${cards.length} cards`);
    if (cards.length) {
      rec.local.samples = cards.slice(0, 2).map(c => ({ name: c.name, quality: c.quality }));
      rec.local.probes = [];
      for (const c of cards.slice(0, 2)) rec.local.probes.push(await playprobe('local-' + plan.st.label, c));
      console.log('  probes:', rec.local.probes.map(p => `${p.verdict}(${p.master}/${p.media} ${p.magic || ''})`).join(' | '));
    }
  }

  // 3. acer cache-fill
  {
    const t0 = Date.now();
    const r = await jfetch(`${BASE}/debug/source/acermovies?type=movie&id=tmdb:${plan.acer.tmdb}`, {}, 60000);
    const cards = r.j?.streams || [];
    const logs = (r.j?.logs || []).join(' | ');
    rec.acer = {
      title: plan.acer.label, cards: cards.length, ms: Date.now() - t0,
      cooldown: /cooldown/i.test(logs),
      samples: cards.slice(0, 2).map(c => ({ name: c.name, quality: c.quality, url: (c.url || '').slice(0, 80) })),
    };
    console.log(`acer ${plan.acer.label}: ${cards.length} cards in ${rec.acer.ms}ms${rec.acer.cooldown ? ' [COOLDOWN]' : ''}${cards.length ? ' → fallback cache FILLED' : ''}`);
  }

  state.rounds.push(rec);
  saveState(state);

  if (k < rounds - 1 && !skipSleep && idx + 1 < PLAN.length) {
    console.log(`(sleeping 150s before next round)`);
    await sleep(150000);
  }
}

// summary on final chunk
if (offset + rounds >= PLAN.length) {
  console.log('\n===== TASK 83 MONITOR SUMMARY =====');
  for (const r of state.rounds) {
    const st = r.st.cards > 0 ? `STELLAR-HIT ${r.st.cards} cards [${(r.st.probes || []).map(p => p.verdict).join(',')}]` : 'stellar dark';
    const loc = r.local ? (r.local.cards > 0 ? ` local-HIT ${r.local.cards} [${(r.local.probes || []).map(p => p.verdict).join(',')}]` : ' local dark') : '';
    const ac = r.acer.cards > 0 ? ` acer-FILL ${r.acer.title}=${r.acer.cards}` : (r.acer.cooldown ? ` acer-cooldown ${r.acer.title}` : ` acer-empty ${r.acer.title}`);
    console.log(`r${r.round} ${r.at.slice(11, 19)}Z: ${st}${loc} |${ac}`);
  }
  const stHits = state.rounds.filter(r => r.st.cards > 0).length;
  const locHits = state.rounds.filter(r => r.local?.cards > 0).length;
  const acerFills = state.rounds.filter(r => r.acer.cards > 0).length;
  console.log(`\ntotals: prod stellar hits ${stHits}/${state.rounds.length} | local hits ${locHits} | acer cache-fill ${acerFills}/${state.rounds.length}`);
}
