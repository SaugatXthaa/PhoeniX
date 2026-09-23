// Follow the naukriadda multi-hop landing chain to its destination
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const jar = {};
function absorb(r) {
  for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
    const [kv] = c.split(';'); const i = kv.indexOf('=');
    if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}
const ck = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function step(url, form = null, referer = null) {
  const opts = { redirect: 'manual', headers: { 'User-Agent': UA, Cookie: ck(), ...(referer ? { Referer: referer } : {}) } };
  if (form) { opts.method = 'POST'; opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(form).toString(); }
  const r = await fetch(url, opts);
  absorb(r);
  const body = await r.text();
  return { status: r.status, loc: r.headers.get('location'), body };
}

function parseForm(html) {
  const f = html.match(/<form id="lp[^"]*"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/);
  if (!f) return null;
  const fields = {};
  for (const m of f[2].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) fields[m[1]] = m[2];
  return { action: f[1], fields };
}

const sidUrl = process.env.SID_URL || process.argv[2];
let r = await step(sidUrl, null, 'https://uhdmovies.my/');
console.log('hop0 GET:', r.status, 'len', r.body.length);
let form = parseForm(r.body);
let hops = 0;
while (form && hops < 12) {
  hops++;
  const chain = form.fields._lp_chain ? JSON.parse(Buffer.from(form.fields._lp_chain, 'base64').toString()) : null;
  console.log(`hop${hops} POST → ${form.action} | fields: ${Object.keys(form.fields).join(',')} | chain: ${JSON.stringify(chain)}`);
  r = await step(form.action, form.fields, sidUrl);
  console.log(`   → ${r.status} len=${r.body.length} loc=${r.loc || ''}`);
  if (r.status >= 300 && r.status < 400 && r.loc) {
    const f2 = await step(r.loc, null, form.action);
    console.log(`   followed → ${f2.status} len=${f2.body.length}`);
    r = f2;
  }
  // check for final destination (external link / real content)
  const ext = [...r.body.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1])
    .filter(u => !/thenaukriadda|w3\.org|wp\.|schema|yoast|s\.w\.org|googleapis|gstatic|github|gravatar|emoji/.test(u));
  if (ext.length) { console.log('   EXTERNAL LINKS:', [...new Set(ext)].slice(0, 6)); }
  if (r.status === 200 && r.body.length > 50000 && !/lp-land|lp-s\d-form/i.test(r.body)) { console.log('   (real page, chain ended without external link?)'); break; }
  form = parseForm(r.body);
  if (!form) {
    // maybe a meta/js redirect to the destination
    const meta = r.body.match(/http-equiv="refresh"[^>]*url=([^">]+)/i) || r.body.match(/location(?:\.href)?\s*=\s*["']([^"']+)["']/);
    if (meta) { console.log('   redirect hint:', meta[1]); const f2 = await step(meta[1], null, form ? sidUrl : sidUrl); console.log(`   → ${f2.status} len=${f2.body.length}`); const e2 = [...f2.body.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]).filter(u => !/thenaukriadda|w3\.org|wp\.|schema/.test(u)); if (e2.length) console.log('   EXTERNAL:', [...new Set(e2)].slice(0, 6)); }
    else console.log('   no more lp forms — chain end');
    break;
  }
}
console.log('DONE after', hops, 'hops');
