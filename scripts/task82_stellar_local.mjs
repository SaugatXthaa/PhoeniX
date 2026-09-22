// Task 82 — StellarRip (stellar.rip) recheck: local residential full-chain diagnosis.
// Task 78 verdict was "PoW completes, 0 content every title (content drought +
// intermittent WAF)" while the user reports the SITE works fine in a browser.
// This probe classifies every step locally so we can A/B against production
// egress (/debug/source/stellarrip) and decide: content drought vs DC-IP gate
// vs our-side drift.
//
// Usage: node scripts/task82_stellar_local.mjs [tmdbId] [movie|tv] [s] [e]
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmdbId = process.argv[2] || '27205';           // Inception
const type = process.argv[3] || 'movie';
const season = process.argv[4] ? parseInt(process.argv[4]) : null;
const episode = process.argv[5] ? parseInt(process.argv[5]) : null;

const STELLAR_RIP = 'https://stellar.rip';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const S = require('../src/nuvio/stellarrip.cjs');

const isMovie = type !== 'tv';
const mediaType = isMovie ? 'movie' : 'tv';
const mediaId = Number(tmdbId);
const tvSlug = isMovie ? '' : `${season}-${episode}`;
const watchPath = isMovie ? `/watch/embed/movie/${tmdbId}` : `/watch/embed/tv/${tmdbId}-${season}-${episode}`;
const embedPath = `/en${watchPath}`;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`[${name}] OK @${((Date.now() - t0) / 1000).toFixed(1)}s → ${typeof r === 'string' ? r : JSON.stringify(r).slice(0, 200)}`);
    return r;
  } catch (e) {
    console.log(`[${name}] FAIL @${((Date.now() - t0) / 1000).toFixed(1)}s → ${e.message}`);
    return null;
  }
}

