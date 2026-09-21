// Task 71: zxcstream endpoint diagnosis — find the migrated token route
const crypto = require('crypto');
const SECRET = "c492f7a183d6502b1e7436c538a716d"; // placeholder — real SECRET read below
// read real SECRET from the module
const fs = require('fs');
const src = fs.readFileSync('/home/z/my-project/phoenix-analysis/src/nuvio/zxcstream.cjs', 'utf8');
const secretMatch = src.match(/var SECRET\s*=\s*"([^"]+)"/);
const REAL_SECRET = secretMatch ? secretMatch[1] : SECRET;
const FIELD_MAP = {
  id: "a7f39c821d604e5b9c7143f36e1547b",
  fToken: "e83c4b719a52d8f3136052479c1635a",
  ts: "61d9a5274c8e3b29af75d6384c291e6",
  token: "c492f7a183d6502b1e7436c538a716d",
  season: "d8427b59ce30684a2f957c3613e85b",
  episode: "91c6e4a728bd503d1f785c92346b713d",
  imdbId: "f35a8c19d674b3265e871c4933a725f",
  path: "6b491e7253ad8f14d392e7561a9384c",
  mediaType: "c285f91ab306d281e947a35632e816b",
};
const BASES = ["https://player.zxcprime.xyz", "https://player.zxcstream.xyz"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

async function probe(base, route) {
  const ts = Date.now();
  const xt = crypto.createHash("sha512").update(`${ts}:${REAL_SECRET}:693134`).digest("hex").slice(0, 64);
  const body = {};
  body[FIELD_MAP.id] = "693134";
  body[FIELD_MAP.fToken] = xt;
  body[FIELD_MAP.ts] = String(ts);
  body[FIELD_MAP.path] = base + "/embed/movie/693134";
  body[FIELD_MAP.mediaType] = "movie";
  try {
    const r = await fetch(base + route, {
      method: 'POST', redirect: 'manual',
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*", "Origin": base, "Referer": base + "/embed/movie/693134", "User-Agent": UA },
      body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    const loc = r.headers.get('location') || '';
    const text = await r.text();
    console.log(`${base}${route} → ${r.status} ${loc || ''} ${text.slice(0, 120).replace(/\n/g, ' ')}`);
    return { status: r.status, loc, text };
  } catch (e) { console.log(`${base}${route} → ERR ${e.message}`); return { status: 0 }; }
}

(async () => {
  const base = BASES[0];
  for (const route of ['/backend/burat']) {
    const ts = Date.now();
    const xt = crypto.createHash("sha512").update(`${ts}:${REAL_SECRET}:693134`).digest("hex").slice(0, 64);
    const body = {};
    body[FIELD_MAP.id] = "693134";
    body[FIELD_MAP.fToken] = xt;
    body[FIELD_MAP.ts] = String(ts);
    body[FIELD_MAP.path] = base + "/embed/movie/693134";
    body[FIELD_MAP.mediaType] = "movie";
    try {
      const r = await fetch(base + route, {
        method: 'POST',
        headers: { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*", "Origin": base, "Referer": base + "/embed/movie/693134", "User-Agent": UA },
        body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
      });
      const text = await r.text();
      console.log(`POST ${route} (5 fields) → ${r.status}: ${text.slice(0, 200)}`);
      if (r.status === 200) {
        const j = JSON.parse(text);
        const token = j[FIELD_MAP.token] || j.token;
        const serverTs = j[FIELD_MAP.ts] || j.ts;
        console.log('token:', String(token).slice(0, 40), 'serverTs:', serverTs);
        // sentinel
        const q = new URLSearchParams();
        q.set(FIELD_MAP.id, "693134");
        q.set("b", "movie");
        q.set(FIELD_MAP.ts, String(serverTs));
        q.set(FIELD_MAP.token, String(token));
        q.set(FIELD_MAP.fToken, xt);
        const sRes = await fetch(base + "/backend_/embed/sentinel?" + q.toString(), {
          headers: { Referer: base + "/embed/movie/693134", "User-Agent": UA }, signal: AbortSignal.timeout(12000),
        });
        const st = await sRes.text();
        console.log(`sentinel → ${sRes.status}: ${st.slice(0, 300)}`);
      }
    } catch (e) { console.log(`POST ${route} → ERR ${e.message}`); }
  }
})();
