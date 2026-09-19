// Task 64: batch probe zxcstream / kmmovies / animekai / animeworldindia upstreams from sandbox
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function show(name, url, opts = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...(opts.headers || {}) }, redirect: opts.redirect || 'follow', signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    console.log(`${name}: HTTP ${res.status} ct=${res.headers.get('content-type')} len=${body.length} url=${res.url.slice(0, 90)}`);
    if (opts.sniff) console.log('   head:', body.slice(0, 160).replace(/\n/g, ' '));
    return { status: res.status, body };
  } catch (e) {
    console.log(`${name}: ERR ${e.message.slice(0, 80)}`);
    return { status: 0, body: '' };
  }
}

// 1. ZXCStream — token route + sentinel
console.log('===== ZXCSTREAM =====');
const crypto = await import('crypto');
const ts = Date.now();
const SECRET = '23423653';
const tmdbId = '27205';
const fToken = crypto.createHash('sha512').update(`${ts}:${SECRET}:${tmdbId}`).digest('hex').slice(0, 64);
await show('zxc home', 'https://player.zxcstream.xyz/', { sniff: true });
const FIELD_MAP = {
  id: 'a7f39c821d604e5b9c7143f36e1547b', fToken: 'e83c4b719a52d8f3136052479c1635a', ts: '61d9a5274c8e3b29af75d6384c291e6',
};
const tokenBody = { [FIELD_MAP.id]: tmdbId, [FIELD_MAP.fToken]: fToken, [FIELD_MAP.ts]: ts };
const tokRes = await fetch('https://player.zxcstream.xyz/backend/abaygagoka', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Referer': 'https://player.zxcstream.xyz/embed/movie/27205', 'Origin': 'https://player.zxcstream.xyz' },
  body: JSON.stringify(tokenBody), signal: AbortSignal.timeout(15000),
});
console.log('zxc token POST:', tokRes.status, (await tokRes.text()).slice(0, 200));

// 2. KMMovies
console.log('===== KMMOVIES =====');
await show('km home', 'https://kmmovies.rest/', { sniff: true });
await show('magiclinks', 'https://w3.magiclinks.lol/', { sniff: true });

// 3. AnimeKai
console.log('===== ANIMEKAI =====');
await show('animekai home', 'https://animekai.at/', { sniff: true });
await show('animekai search', 'https://animekai.at/watch/frieren-beyond-journeys-end-1831', { sniff: true });
await show('zoko', 'https://zokoanime.video/', { sniff: true });

// 4. AnimeWorldIN
console.log('===== ANIMEWORLDINDIA =====');
await show('awe .one home', 'https://watchanimeworld.one/', { sniff: true });
await show('awe .top home', 'https://watchanimeworld.top/', { sniff: true });
