// Task 72: retest cineby + videasy under Render-free-tier-spec sandbox
// Phases:
//   [A] direct upstream probes (network, no CPU) — seed + a provider server + moon CDN
//   [B] local server UNDER THROTTLE (0.1 CPU / 448MB heap) — /debug/source cineby & videasy
//   [C] production (real Render free tier) — same calls, same titles
const BASE = process.env.BASE || 'http://127.0.0.1:7070';
const PROD = 'https://ignatiusphoenix.onrender.com';
const jget = async (u, t = 90000) => {
  const t0 = Date.now();
  const r = await fetch(u, { signal: AbortSignal.timeout(t) });
  const j = await r.json();
  return { j, ms: Date.now() - t0 };
};

const DUNE = 'tmdb:693134'; // Dune: Part Two
const SQUID = 'tmdb:93405:1:1'; // Squid Game S1E1

console.log('=== [A] direct upstream probes (sandbox network, full speed) ===');
{
  const H = { 'Origin': 'https://www.vidking.net', 'Referer': 'https://www.vidking.net/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept': 'application/json' };
  const probe = async (name, url, headers = H) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      const body = (await r.text()).slice(0, 120).replace(/\s+/g, ' ');
      console.log(`  ${name}: ${r.statusCode || r.status} in ${Date.now() - t0}ms | ${body}`);
    } catch (e) { console.log(`  ${name}: ERR ${Date.now() - t0}ms ${e.message}`); }
  };
  await probe('seed Dune2  ', 'https://api.speedracelight.com/seed?mediaId=693134');
  // videasy-style provider server (Hydrogen) — movie endpoints
  await probe('Hydrogen     ', 'https://api.speedracelight.com/movie/693134?server=Hydrogen');
  // cineby-style provider server (Yoru)
  await probe('Yoru         ', 'https://api.speedracelight.com/movie/693134?server=Yoru');
  // moon CDN (videasy stream host — Task 71: 403 WAF)
  await probe('moon CDN     ', 'https://moon.ironwallnet.net/', { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.vidking.net/' });
}

console.log('=== [B] local server UNDER RENDER-SPEC THROTTLE (0.1 CPU, 448MB heap) ===');
for (const [src, id, label] of [['cineby', DUNE, 'Dune2 movie'], ['videasy', DUNE, 'Dune2 movie'], ['cineby', SQUID, 'SquidGame S1E1'], ['videasy', SQUID, 'SquidGame S1E1']]) {
  const { j, ms } = await jget(`${BASE}/debug/source/${src}?type=${id.includes(':') && id.split(':').length > 2 ? 'series' : 'movie'}&id=${id}`);
  console.log(`  ${src} ${label}: count=${j.count} in ${ms}ms (self-reported ${j.durationMs}ms)`);
  (j.logs || []).filter(l => /seed|decrypt|error|fail|Server|Returned|streams/i.test(l)).slice(0, 6).forEach(l => console.log('    |', l.slice(0, 150)));
}

console.log('=== [C] production (real Render free tier) ===');
for (const [src, id, label] of [['cineby', DUNE, 'Dune2 movie'], ['videasy', DUNE, 'Dune2 movie']]) {
  try {
    const { j, ms } = await jget(`${PROD}/debug/source/${src}?type=movie&id=${id}`);
    console.log(`  ${src} ${label}: count=${j.count} in ${ms}ms (self ${j.durationMs}ms)`);
    (j.logs || []).slice(0, 4).forEach(l => console.log('    |', l.slice(0, 150)));
  } catch (e) { console.log(`  ${src}: ERR ${e.message}`); }
}