(async () => {
  console.log(`=== StellarRip local full-chain: ${type} ${tmdbId}${isMovie ? '' : ` S${season}E${episode}`} ===`);

  // Step 1+2: embed page ONCE — extract inline __REQUEST_TOKEN__ if present
  // (site re-inlined it; the provider's getRequestToken does a second fetch
  // which can timeout on slow windows — diagnose both paths)
  const first = await step('1.embed', async () => {
    const r = await fetch(STELLAR_RIP + embedPath, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie().map(c => c.split(';')[0]) : [];
    const m = html.match(/__REQUEST_TOKEN__\s*=\s*"([^"]+)"/);
    return { status: r.status, bytes: html.length, inlineToken: m ? m[1] : null, cookieJar: sc.filter(Boolean).join('; ') };
  });
  if (!first) return console.log('ABORT: front door dead locally too');
  console.log(`  inline token: ${first.inlineToken ? 'PRESENT (' + first.inlineToken.slice(0, 25) + '...)' : 'absent'}`);

  let tok = null;
  if (first.inlineToken) {
    tok = { token: first.inlineToken, embedPath, cookieJar: first.cookieJar };
    console.log('[2.request-token] using INLINE token (skipping POST)');
  } else {
    tok = await step('2.request-token', () => S.getRequestToken(tmdbId, type, season, episode));
    if (!tok) return console.log('ABORT: no request token');
  }

  // Step 3: stream token via PoW
  const streamTok = await step('3.playback-init+PoW', () =>
    S.getStreamToken(mediaId, mediaType, tvSlug, tok.token, tok.cookieJar, tok.embedPath));
  if (!streamTok) return console.log('ABORT: no stream token');

  // Step 4: dead sources
  const dead = await step('4.dead-sources', async () => {
    const set = await S.fetchDeadSources(mediaId, mediaType, tvSlug, tok.cookieJar, tok.embedPath);
    return `${set.size} dead: ${[...set].join(',') || 'none'}`;
  });

  // Step 5: encrypt sweep — ALL servers, classifying every outcome
  console.log('\n--- encrypt sweep (all 18 servers, batched 6 with pacing) ---');
  const outcomes = { stream: 0, unavailable: 0, http429: 0, httpOther: 0, noUrl: 0, err: 0 };
  const details = [];
  const BATCH = 6;
  for (let i = 0; i < S.SERVERS.length; i += BATCH) {
    const batch = S.SERVERS.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async (srv) => {
      const t0 = Date.now();
      try {
        const encRes = await fetch(STELLAR_RIP + '/api/encrypt', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json', 'Origin': STELLAR_RIP,
            'Referer': STELLAR_RIP + tok.embedPath, 'User-Agent': UA,
            ...(tok.cookieJar && { Cookie: tok.cookieJar }),
          },
          body: JSON.stringify({ data: { mediaId, mediaType, tv_slug: tvSlug || '', source: srv.id }, endpoint: 'stream-encrypted', requestToken: tok.token }),
          signal: AbortSignal.timeout(10000),
        });
        if (encRes.status === 429) return { srv: srv.name, cls: 'http429', detail: `429 retryAfter=${encRes.headers.get('retry-after')}`, ms: Date.now() - t0 };
        if (!encRes.ok) return { srv: srv.name, cls: 'httpOther', detail: `HTTP ${encRes.status}`, ms: Date.now() - t0 };
        const encData = await encRes.json();
        if (!encData.url) return { srv: srv.name, cls: 'noUrl', detail: JSON.stringify(encData).slice(0, 120), ms: Date.now() - t0 };
        const opaqueUrl = encData.url + (encData.url.includes('?') ? '&' : '?') +
          'requestToken=' + encodeURIComponent(tok.token) + '&token=' + encodeURIComponent(streamTok);
        const streamRes = await fetch(STELLAR_RIP + opaqueUrl, {
          headers: { 'Referer': STELLAR_RIP + tok.embedPath, 'User-Agent': UA }, signal: AbortSignal.timeout(10000),
        });
        if (!streamRes.ok) return { srv: srv.name, cls: 'httpOther', detail: `stream-fetch HTTP ${streamRes.status}`, ms: Date.now() - t0 };
        const streamData = await streamRes.json();
        const su = streamData?.data?.stream_url || '';
        if (!streamData.success || !su) return { srv: srv.name, cls: 'noUrl', detail: JSON.stringify(streamData).slice(0, 120), ms: Date.now() - t0 };
        if (su.includes('playback-unavailable')) return { srv: srv.name, cls: 'unavailable', detail: su.slice(0, 100), ms: Date.now() - t0 };
        return { srv: srv.name, cls: 'stream', detail: su.slice(0, 90), ms: Date.now() - t0 };
      } catch (e) {
        return { srv: srv.name, cls: 'err', detail: e.message.slice(0, 100), ms: Date.now() - t0 };
      }
    }));
    for (const s of settled) {
      if (s.status !== 'fulfilled') { outcomes.err++; continue; }
      const r = s.value;
      outcomes[r.cls]++;
      details.push(r);
    }
    if (i + BATCH < S.SERVERS.length) await new Promise(r2 => setTimeout(r2, 1500));
  }
  for (const d of details) console.log(`  ${d.srv.padEnd(11)} ${d.cls.padEnd(12)} @${(d.ms / 1000).toFixed(1)}s ${d.detail}`);
  console.log('\nOUTCOME COUNTS: ' + JSON.stringify(outcomes));

  // Bonus: SRL seed + vidking DNS from local (for the videasy/vidking comparison)
  console.log('\n--- videasy/srl side-probes (local) ---');
  await step('SRL seed', async () => {
    const r = await fetch('https://api.speedracelight.com/seed?mediaId=27205', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    return `HTTP ${r.status} ${(await r.text()).slice(0, 80)}`;
  });
  await step('vidking.net DNS', async () => {
    const r = await fetch('https://vidking.net/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    return `HTTP ${r.status}`;
  });
})().catch(e => console.error('FATAL', e));
