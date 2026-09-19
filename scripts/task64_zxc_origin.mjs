// Task 64: zxcprime token route — try origin/referer variants
const crypto = await import('crypto');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SECRET = '23423653';
const FM = { id: 'a7f39c821d604e5b9c7143f36e1547b', fToken: 'e83c4b719a52d8f3136052479c1635a', ts: '61d9a5274c8e3b29af75d6384c291e6' };

async function attempt(label, origin, referer, bodyOverride) {
  const ts = Date.now();
  const fToken = crypto.createHash('sha512').update(`${ts}:${SECRET}:27205`).digest('hex').slice(0, 64);
  const body = bodyOverride || { [FM.id]: '27205', [FM.fToken]: fToken, [FM.ts]: ts };
  const headers = { 'Content-Type': 'application/json', 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Origin': origin };
  if (referer) headers['Referer'] = referer;
  try {
    const r = await fetch('https://player.zxcprime.xyz/backend/bugok', {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const t = await r.text();
    console.log(`${label}: ${r.status} :: ${t.slice(0, 220)}`);
    return { status: r.status, text: t };
  } catch (e) { console.log(`${label}: ERR ${e.message}`); return { status: 0 }; }
}

await attempt('no-origin', undefined, undefined);
await attempt('prime-origin', 'https://player.zxcprime.xyz', 'https://player.zxcprime.xyz/embed/movie/27205');
await attempt('icu-origin', 'https://zxcstream.icu', 'https://zxcstream.icu/');
await attempt('icu-embed-ref', 'https://zxcstream.icu', 'https://zxcstream.icu/watch/movie/27205');
// also string ts (in case backend wants string)
{
  const ts = Date.now();
  const fToken = crypto.createHash('sha512').update(`${ts}:${SECRET}:27205`).digest('hex').slice(0, 64);
  await attempt('string-ts-icu', 'https://zxcstream.icu', 'https://zxcstream.icu/', { [FM.id]: '27205', [FM.fToken]: fToken, [FM.ts]: String(ts) });
}
