// Task 87: fresh AcerMovies upstream RE — has the API migrated? Endpoint map + vantage A/B.
import fs from 'fs';

const OUT = '/home/z/my-project/scripts/task87_acer_re.json';
const findings = { at: new Date().toISOString(), probes: [] };
const log = (...a) => console.log(...a);

async function rec(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    r.ms = Date.now() - t0;
    findings.probes.push({ name, ...r });
    log(`[${r.status ?? 'ERR'}] ${name} (${r.ms}ms) ${r.note || ''}`);
    return r;
  } catch (e) {
    findings.probes.push({ name, error: e.message, ms: Date.now() - t0 });
    log(`[EXC] ${name} (${Date.now() - t0}ms) ${e.message}`);
    return { error: e.message };
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Origin': 'https://acermovies.fun',
  'Referer': 'https://acermovies.fun/',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ---- 1. homepage from sandbox — extract current bundle refs ----
let homeHtml = '';
await rec('home-sandbox', async () => {
  const r = await fetch('https://acermovies.fun/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  homeHtml = await r.text();
  return { status: r.status, len: homeHtml.length, note: 'homepage' };
});

// grep the HTML for api hosts / fetch paths / bundle scripts
const apiRefs = [...new Set([
  ...(homeHtml.match(/https?:\/\/[a-z0-9.-]*acermovies[a-z0-9.-]*/gi) || []),
  ...(homeHtml.match(/backendUrl[^,;]{0,80}/gi) || []),
  ...(homeHtml.match(/\/api\/[a-zA-Z0-9_]+/g) || []),
  ...(homeHtml.match(/src="[^"]+\.js"/g) || []),
])];
findings.apiRefs = apiRefs;
log('API REFS:', JSON.stringify(apiRefs, null, 1).slice(0, 2000));

// fetch the main bundle(s) and grep them too
const bundles = (homeHtml.match(/src="([^"]+\.js)"/g) || []).map(s => s.replace(/src="|"/g, ''));
findings.bundleFindings = [];
for (const b of bundles.slice(0, 4)) {
  const url = b.startsWith('http') ? b : `https://acermovies.fun${b.startsWith('/') ? '' : '/'}${b}`;
  await rec(`bundle ${url.slice(-40)}`, async () => {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
    const js = await r.text();
    const refs = [...new Set([
      ...(js.match(/https?:\/\/api[a-z0-9.-]*acermovies[a-z0-9.-]*/gi) || []),
      ...(js.match(/https?:\/\/[a-z0-9.-]+\/api\/[a-zA-Z0-9_]+/g) || []),
      ...(js.match(/["']\/api\/[a-zA-Z0-9_]+["']/g) || []),
      ...(js.match(/backendUrl\s*=\s*[^,;]{0,100}/g) || []),
      ...(js.match(/seriesType[^,;)]{0,40}/g) || []),
    ])];
    findings.bundleFindings.push({ url, refs });
    log(`  bundle refs:`, JSON.stringify(refs.slice(0, 30)));
    return { status: r.status, len: js.length };
  });
}

// ---- 2. sandbox direct: search → quality → sourceUrl chain for Inception ----
let postUrl = null;
await rec('sandbox POST /api/search', async () => {
  const r = await fetch('https://api2.acermovies.fun/api/search', {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ searchQuery: 'Inception 2010' }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await r.text();
  let n = null;
  try { n = JSON.parse(body)?.searchResult?.length; } catch { }
  if (n) {
    try {
      const arr = JSON.parse(body).searchResult;
      postUrl = arr.find(x => String(x.title).toLowerCase().includes('inception'))?.url || arr[0]?.url;
    } catch { }
  }
  return { status: r.status, note: `results=${n} postUrl=${postUrl ? postUrl.slice(0, 80) : 'none'}`, bodyHead: body.slice(0, 300) };
});

if (postUrl) {
  await rec('sandbox POST /api/sourceQuality', async () => {
    const r = await fetch('https://api2.acermovies.fun/api/sourceQuality', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ url: postUrl }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await r.text();
    let n = null, urls = [];
    try {
      const j = JSON.parse(body);
      n = j.sourceQualityList?.length;
      urls = (j.sourceQualityList || []).map(q => `${q.quality}:${q.url ? 'URL' : ''}${q.episodesUrl ? 'EP' : ''}`);
    } catch { }
    return { status: r.status, note: `qualities=${n} ${urls.join(',').slice(0, 150)}`, bodyHead: body.slice(0, 400) };
  });

  await rec('sandbox POST /api/sourceUrl', async () => {
    const r = await fetch('https://api2.acermovies.fun/api/sourceUrl', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ url: postUrl, seriesType: 'movie' }),
      signal: AbortSignal.timeout(25000),
    });
    const body = await r.text();
    return { status: r.status, note: `body=${body.slice(0, 160)}` };
  });
}

// ---- 3. alternate api hosts (do they exist?) ----
for (const host of ['api.acermovies.fun', 'api1.acermovies.fun', 'api3.acermovies.fun', 'api2.acermovies.net']) {
  await rec(`alt-host ${host}`, async () => {
    const r = await fetch(`https://${host}/api/search`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ searchQuery: 'test' }),
      signal: AbortSignal.timeout(12000),
    });
    return { status: r.status, note: `body=${(await r.text()).slice(0, 120)}` };
  });
}

// ---- 4. prod egress A/B: search POST via rawfetch ----
await rec('prod POST /api/search (rawfetch)', async () => {
  const u = `https://ignatiusphoenix-5zrn.onrender.com/debug/rawfetch?url=${encodeURIComponent('https://api2.acermovies.fun/api/search')}&method=POST&ct=application%2Fjson&body=${encodeURIComponent(JSON.stringify({ searchQuery: 'Inception 2010' }))}&origin=${encodeURIComponent('https://acermovies.fun')}&referer=${encodeURIComponent('https://acermovies.fun/')}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(40000) });
  const j = await r.json().catch(() => ({}));
  return { status: j.status, note: `head=${String(j.head || '').slice(0, 200)}` };
});

fs.writeFileSync(OUT, JSON.stringify(findings, null, 1));
log(`\nSaved: ${OUT}`);
