// Task 71: comprehensive production audit
// 1. Per-source sweep via /debug/source (real scrapes, bypasses caches)
// 2. Label verification: sourceLabel vs registered label; quality-label vs height
// 3. Merged /stream E2E: counts, 4K, html URLs, subtitles, badge correctness
// 4. Manifest/env sanity
const BASE = process.env.PROD_BASE || 'https://ignatiusphoenix.onrender.com';

// id → expected label (extracted from src/source/*.js this.label assignments)
const LABELS = {
  '4khdhub': '4KHDHub', fourkhdhubone: '4KHDHub.one', cinefreak: 'CineFreak',
  moviebox: 'MovieBox', cinewave: 'CineWave', watchseries: 'WatchSeries',
  necro: 'Necro', vidsrcsbs: 'VidSrcSbs', vidlink2: 'VidLink', vidking: 'VidKing',
  vidfast: 'VidFast', vegamovies: 'VegaMovies', vegamovies2: 'VegaMovies Direct',
  primeshows: 'PrimeShows', netlio: 'Netlio', animeflix: 'AnimeFlix',
  anineko: 'AniNeko', verhdlink: 'VerHdLink', meinecloud: 'MeineCloud',
  acermovies: 'AcerMovies', streamxtv: 'StreamXTV', anikoto: 'Anikoto',
  anikage: 'AniKage', anibd: 'AniBD', '2dhive': '2Dhive', anidoor: 'AniDoor',
  nowhdtime: 'NowHDTime', pantyflix: 'Pantyflix', animegg: 'AnimeGG',
  peckle: '2Peckle', hianime: 'HiAnime', animekai: 'AnimeKai', cineby: 'Cineby',
  hindmoviez: 'HindMoviez', playimdb: 'PlayIMDb', movieblast: 'MovieBlast',
  zxcstream: 'ZXCStream', animezey: 'AnimeZeY', uhdmovies: 'UHDMovies',
  videasy: 'VidEasy', anikototv: 'AnikotoTV', animeworldindia: 'AnimeWorld IN',
  animesdigital: 'AnimesDigital', itachi: 'Itachi', imdbplay: 'IMDBPlay',
  raflix: 'Raflix', hindmovie: 'HindMovie', rivestream: 'RiveStream',
  reanime: 'ReAnime', desiflix: 'DesiFlix', persianstremio: 'PersianStremio',
  anichan: 'AniChan', animesuge: 'AnimeSuge', animotvslash: 'AniMoTVSlash',
  bollyflix: 'BollyFlix', framextv: 'FrameX', cinejoyaio: 'CineJoy',
  nikastream: 'NikaStream', cinebyrocks: 'CinebyRocks', stellarrip: 'StellarRip',
  stellar: 'Stellar', hdhub4uv2: 'HDHub4u', movieshuntv2: 'MoviesHunt',
  moviesdrivev2: 'MoviesDrive', cinehdplus: 'CineHDPlus', vidzee: 'VidZee',
  vixsrc: 'VixSrc', allwish: 'AllWish', videasyto: 'Videasy.to',
  kmmovies: 'KMMovies', atlantic: 'Atlantic', movielinkbd: 'MovieLinkBD',
};
const ANIME_ONLY = new Set(['animeflix','anineko','anikoto','anikage','anibd','2dhive','anidoor','animegg','hianime','animekai','animesdigital','itachi','anikototv','animezey','animotvslash','allwish','animesuge','reanime','nikastream','anichan']);
const MOVIE_ID = 'tmdb:693134';   // Dune: Part Two
const SERIES_ID = 'tmdb:93405:1:1'; // Squid Game S1E1
const ANIME_ID = 'tmdb:95479:1:1';  // Jujutsu Kaisen S1E1

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function jget(path, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, { signal: ac.signal, headers: { 'accept': 'application/json' } });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; }
    catch { return { status: res.status, json: null, text: text.slice(0, 200) }; }
  } catch (e) {
    return { status: 0, error: e?.message || String(e) };
  } finally { clearTimeout(t); }
}

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return '(invalid)'; } };
const isHtmlUrl = (u) => {
  if (!u) return false;
  const low = u.toLowerCase();
  if (low.endsWith('.html') || low.endsWith('.htm')) return true;
  // known player-page classes (allowed ONLY for zxcstream externalUrl)
  return /\/player\//.test(low) && !/\.m3u8|\.mp4|\.mkv/.test(low);
};

// ─────────────────────────────────────────────────────────────
const PHASES = (process.env.PHASES || '1,2,1b,3').split(',');
console.log('=== PHASE 4a: sanity (manifest/env) ===');
const [man, env] = await Promise.all([jget('/manifest.json', 20000), jget('/debug/env', 20000)]);
console.log('manifest:', man.json ? `${man.json.name} v${man.json.version} resources=${JSON.stringify(man.json.resources)}` : `HTTP ${man.status} ${man.text || man.error || ''}`);
console.log('env:', env.json ? JSON.stringify(env.json) : `HTTP ${env.status}`);

