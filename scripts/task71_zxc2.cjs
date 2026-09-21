// Task 71: zxcstream sequenced probe with raw response bodies
const crypto = require('crypto');
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
const SECRET = "23423653";
const BASE = "https://player.zxcprime.xyz";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ts = Date.now();
    const xt = crypto.createHash("sha512").update(`${ts}:${SECRET}:693134`).digest("hex").slice(0, 64);
    const body = {};
    body[FIELD_MAP.id] = "693134";
    body[FIELD_MAP.fToken] = xt;
    body[FIELD_MAP.ts] = String(ts);
    body[FIELD_MAP.path] = BASE + "/embed/movie/693134";
    body[FIELD_MAP.mediaType] = "movie";
    try {
      const r = await fetch(BASE + "/backend/burat", {
        method: 'POST',
        headers: { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*", "Origin": BASE, "Referer": BASE + "/embed/movie/693134", "User-Agent": UA },
        body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
      });
      const text = await r.text();
      console.log(`[${attempt}] burat → ${r.status}: ${text.slice(0, 160)}`);
      if (r.status !== 200) { await sleep(3000); continue; }
      const j = JSON.parse(text);
      const token = j[FIELD_MAP.token] || j.token;
      const serverTs = j[FIELD_MAP.ts] || j.ts;
      if (!token) { console.log('  no token field'); await sleep(3000); continue; }
      const q = new URLSearchParams();
      q.set(FIELD_MAP.id, "693134");
      q.set("b", "movie");
      q.set(FIELD_MAP.ts, String(serverTs));
      q.set(FIELD_MAP.token, String(token));
      q.set(FIELD_MAP.fToken, xt);
      const sRes = await fetch(BASE + "/backend_/embed/sentinel?" + q.toString(), {
        headers: { "User-Agent": UA, "Origin": BASE, "Referer": BASE + "/embed/movie/693134", "Accept": "application/json, text/plain, */*" }, signal: AbortSignal.timeout(15000),
      });
      const st = await sRes.text();
      console.log(`[${attempt}] sentinel → ${sRes.status}: ${st.slice(0, 220).replace(/\n/g, ' ')}`);
      if (sRes.status === 200) {
        try {
          const sj = JSON.parse(st);
          if (sj.embed) { console.log('EMBED:', sj.embed); break; }
        } catch { /* non-json */ }
      }
    } catch (e) { console.log(`[${attempt}] ERR ${e.message}`); }
    await sleep(3000);
  }
})();
