// kmmovies: egress matrix for w3.magiclinks.lol page fetch
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const target = process.env.ML_URL;
const REFERER = 'https://kmmovies.rest/';
const probes = [
  ['direct', target, {}],
  ['cf-worker', 'https://test.cors.workers.dev/?' + target, {}],
  ['allorigins', 'https://api.allorigins.win/raw?url=' + encodeURIComponent(target), {}],
  ['codetabs', 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(target), {}],
  ['jina', 'https://r.jina.ai/' + target, {}],
  ['translate-goog', 'https://w3-magiclinks-lol.translate.goog' + new URL(target).pathname + '?_x_tr_sl=auto&_x_tr_tl=en&_x_tr_hl=en', {}],
  ['cors-lol', 'https://api.cors.lol/?url=' + encodeURIComponent(target), {}],
  ['cors-eu', 'https://cors.eu.org/' + target, {}],
  ['corsfix', 'https://proxy.corsfix.com/?' + target, {}],
  ['w2-subdomain', target.replace('w3.', 'w2.'), {}],
  ['v1-subdomain', target.replace('w3.', 'v1.'), {}],
];
for (const [name, url, extra] of probes) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: REFERER, ...extra }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
    const body = await r.text();
    const challenged = /Just a moment|challenge-platform|cf_chl_/i.test(body);
    const px = /pixeldrain\.com\/u\//.test(body);
    const km = /kmphotos\.cv/.test(body);
    console.log(`${name.padEnd(14)} ${r.status} len=${String(body.length).padStart(6)} ${challenged ? 'CF-CHALLENGE' : ''} ${px ? 'PIXELDRAIN✓' : ''} ${km ? 'R2✓' : ''}`);
  } catch (e) {
    console.log(`${name.padEnd(14)} ERR ${e.message.slice(0, 60)}`);
  }
}