// ─────────────────────────────────────────────────────────────
console.log('\n=== PHASE 1: per-source sweep ===');
const ids = Object.keys(LABELS);
const probes = [];
for (const id of ids) {
  if (ANIME_ONLY.has(id)) probes.push({ id, type: 'series', rid: ANIME_ID, label: 'anime' });
  else if (id === 'uhdmovies' || id === 'verhdlink' || id === 'acermovies' || id === 'meinecloud' || id === 'mostraguarda') probes.push({ id, type: 'movie', rid: MOVIE_ID, label: 'movie' });
  else if (id === 'cinehdplus' || id === 'animezey' || id === 'anikototv' || id === 'animesdigital') probes.push({ id, type: 'series', rid: SERIES_ID === SERIES_ID && ANIME_ONLY.has(id) ? ANIME_ID : SERIES_ID, label: 'series' });
  else probes.push({ id, type: 'movie', rid: MOVIE_ID, label: 'movie' });
}
// anime-only sources that ALSO declared series get the anime probe; non-anime
// series-capable sources get a series probe too (second pass below)

const results = new Map();
async function probeOne(p) {
  const t0 = Date.now();
  const r = await jget(`/debug/source/${p.id}?type=${p.type}&id=${p.rid}`, 55000);
  const dt = Date.now() - t0;
  const out = { probe: p, dt, resp: r.json, status: r.status };
  results.set(p.id + ':' + p.type, out);
  const c = r.json?.count ?? (r.json?.timedOut ? 'TIMEOUT' : `ERR${r.status}`);
  console.log(`[${p.label}] ${p.id} → count=${c} ${(r.json?.durationMs ?? dt) + 'ms'}${r.json?.error ? ' error=' + String(r.json.error).slice(0, 80) : ''}`);
}
// concurrency 3, keep order-ish
if (PHASES.includes('1')) {
const queue = [...probes];
const workers = Array.from({ length: 3 }, async () => {
  while (queue.length) {
    const p = queue.shift();
    await probeOne(p);
    await sleep(300);
  }
});
await Promise.all(workers);
} else { console.log('(phase 1 skipped)'); }

// ─────────────────────────────────────────────────────────────
console.log('\n=== PHASE 2: label + quality verification (per-source cards) ===');
const labelIssues = [], qualityIssues = [], htmlIssues = [];
for (const [key, out] of results) {
  const id = out.probe.id;
  const cards = out.resp?.results || [];
  for (const c of cards) {
    const sl = c.meta?.sourceId || c.meta?.sourceLabel;
    const url = c.url || c.externalUrl || '';
    if (c.meta?.sourceLabel && c.meta.sourceLabel !== LABELS[id]) {
      labelIssues.push(`${id}: card sourceLabel="${c.meta.sourceLabel}" != registered "${LABELS[id]}"`);
    }
    if (c.meta?.sourceId && c.meta.sourceId !== id) {
      labelIssues.push(`${id}: card sourceId="${c.meta.sourceId}" != probe source "${id}"`);
    }
    if (isHtmlUrl(url) && !(c.externalUrl && id === 'zxcstream')) {
      htmlIssues.push(`${id}: html-ish url ${url.slice(0, 100)}`);
    }
    const t = (c.meta?.title || '').toLowerCase();
    const h = c.meta?.height || 0;
    if (h >= 2160 && !/2160|4k/.test(t)) qualityIssues.push(`${id}: height=2160 but title lacks 4K/2160: "${(c.meta?.title||'').slice(0,90)}"`);
    if (h > 0 && h < 2160 && /2160p|\b4k\b/.test(t) && !/1080p/.test(t)) qualityIssues.push(`${id}: title says 4K/2160p but height=${h}: "${(c.meta?.title||'').slice(0,90)}"`);
  }
}
if (!PHASES.includes('2')) { console.log('(phase 2 skipped)'); }
else {
console.log(`label issues: ${labelIssues.length}`); labelIssues.slice(0, 20).forEach(x => console.log('  ⚠ ' + x));
console.log(`quality-label issues (sampled cards): ${qualityIssues.length}`); qualityIssues.slice(0, 20).forEach(x => console.log('  ⚠ ' + x));
console.log(`html-url issues (sampled cards): ${htmlIssues.length}`); htmlIssues.slice(0, 10).forEach(x => console.log('  ⚠ ' + x));
}

