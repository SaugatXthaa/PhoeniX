// task23_baseline.mjs — rebuilt consolidated regression (final_regression.mjs +
// decrypt suite were working-tree-only in old sessions, never committed, lost).
//
// Three parts:
//   A. Decrypt self-tests (pure crypto, no network) — stream-decrypt.cjs +
//      megaplay_decrypt.cjs round-trips and known vectors.
//   B. videasyto direct-scraper probe — wall-time + HLS magic byte check on a
//      FULL url (the /debug/source endpoint truncates urls at 150 chars).
//   C. Addon boot regression on TEST_PORT (4596): boot counts, merged movie /
//      series catalogs, removed-source leakage check, /proxy 206 MKV check.
//
// Usage: node scripts/task23_baseline.mjs

import { spawn } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const require_ = createRequire(import.meta.url);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; failures.push(name + (detail ? ` (${detail})` : '')); console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
}

// ============================================================
// PART A — decrypt self-tests
// ============================================================
async function partA() {
  console.log('\n=== PART A: decrypt module self-tests ===');
  const mp = require_(path.join(REPO, 'src/nuvio/megaplay_decrypt.cjs'));
  const sd = require_(path.join(REPO, 'src/utils/stream-decrypt.cjs'));

  // A1. megaplay AES-256-CBC round-trip using the SHIPPED constants
  //     (extracted from the module source so the test always reflects reality)
  const mpSrc = fs.readFileSync(path.join(REPO, 'src/nuvio/megaplay_decrypt.cjs'), 'utf8');
  const keyRaw = mpSrc.match(/MP_AES_KEY_RAW = (["'])(.+?)\1/)[2];
  const ivRaw = mpSrc.match(/MP_AES_IV_RAW = (["'])(.+?)\1/)[2];
  const key = Buffer.concat([Buffer.from(keyRaw, 'utf8'), Buffer.alloc(16, 0)]);
  const iv = Buffer.from(ivRaw, 'utf8');
  const payload = { file: 'https://moon.peakstorm.top/vd/test123/master.m3u8', h: 'abc' };
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  const enc = ct.toString('base64url');
  const dec = mp.decryptMegaplayEnc(enc);
  check('megaplay AES round-trip', !!dec && dec.file === payload.file, dec?.file?.slice(0, 50));
  check('megaplay rejects garbage', mp.decryptMegaplayEnc('not-valid-base64!!') === null);
  check('megaplay rejects random b64', mp.decryptMegaplayEnc(Buffer.from('random junk bytes here').toString('base64url')) === null);

  // A2. xorDecrypt round-trip
  const key2 = Buffer.from([0x5a, 0xa5, 0x01, 0xff]);
  const buf = Buffer.from('hello plaintext stream url 12345', 'utf8');
  const xored = Buffer.from(buf.map((b, i) => b ^ key2[i % key2.length]));
  check('xorDecrypt round-trip', sd.xorDecrypt(xored, key2).equals(buf));

  // A3. base64DecodeStrict
  const b64out = sd.base64DecodeStrict(Buffer.from('round-trip-data').toString('base64'));
  check('base64DecodeStrict round-trip', String(b64out) === 'round-trip-data', `type=${typeof b64out}`);
  check('base64DecodeStrict rejects invalid', sd.base64DecodeStrict('!!!not-base64!!!') === null);
  check('base64DecodeStrict rejects short', sd.base64DecodeStrict('abc=') === null);
  check('base64DecodeStrict non-string null', sd.base64DecodeStrict(12345) === null);

  // A4. verifyMpegTs on synthetic TS packet (0x47 sync byte + 187 more)
  const tsPacket = Buffer.concat([Buffer.from([0x47, 0x40, 0x00, 0x10]), Buffer.alloc(184, 0x00)]);
  const tsBuf = Buffer.concat(Array(8).fill(tsPacket));
  const tsOk = sd.verifyMpegTs(tsBuf);
  check('verifyMpegTs accepts synthetic TS', tsOk && tsOk.valid === true && tsOk.checked === 8, `checked=${tsOk?.checked}`);
  const tsBad = sd.verifyMpegTs(Buffer.alloc(1024, 0x00));
  check('verifyMpegTs rejects junk', tsBad && tsBad.valid === false, `checked=${tsBad?.checked}`);
  check('verifyMpegTs rejects short buffer', sd.verifyMpegTs(Buffer.alloc(100, 0x47)).valid === false);

  // A5. image-disguise detection + stripping
  const webpHdr = Buffer.concat([Buffer.from('RIFF'), u32(0x999), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 0x11)]);
  const pngHdr = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 0x22)]);
  check('isWebPDisguise', sd.isWebPDisguise(webpHdr) === true);
  check('isPngDisguise', sd.isPngDisguise(pngHdr) === true);
  check('stripFakeImageHeader webp', sd.stripFakeImageHeader(webpHdr).length < webpHdr.length);
  check('stripFakeImageHeader plain untouched', sd.stripFakeImageHeader(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.alloc(28)])).length === 32);

  // A6. sha256Hex known vector
  check('sha256Hex known vector', sd.sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  // A7. aes256CbcDecrypt round-trip
  const k32 = crypto.randomBytes(32), iv16 = crypto.randomBytes(16);
  const c2 = crypto.createCipheriv('aes-256-cbc', k32, iv16);
  const ct2 = Buffer.concat([c2.update('secret-payload', 'utf8'), c2.final()]);
  check('aes256CbcDecrypt round-trip', sd.aes256CbcDecrypt(k32, iv16, ct2) === 'secret-payload');

  // A8. deriveAesKeyChain determinism + length
  const kA = sd.deriveAesKeyChain({ secret: 's1', seed: 'seed1', iterations: 1000, keyLen: 32, digest: 'sha256' });
  const kB = sd.deriveAesKeyChain({ secret: 's1', seed: 'seed1', iterations: 1000, keyLen: 32, digest: 'sha256' });
  check('deriveAesKeyChain deterministic', Buffer.compare(kA, kB) === 0 && kA.length === 32);

  // A9. deriveFieldNames determinism
  const fA = JSON.stringify(sd.deriveFieldNames('seedX'));
  const fB = JSON.stringify(sd.deriveFieldNames('seedX'));
  check('deriveFieldNames deterministic', fA === fB && fA.length > 2);

  // A10. parseXorKeyParam — must not throw on odd input; exact format from source
  let noThrow = true, out = null;
  try { out = sd.parseXorKeyParam('5aa501ff'); } catch { noThrow = false; }
  check('parseXorKeyParam no-throw hex', noThrow, `out=${out === null ? 'null' : 'parsed'}`);
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

// ============================================================
// PART B — videasyto direct-scraper probe (full URL, timing)
// ============================================================
async function partB() {
  console.log('\n=== PART B: videasyto direct scraper (F1 tmdb:911430) ===');
  // Task 73: network-aware gate — videasy.to's backend 403/503-blocks this
  // sandbox network on documented occasions (device-IP/WAF class, measured
  // Sep 2026: player.videasy.net 403 to datacenter egress while videasy.to
  // DNS is dead from some networks). That is an upstream-class condition,
  // not a code regression — classify it instead of failing the suite.
  let vtoReachable = true;
  try {
    const pr = await fetch('https://videasy.to/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131' }, signal: AbortSignal.timeout(12000) });
    if (pr.status >= 400) vtoReachable = false;
  } catch { vtoReachable = false; }
  if (!vtoReachable) {
    console.log('  (info) videasy.to unreachable from this network (WAF/device-IP class) — skipping Part B without failing the suite');
    return;
  }
  const mod = require_(path.join(REPO, 'src/nuvio/videasyto.cjs'));
  const t0 = Date.now();
  let streams = [];
  try { streams = await mod.getStreams('911430', 'movie', null, null); }
  catch (e) { check('videasyto getStreams no-throw', false, e.message); return; }
  const wall = Date.now() - t0;
  check('videasyto wall time <= 16s', wall <= 16000, `${wall}ms (was 127s pre-Task22)`);
  check('videasyto stream count >= 3', streams.length >= 3, `count=${streams.length}`);
  const has4K = streams.some(s => s._is4k === true || /2160|4k/i.test(String(s.quality || '') + String(s.title || '')));
  check('videasyto includes 4K (2160p)', has4K, `qualities=${streams.map(s => String(s.quality || '').match(/\d+p/)?.[0]).filter(Boolean).join(',')}`);

  // full-URL HLS magic check (debug endpoint truncates at 150 chars).
  // Individual CDN nodes (moon.peakstorm.top, vimeos.zip) intermittently 403
  // datacenter IPs while sibling nodes serve fine — probe up to 3 candidates,
  // PASS if ANY carries the HLS magic (matches real player behavior).
  const hlsCands = streams.filter(s => /\.m3u8($|\?)/.test(s.url || '') || (s.format || '').toUpperCase().includes('HLS'));
  const hlsPool = (hlsCands.length ? hlsCands : streams).slice(0, 3);
  let hlsOk = false, hlsDetail = 'no url returned';
  for (const hls of hlsPool) {
    if (!hls?.url) continue;
    try {
      const res = await fetch(hls.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36', Referer: 'https://videasy.to/' }, signal: AbortSignal.timeout(12000) });
      const body = await res.text();
      const ok = res.status === 200 && (body.includes('#EXTM3U') || body.includes('#EXT-X'));
      hlsDetail = `status=${res.status} len=${body.length} host=${new URL(hls.url).host}`;
      if (ok) { hlsOk = true; break; }
    } catch (e) { hlsDetail = e.message.slice(0, 60); }
  }
  check('videasyto full-URL HLS magic', hlsOk, hlsDetail);
}

// ============================================================
// PART C — addon boot + merged catalogs + leakage + proxy 206
// ============================================================
const TEST_PORT = 4596;
function partC() {
  return new Promise(resolve => {
    console.log(`\n=== PART C: boot regression on :${TEST_PORT} ===`);
    const logFile = `/tmp/task23_boot_${TEST_PORT}.log`;
    const child = spawn('node', ['src/index.js'], { cwd: REPO, env: { ...process.env, PORT: String(TEST_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const logStream = fs.createWriteStream(logFile);
    child.stdout.pipe(logStream); child.stderr.pipe(logStream);
    let bootLines = '';
    const onLine = d => { bootLines += d; };
    child.stdout.on('data', onLine); child.stderr.on('data', onLine);

    const deadline = Date.now() + 30000;
    const waitBoot = setInterval(() => {
      if (bootLines.includes('Extractors:') || Date.now() > deadline) {
        clearInterval(waitBoot);
        // The 'Extractors:' log line only means source registration printed —
        // under CPU contention the HTTP listener can still be momentarily
        // unready, which produced fast-failing fetches (false UNHEALTHY).
        // Poll /health until it answers, then run checks.
        waitHealthy(30000)
          .then(() => runChecks(child, logFile, bootLines))
          .then(resolve)
          .catch(e => { console.log('PART C error:', e.message); resolve(); });
      }
    }, 500);

    async function waitHealthy(budgetMs) {
      const end = Date.now() + budgetMs;
      while (Date.now() < end) {
        try {
          const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`, { signal: AbortSignal.timeout(3000) });
          if (res.ok) return;
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
      }
      console.log('  (warn) /health poll budget exhausted — proceeding anyway');
    }
  });
}

async function runChecks(child, logFile, bootLines) {
  const srcM = bootLines.match(/Sources: (\d+)/);
  const extM = bootLines.match(/Extractors: (\d+)/);
  // Task 28: 69 → 70 — AniMoTVSlash (animotvslash.org) registered
  // Task 38: 70 → 71 — CineFreak revived (cinefreak.net, search-api + cinecloud)
  // Task 48: 71 → 72 — Atlantic (atlantic.st RE: Aphrodite gate + Artemis)
  // Task 50: 72 → 70 — dahmermovies + dahmermovies4k removed (user request)
  // Task 58: 70 → 71 — MovieLinkBD (movielinkbd.net RE: WP API + KiteCloud)
  // Task 66: 71 → 72 — MovieBlast re-port (orig parity; Task 19 had deleted it)
  // Task 77: 72 → 73 — Antarctica (comet.feels.legal + TorBox debrid cache)
  // Task 85: 73 → 70 — animeworldindia + anineko + stellarrip removed
  //   (user request; evidence-locked dead upstreams, Task 83/84)
  // Task 85c: 70 → 69 — antarctica removed (user request; source + provider
  //   deleted, was the wave-0 50-card TorBox-cache source)
  check('boot source count = 69', srcM && srcM[1] === '69', `got ${srcM?.[1]}`);
  // Task 25: 30 → 31 — VidZee extractor registered (ported file existed but
  // was never wired into createExtractors; vidzee source shipped 0 streams).
  // Task 28: 31 → 32 — MixDrop extractor (verhdlink mixdrop mirrors → direct MP4)
  // Task 30: 32 → 33 — VidSrcMe extractor (necro vidsrc.me chain unlock)
  check('boot extractor count = 33', extM && extM[1] === '33', `got ${extM?.[1]}`);

  // removed-source leakage at registry level
  // Task 66: movieblast was RE-PORTED by design (orig parity, delivers) —
  // only anidb/flystream must stay absent.
  const srcLine = bootLines.match(/Sources: \d+ \(([^)]*)\)/)?.[1] || '';
  const ids = srcLine.split(',').map(s => s.trim());
  check('movieblast re-ported (Task 66) + no anidb/flystream in registry', ids.includes('movieblast') && !ids.includes('anidb') && !ids.includes('flystream'));
  // Task 50: dahmermovies + dahmermovies4k removed (user request) — must not
  // appear in the registry NOR leak into any catalog stream title/url.
  check('no dahmermovies/dahmermovies4k in registry', !ids.includes('dahmermovies') && !ids.includes('dahmermovies4k'));
  // Task 85: animeworldindia + anineko + stellarrip removed (user request,
  // evidence-locked dead upstreams) — must not reappear in the registry.
  check('no animeworldindia/anineko/stellarrip in registry', !ids.includes('animeworldindia') && !ids.includes('anineko') && !ids.includes('stellarrip'));
  // Task 85c: antarctica removed (user request) — must not reappear.
  check('no antarctica in registry', !ids.includes('antarctica'));

  // crash-class errors in boot log (upstream fetch noise during warmup excluded)
  const crashy = bootLines.split('\n').filter(l => /Cannot find module|SyntaxError|ReferenceError|TypeError|failed to load scraper/i.test(l));
  check('no crash-class boot errors', crashy.length === 0, crashy.slice(0, 2).join(' | ').slice(0, 90));

  const base = `http://127.0.0.1:${TEST_PORT}`;
  // Catalog fetches on a freshly booted instance can hit the resolver's 40s
  // global deadline and return starved/empty responses (documented in
  // src/index.js). One warm-cache retry after a short settle fixes false
  // negatives without masking real regressions (retry needs only ONE hit).
  const getCatalog = async (url, min) => {
    let j = await getJson(url, 150000);
    let n = j?.streams?.length || 0;
    if (n < min) {
      console.log(`  (info) ${url.split('/').pop()} returned ${n} — settling 15s, retrying once (cold-start starvation guard)`);
      await new Promise(r => setTimeout(r, 15000));
      const j2 = await getJson(url, 150000);
      const n2 = j2?.streams?.length || 0;
      if (n2 > n) { j = j2; n = n2; }
    }
    return { json: j, n };
  };
  // merged movie catalog (Endgame)
  const mv = await getCatalog(`${base}/stream/movie/tt4154796.json`, 90);
  check('Endgame merged movie count >= 90', mv.n >= 90, `count=${mv.n}`);
  // merged series catalog (Breaking Bad S1E1)
  const sr = await getCatalog(`${base}/stream/series/tt0903747:1:1.json`, 80);
  check('BreakingBad merged series count >= 80', sr.n >= 80, `count=${sr.n}`);
  // Task 24 matrix extension — anime catalogs
  const fr = await getCatalog(`${base}/stream/series/tmdb:209867:2:1.json`, 60);
  check('Frieren S2E1 merged (anime) count >= 60', fr.n >= 60, `count=${fr.n} (obs 108)`);
  const yn = await getCatalog(`${base}/stream/movie/tmdb:372058.json`, 70);
  check('Your Name merged (anime movie) count >= 70', yn.n >= 70, `count=${yn.n} (obs 120)`);

  // leakage in catalogs: stream titles/urls must not reference removed sources
  // Task 50: dahmer (covers both removed ids) + 111477.xyz (their CDN host)
  const leakRe = /movieblast|moviesblast|flystream|\banidb\b|dahmer|111477\.xyz/i;
  const leaked = [...(mv.json?.streams || []), ...(sr.json?.streams || []), ...(fr.json?.streams || []), ...(yn.json?.streams || [])]
    .filter(s => leakRe.test(s.title || '') || leakRe.test(s.url || ''));
  check('no removed-source leakage in catalogs', leaked.length === 0, `${leaked.length} hits`);

  // /proxy 206 MKV range check — find a direct (non-m3u8) video URL in catalogs
  const allStreams = [...(mv.json?.streams || []), ...(sr.json?.streams || [])];
  const direct = allStreams.filter(s => {
    const u = s.url || '';
    return /^https?:\/\//.test(u) && !/\.m3u8($|\?)/i.test(u) && !/\/proxy\?/.test(u);
  });
  let proxyOk = false, proxyDetail = 'no direct candidate';
  for (const cand of direct.slice(0, 4)) {
    try {
      const res = await fetch(`${base}/proxy?url=${encodeURIComponent(cand.url)}`, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20000) });
      const head = Buffer.from(await res.arrayBuffer()).subarray(0, 4);
      const ebml = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
      if ((res.status === 206 || res.status === 200) && ebml) { proxyOk = true; proxyDetail = `status=${res.status} EBML ok via ${new URL(cand.url).host}`; break; }
      proxyDetail = `status=${res.status} magic=${head.toString('hex')}`;
    } catch (e) { proxyDetail = e.message.slice(0, 60); }
  }
  check('/proxy 206 MKV EBML range check', proxyOk, proxyDetail);

  // ─── Part D: source-level regression guards (Task 24) ───
  console.log('\n=== PART D: source-level guards (via /debug/source) ===');
  // moviesdrivev2 matcher guard: search.php died upstream; the Task 24
  // wp-json + scored-matcher fix must keep returning F1 streams
  const md = await getJson(`${base}/debug/source/moviesdrivev2?type=movie&id=tmdb:911430`, 45000);
  let mdCount = md?.count ?? 0;
  if (mdCount < 3) { await new Promise(r => setTimeout(r, 10000)); const md2 = await getJson(`${base}/debug/source/moviesdrivev2?type=movie&id=tmdb:911430`, 45000); mdCount = Math.max(mdCount, md2?.count ?? 0); }
  check('moviesdrivev2 F1 >= 3 (Task 24 matcher guard)', mdCount >= 3, `count=${mdCount}`);
  // vegamovies2 standing check: new Task 24 source must keep resolving
  const vg = await getJson(`${base}/debug/source/vegamovies2?type=series&id=tmdb:108978:4:1`, 45000);
  let vgCount = vg?.count ?? 0;
  if (vgCount < 2) { await new Promise(r => setTimeout(r, 10000)); const vg2 = await getJson(`${base}/debug/source/vegamovies2?type=series&id=tmdb:108978:4:1`, 45000); vgCount = Math.max(vgCount, vg2?.count ?? 0); }
  check('vegamovies2 Reacher S4E1 >= 2 (new source guard)', vgCount >= 2, `count=${vgCount}`);
  // Task 38 guards: greenmotors-era 4khdhub sources + revived CineFreak.
  // Each gets one retry to absorb transient upstream windows (negative-cache
  // class) without failing the suite.
  const kf = await getJson(`${base}/debug/source/fourkhdhubone?type=movie&id=tmdb:27205`, 45000);
  let kfCount = kf?.count ?? 0;
  if (kfCount < 3) { await new Promise(r => setTimeout(r, 8000)); const kf2 = await getJson(`${base}/debug/source/fourkhdhubone?type=movie&id=tmdb:27205`, 45000); kfCount = Math.max(kfCount, kf2?.count ?? 0); }
  check('fourkhdhubone Inception >= 3 (greenmotors decode guard)', kfCount >= 3, `count=${kfCount}`);
  const kh = await getJson(`${base}/debug/source/4khdhub?type=movie&id=tmdb:27205`, 45000);
  let khCount = kh?.count ?? 0;
  if (khCount < 3) { await new Promise(r => setTimeout(r, 8000)); const kh2 = await getJson(`${base}/debug/source/4khdhub?type=movie&id=tmdb:27205`, 45000); khCount = Math.max(khCount, kh2?.count ?? 0); }
  check('4khdhub Inception >= 3 (greenmotors decode guard)', khCount >= 3, `count=${khCount}`);
  const cf = await getJson(`${base}/debug/source/cinefreak?type=movie&id=tmdb:27205`, 60000);
  let cfCount = cf?.count ?? 0;
  if (cfCount < 2) { await new Promise(r => setTimeout(r, 8000)); const cf2 = await getJson(`${base}/debug/source/cinefreak?type=movie&id=tmdb:27205`, 60000); cfCount = Math.max(cfCount, cf2?.count ?? 0); }
  check('cinefreak Inception >= 2 (revival guard)', cfCount >= 2, `count=${cfCount}`);
  // cineby guard (Task 40): clean rewrite of the cineby.by → vidking.net →
  // speedracelight chain. Yoru alone returns 4-5 Inception qualities (incl
  // 2160p); threshold 2 keeps the guard immune to single-server flakiness.
  const cb = await getJson(`${base}/debug/source/cineby?type=movie&id=tmdb:27205`, 60000);
  let cbCount = cb?.count ?? 0;
  if (cbCount < 2) { await new Promise(r => setTimeout(r, 8000)); const cb2 = await getJson(`${base}/debug/source/cineby?type=movie&id=tmdb:27205`, 60000); cbCount = Math.max(cbCount, cb2?.count ?? 0); }
  // Task 73: outage-aware — a definitive edge 5xx on /seed proves the
  // speedracelight API is down globally (Sep 2026 vidking outage class);
  // the guard then verifies the HONEST-ZERO + fast-fail behavior instead of
  // stream counts. When the API is alive, the original >= 2 threshold holds.
  let srlDown = false;
  try {
    const seedR = await fetch('https://api.speedracelight.com/seed?mediaId=27205', {
      headers: { 'Origin': 'https://www.vidking.net', 'Referer': 'https://www.vidking.net/', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    srlDown = seedR.status >= 500;
  } catch {
    // Task 77: a probe TIMEOUT is the same outage class as a 5xx — the seed
    // currently answers 522 (CF origin timeout) only after ~20s, so the old
    // catch→false misclassified the outage as "alive" and failed the >=2
    // check against an honest zero (measured: seed 522 @19.8s, vidking DNS
    // still dead). Timeout/abort ⇒ down.
    srlDown = true;
  }
  if (srlDown) {
    check('cineby honest-zero fast-fail while speedracelight down (Task 73)', cbCount === 0, `count=${cbCount} (upstream edge 5xx — outage class)`);
  } else {
    check('cineby Inception >= 2 (Task 40 rewrite guard)', cbCount >= 2, `count=${cbCount}`);
  }
  // atlantic guard (Task 48): atlantic.st RE — Orbit 2160p master validated
  // live before shipping. Threshold 1: Orbit master is the steady deliverer
  // (Aphrodite is curated and currently stub-degraded upstream).
  const at = await getJson(`${base}/debug/source/atlantic?type=movie&id=tmdb:27205`, 60000);
  let atCount = at?.count ?? 0;
  // Task 49: retry gap 8s → 20s. Part D runs right after the merged-catalog
  // checks — background continuations from 4 cold catalog resolves are still
  // churning the event loop, and atlantic (longest chain: resolve → master →
  // validate + 3 sub fetches) is the most contention-exposed source. Measured
  // today: 0 inside the churn window, healthy 1.7s standalone seconds later.
  if (atCount < 1) { await new Promise(r => setTimeout(r, 20000)); const at2 = await getJson(`${base}/debug/source/atlantic?type=movie&id=tmdb:27205`, 60000); atCount = Math.max(atCount, at2?.count ?? 0); }
  // Task 49: zone-weather SKIP — stellar.maybeoneday.ch Cloudflare-throttles
  // an egress IP that bursts the zone (documented in Task 48: triggers at
  // ~30+ req/hr, black-hole timeouts, self-heals in ~25-30min). A throttle
  // window fails artemis/aphrodite regardless of code correctness. Distinguish
  // weather from regression: only SKIP when a DIRECT upstream probe from this
  // same machine ALSO black-holes; a real code failure still FAILs.
  let atZoneDown = false;
  if (atCount < 1) {
    try {
      await fetch('https://stellar.maybeoneday.ch/resolve?tmdbId=27205&type=movie', { signal: AbortSignal.timeout(10000), headers: { Origin: 'https://atlantic.st', Referer: 'https://atlantic.st/' } });
    } catch { atZoneDown = true; }
  }
  if (atCount >= 1) check('atlantic Inception >= 1 (Task 48 RE guard)', true, `count=${atCount}`);
  else if (atZoneDown) console.log(`  [SKIP] atlantic guard — stellar.maybeoneday.ch black-holing this egress IP (Task 48 documented zone throttle, self-heals ~25-30min) count=${atCount}`);
  else check('atlantic Inception >= 1 (Task 48 RE guard)', atCount >= 1, `count=${atCount}`);
  // animotvslash standing check (Task 28): anime hardsub/softsub source.
  // One-shot guard with a retry — videas CDN intermittently hangs Range
  // probes from datacenter IPs; a single slow round must not fail the run.
  // Task 29: upstream enabled a site-wide Cloudflare managed challenge on ALL
  // non-wp-json routes (verified unpassable: got-scraping x3 fingerprints,
  // curl_cffi perfect TLS impersonation x4, headless Chromium, external
  // vantage). When the gate is active the guard reports EXTERNAL-GATE (skip,
  // not FAIL) so recovery stays visible without false-failing the suite.
  const am = await getJson(`${base}/debug/source/animotvslash?type=series&id=tmdb:209867:2:1`, 45000);
  let amCount = am?.count ?? 0;
  if (amCount < 2) { await new Promise(r => setTimeout(r, 10000)); const am2 = await getJson(`${base}/debug/source/animotvslash?type=series&id=tmdb:209867:2:1`, 45000); amCount = Math.max(amCount, am2?.count ?? 0); }
  let amGate = false;
  if (amCount < 2) {
    try { const g = await fetch('https://animotvslash.org/anime/frieren-beyond-journeys-end-season-2/', { signal: AbortSignal.timeout(12000) }); amGate = g.status === 403; } catch {}
  }
  if (amCount >= 2) check('animotvslash Frieren S2E1 >= 2 (Task 28 guard)', true, `count=${amCount}`);
  else if (amGate) console.log(`  [SKIP] animotvslash guard — upstream CF managed-challenge gate active (EXTERNAL, recovery auto-detects via this check) count=${amCount}`);
  else check('animotvslash Frieren S2E1 >= 2 (Task 28 guard)', false, `count=${amCount}`);
  // movielinkbd guard (Task 58 v2): movielinkbd.one/.pw RE — /search?q= +
  // mlbdInlinePlayerData JSON blob → direct cdn.dramalinkbd.tv/p/ MKV
  // (native Range, CORS *). Anchors on titles with per-episode files on the
  // NEW site: Kattalan (4 editions incl. 2160p "Best Quality" — validates
  // the 4K path), Squid Game S2E1 (per-episode WebRip), Dr Stone S4E1
  // (multi-audio anime sub+dub, 1080p+720p). NOTE: the .one site's Squid
  // Game S1 post is ZIP-only (whole-season pack → honest zero, not a bug);
  // movielinkbd.NET is a different site and deliberately unused.
  const mlb = await getJson(`${base}/debug/source/movielinkbd?type=movie&id=tmdb:1065834`, 60000);
  let mlbCount = mlb?.count ?? 0;
  if (mlbCount < 3) { await new Promise(r => setTimeout(r, 8000)); const mlb2 = await getJson(`${base}/debug/source/movielinkbd?type=movie&id=tmdb:1065834`, 60000); mlbCount = Math.max(mlbCount, mlb2?.count ?? 0); }
  check('movielinkbd Kattalan >= 3 incl 2160p (Task 58 guard)', mlbCount >= 3, `count=${mlbCount}`);
  const mlbTv = await getJson(`${base}/debug/source/movielinkbd?type=series&id=tt10919420:2:1`, 60000);
  let mlbTvCount = mlbTv?.count ?? 0;
  if (mlbTvCount < 1) { await new Promise(r => setTimeout(r, 8000)); const mlbTv2 = await getJson(`${base}/debug/source/movielinkbd?type=series&id=tt10919420:2:1`, 60000); mlbTvCount = Math.max(mlbTvCount, mlbTv2?.count ?? 0); }
  check('movielinkbd Squid Game S2E1 >= 1 (Task 58 guard)', mlbTvCount >= 1, `count=${mlbTvCount}`);
  const mlbAnime = await getJson(`${base}/debug/source/movielinkbd?type=series&id=tmdb:86031:4:1`, 60000);
  let mlbAnimeCount = mlbAnime?.count ?? 0;
  if (mlbAnimeCount < 2) { await new Promise(r => setTimeout(r, 8000)); const mlbAnime2 = await getJson(`${base}/debug/source/movielinkbd?type=series&id=tmdb:86031:4:1`, 60000); mlbAnimeCount = Math.max(mlbAnimeCount, mlbAnime2?.count ?? 0); }
  check('movielinkbd Dr Stone S4E1 >= 2 multi-audio (Task 58 guard)', mlbAnimeCount >= 2, `count=${mlbAnimeCount}`);

  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 800));
  const tail = fs.readFileSync(logFile, 'utf8');
  const warmupLines = tail.split('\n').filter(l => /warmup/i.test(l)).length;
  console.log(`  (info) warmup lines: ${warmupLines}, boot log: ${logFile}`);
}

async function getJson(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return await res.json();
  } catch (e) { console.log(`  (warn) GET ${url.slice(0, 60)} failed: ${e.message}`); return null; }
}

// ============================================================
(async () => {
  await partA();
  await partB();
  await partC();
  console.log(`\n=== RESULT: ${pass} PASS / ${fail} FAIL ===`);
  if (failures.length) { console.log('Failures:'); failures.forEach(f => console.log('  -', f)); }
  process.exit(fail ? 1 : 0);
})();
