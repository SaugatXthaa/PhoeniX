// Task 82 — StellarRip multi-title zero confirmation (Task 78 protocol:
// alternate titles + dead-sources classification).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const S = require('../src/nuvio/stellarrip.cjs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://stellar.rip';

const TITLES = [
  { label: 'Dune2 movie 693134', id: '693134', type: 'movie' },
  { label: 'BreakingBad S1E1 tv 1396', id: '1396', type: 'tv', season: 1, episode: 1 },
  { label: 'SquidGame S1E1 tv 93405', id: '93405', type: 'tv', season: 1, episode: 1 },
];

async function deadSources(mediaId, mediaType, tvSlug, cookieJar, embedPath) {
  try {
    const q = `mediaId=${encodeURIComponent(mediaId)}&mediaType=${encodeURIComponent(mediaType)}&tv_slug=${encodeURIComponent(tvSlug || '')}`;
    const res = await fetch(BASE + '/api/dead-sources?' + q, {
      headers: { 'User-Agent': UA, Referer: BASE + embedPath, ...(cookieJar && { Cookie: cookieJar }) },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return `HTTP ${res.status}`;
    const j = await res.json();
    return `${(j.deadSources || []).length} dead of 18`;
  } catch (e) { return `err ${e.message.slice(0, 50)}`; }
}

for (const t of TITLES) {
  const t0 = Date.now();
  try {
    const isMovie = t.type !== 'tv';
    const watchPath = isMovie ? `/watch/embed/movie/${t.id}` : `/watch/embed/tv/${t.id}-${t.season}-${t.episode}`;
    const streams = await S.getStreams(t.id, t.type, t.season ?? null, t.episode ?? null);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${t.label}] ${streams.length} streams @${dt}s`);
    // classify WHY via one encrypt call + dead-sources
    const mediaType = isMovie ? 'movie' : 'tv';
    const tvSlug = isMovie ? '' : `${t.season}-${t.episode}`;
    const embedPath = `/en${watchPath}`;
    const er = await fetch(BASE + embedPath, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!er.ok) { console.log(`   embed HTTP ${er.status}`); continue; }
    const sc = er.headers.getSetCookie ? er.headers.getSetCookie().map(c => c.split(';')[0]).filter(Boolean).join('; ') : '';
    const tok = await S.getRequestToken(t.id, t.type, t.season ?? null, t.episode ?? null).catch(e => null);
    if (!tok) { console.log('   no request-token'); continue; }
    const st = await S.getStreamToken(Number(t.id), mediaType, tvSlug, tok.token, tok.cookieJar || sc, tok.embedPath).catch(e => { console.log('   no stream-token: ' + e.message.slice(0, 60)); return null; });
    if (!st) continue;
    const ds = await deadSources(t.id, mediaType, tvSlug, tok.cookieJar || sc, embedPath);
    // one encrypt call on the top server (s24 Spica)
    const encRes = await fetch(BASE + '/api/encrypt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': BASE, 'Referer': BASE + tok.embedPath, 'User-Agent': UA, ...(tok.cookieJar && { Cookie: tok.cookieJar }) },
      body: JSON.stringify({ data: { mediaId: Number(t.id), mediaType, tv_slug: tvSlug, source: 's24' }, endpoint: 'stream-encrypted', requestToken: tok.token }),
      signal: AbortSignal.timeout(10000),
    });
    let encNote = `HTTP ${encRes.status}`;
    if (encRes.ok) {
      const j = await encRes.json();
      const su = j?.url || '';
      encNote = su ? (su.includes('playback-unavailable') ? 'playback-UNAVAILABLE' : 'stream-OK ' + su.slice(0, 50)) : 'no-url ' + JSON.stringify(j).slice(0, 80);
    }
    console.log(`   dead-sources: ${ds} | encrypt(s24): ${encNote}`);
  } catch (e) {
    console.log(`[${t.label}] FAIL ${e.message.slice(0, 90)} @${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}