// ─────────────────────────────────────────────────────────────
console.log('\n=== PHASE 1b: series pass for non-anime series-capable sources ===');
const seriesCapable = ids.filter(id => !ANIME_ONLY.has(id) && !['uhdmovies','verhdlink','acermovies','meinecloud','cinehdplus'].includes(id));
const q2 = [...seriesCapable];
const results2 = new Map();
async function probeOne2(id) {
  const r = await jget(`/debug/source/${id}?type=series&id=${SERIES_ID}`, 55000);
  results2.set(id, r.json);
  const c = r.json?.count ?? (r.json?.timedOut ? 'TIMEOUT' : `ERR${r.status}`);
  console.log(`[series] ${id} → count=${c} ${(r.json?.durationMs ?? '') + 'ms'}${r.json?.error ? ' error=' + String(r.json.error).slice(0, 80) : ''}`);
}
if (PHASES.includes('1b')) {
const workers2 = Array.from({ length: 3 }, async () => {
  while (q2.length) { const id = q2.shift(); await probeOne2(id); await sleep(300); }
});
await Promise.all(workers2);
} else { console.log('(phase 1b skipped)'); }

// ─────────────────────────────────────────────────────────────
console.log('\n=== PHASE 3: merged /stream end-to-end ===');
async function mergedRound(path, rounds = 2) {
  const roundsOut = [];
  for (let i = 1; i <= rounds; i++) {
    const t0 = Date.now();
    const r = await jget(path, 120000);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const streams = r.json?.streams || [];
    const cards = streams.map(s => {
      const url = s.url || s.externalUrl || '';
      return {
        url, external: !!s.externalUrl,
        name: s.name || '', title: s.title || '',
        subs: (s.subtitles || []).length,
        notWebReady: s.behaviorHints?.notWebReady, proxied: /\/proxy|\/range-proxy|\/reanime-proxy/.test(url),
      };
    });
    const html = cards.filter(c => isHtmlUrl(c.url) && !(c.external && c.name.includes('ZXC'))).length;
    const fourK = cards.filter(c => /· 4K/.test(c.name) || /2160p/.test(c.title)).length;
    const withSubs = cards.filter(c => c.subs > 0).length;
    const ext = cards.filter(c => c.external).length;
    console.log(`  round ${i}: ${streams.length} cards @${dt}s | 4K-badge=${fourK} | html=${html} | external=${ext} | subs ${withSubs}/${cards.length}`);
    roundsOut.push({ streams: cards, dtSec: Number(dt) });
  }
  return roundsOut;
}

// NOTE: badge distribution done separately below (typo guard)
function badgeDistribution(cards) {
  const known = new Set(Object.values(LABELS).map(x => x.toLowerCase()));
  const dist = new Map(); const unknown = [];
  for (const c of cards) {
    const parts = (c.name || '').split('·').map(x => x.trim());
    // parts: ['🐦‍🔥 PhoeniX', quality?, label?, sub?...]
    const labelPart = parts.find(p => p && !p.includes('PhoeniX') && !/^\d{3,4}p$/.test(p) && p !== '4K' && p !== '📥' && !p.includes('external'));
    if (labelPart) {
      const k = labelPart;
      dist.set(k, (dist.get(k) || 0) + 1);
      if (!known.has(k.toLowerCase()) && !k.includes('·')) unknown.push(k);
    }
  }
  return { dist, unknown };
}

let dune = [], squid = [], jjk = [];
if (PHASES.includes('3')) {
console.log('Dune: Part Two (movie):');
dune = await mergedRound(`/stream/movie/${MOVIE_ID}.json`, 2);
console.log('Squid Game S1E1 (series):');
squid = await mergedRound(`/stream/series/${SERIES_ID}.json`, 2);
console.log('JJK S1E1 (anime):');
jjk = await mergedRound(`/stream/series/${ANIME_ID}.json`, 1);
} else { console.log('(phase 3 skipped)'); }

console.log('\n=== PHASE 3b: merged badge distribution + unknown labels ===');
const lastDune = (dune[dune.length - 1] || { streams: [] }).streams;
const lastSquid = (squid[squid.length - 1] || { streams: [] }).streams;
const lastJjk = (jjk[0] || { streams: [] }).streams;
for (const [name, cards] of [['Dune', lastDune], ['SquidGame', lastSquid], ['JJK', lastJjk]]) {
  const { dist, unknown } = badgeDistribution(cards);
  console.log(`${name}: badges →`, [...dist.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', '));
  if (unknown.length) console.log(`  ⚠ unknown badge labels: ${[...new Set(unknown)].join(' | ')}`);
}

console.log('\n=== PHASE 3c: 4K spot-check (Dune final round) ===');
const dune4k = lastDune.filter(c => /· 4K/.test(c.name));
console.log(`4K cards: ${dune4k.length}`);
dune4k.slice(0, 8).forEach(c => console.log(`  ${c.name} | ${c.title.slice(0, 100)} | ${hostOf(c.url)}`));
console.log('\n=== AUDIT DONE ===');

console.log('\n=== SAVE ===');
const dump = { ts: new Date().toISOString(), base: BASE, perSource: Object.fromEntries([...results.entries(), ...[...results2.entries()].map(([k, v]) => [k + ':series', { probe: { id: k, type: 'series' }, resp: v }])]), merged: { dune, squid, jjk } };
console.log('dump size:', JSON.stringify(dump).length, 'bytes (not persisted; console only)');
