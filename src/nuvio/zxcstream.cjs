// ZXCStream Scraper for Nuvio Local Scrapers
// ---------------------------------------------------------------
// Task 64 REWRITE — the site migrated its backend again:
//   player.zxcstream.xyz  → 302 → player.zxcprime.xyz
//   token route /backend/a1b2c3 → /backend/abaygagoka → /backend/bugok
//   embeds are now served by the "Byse" platform on mfw09.org with a
//   fingerprint-gated, PoW-protected, AES-GCM-encrypted playback API.
//
// Task 71 (2026-09-21): token route rotated AGAIN — /backend/bugok 404s on
// zxcprime.xyz; the deployed chunk (0uktzs59zudq..js, module 55790) now POSTs
// /backend/burat. FIELD_MAP + SECRET ("23423653") + sentinel route are
// byte-identical. ROUTES below tries the new route first and keeps the old
// ones as fallbacks (the route has rotated 3× in 2 weeks; the older names
// sometimes come back behind their origin proxy).
//
// CURRENT PROTOCOL (recovered live 2026-09-19 from the deployed bundles —
// zxcprime chunk 0b5xgdf8vcttb.js + module 55790, mfw09 Byse SPA):
//   1. fToken = sha512(`${ts}:${SECRET}:${tmdbId}`).slice(0,64)  ts=Date.now()
//      SECRET = "23423653" (UNCHANGED across migrations, chunk 55790)
//   2. POST /backend/<route>  body (obfuscated FIELD_MAP, verbatim from chunk):
//        {id, fToken, ts, path, mediaType}          ← backend requires the
//      path (full player page URL) and mediaType ("movie"|"tv") — the site's
//      OWN frontend omits them and gets 400 "Invalid request" (their bundle
//      is behind their backend; our request shape is the backend's).
//      Origin/Referer must be the player page (500 otherwise). → {token, ts}
//   3. GET /backend_/embed/sentinel?id&b&ts&token&fToken[&season&episode]
//      [&imdbId] → {embed: "https://mfw09.org/e/<code>?sub.info=<subs.json>"}
//   4. Byse identity attestation (ECDSA P-256, client-held key):
//        POST mfw09.org/api/videos/access/challenge → {challenge_id, nonce}
//        sign(nonce) with a fresh P-256 key (SHA-256, DER→base64url)
//        POST /api/videos/access/attest {viewer_id,device_id,challenge_id,
//          nonce,signature,public_key(JWK),client(fingerprint),storage,
//          attributes:{entropy}} → {viewer_id, device_id, confidence}
//   5. POST /api/videos/<code>/embed/captcha {} → {pow_nonce, pow_difficulty
//      (16), pow_token}. The PoW is NOT sha256 — it is a custom 32-word hash
//      (chunk pow-DEJGtdh2.js, functions ye/gr/wr ported EXACTLY below):
//        find counter where hash(pow_nonce + ":" + counter) has >=16 leading
//        zero bits → solution = counter as decimal string.
//   6. POST .../embed/captcha/verify {pow_token, solution} → {status:"ok",
//      token, expires_in}
//   7. POST /api/videos/<code>/embed/playback  X-Captcha-Token: <token>
//      body {fingerprint:{viewer_id, device_id, confidence}}  (snake_case!)
//      → {playback:{version, key_parts[30], iv, payload}}
//   8. AES-256-GCM: key = key_parts[version-1] ++ key_parts[30-version]
//      (1-indexed pair from the site's Qa() table, both 16B), iv = iv,
//      ciphertext+tag = payload (tag = LAST 16 bytes, WebCrypto layout).
//      Plaintext JSON: {sources:[{url, label, mime_type, quality, height,
//      size_bytes}], tracks:[subtitles], poster_url}
//   9. sub.info JSON (optional) → [{file: vtt, label, kind, default}]
//
// Only extracted media URLs ship. Zero html cards. Honest zero on failure.
//
// No Playwright, no FlareSolverr — plain fetch() + node:crypto.

"use strict";

var crypto = require("crypto");
var http = require("http");
var https = require("https");

var PROVIDER_NAME = "ZXCStream";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";

var SECRET = "23423653";
var FIELD_MAP = {
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

var PLAYER_BASES = ["https://player.zxcprime.xyz", "https://player.zxcstream.xyz"];
// Task 71: token route rotation — burat is CURRENT (chunk 0uktzs59zudq..js);
// bugok/abaygagoka kept as fallbacks for their origin-proxy rotation pattern.
var TOKEN_ROUTES = ["/backend/burat", "/backend/bugok", "/backend/abaygagoka"];
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// ─── small fetch helper (redirects on, timeout, any method) ────────────────
function fetchRaw(url, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    var u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 0, body: "", headers: {} }); }
    var lib = u.protocol === "http:" ? http : https;
    var req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search,
      method: opts.method || "GET",
      headers: Object.assign({ "User-Agent": UA, Accept: "*/*" }, opts.headers || {}),
      timeout: opts.timeout || 12000,
    }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers });
      });
    });
    req.on("error", function () { resolve({ status: 0, body: "", headers: {} }); });
    req.on("timeout", function () { req.destroy(new Error("timeout")); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ─── Stage A: player token + sentinel → Byse embed code ───────────────────
function generateFrontendToken(tmdbId) {
  var ts = Date.now();
  var input = ts + ":" + SECRET + ":" + String(tmdbId);
  var xt = crypto.createHash("sha512").update(input).digest("hex").slice(0, 64);
  return { xt: xt, rt: ts };
}

async function resolveEmbed(tmdbId, type, season, episode, imdbId) {
  var idStr = String(tmdbId);
  var pagePath = "/embed/" + (type === "tv" ? "tv" : "movie") + "/" + idStr;
  var td = generateFrontendToken(idStr);
  var body = {};
  body[FIELD_MAP.id] = idStr;
  body[FIELD_MAP.fToken] = td.xt;
  body[FIELD_MAP.ts] = td.rt;
  // Backend contract (verified 200): path + mediaType are REQUIRED even
  // though the site frontend omits them (400 "Invalid request" without).
  body[FIELD_MAP.path] = PLAYER_BASES[0] + pagePath;
  body[FIELD_MAP.mediaType] = type === "tv" ? "tv" : "movie";

  for (var b = 0; b < PLAYER_BASES.length; b++) {
    var base = PLAYER_BASES[b];
    var tokRes = null;
    for (var ri = 0; ri < TOKEN_ROUTES.length; ri++) {
      tokRes = await fetchRaw(base + TOKEN_ROUTES[ri], {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/plain, */*",
          "Origin": base,
          "Referer": base + pagePath,
        },
        body: JSON.stringify(body),
        timeout: 12000,
      });
      if (tokRes.status === 200) break;
      console.log("[ZXCStream] token POST " + tokRes.status + " on " + base + TOKEN_ROUTES[ri]);
      tokRes = null;
    }
    if (!tokRes) continue;
    var j = null;
    try { j = JSON.parse(tokRes.body); } catch (e) { /* not json */ }
    if (!j) continue;
    var token = j[FIELD_MAP.token] || j.token;
    var serverTs = j[FIELD_MAP.ts] || j.ts;
    if (!token || !serverTs) { console.log("[ZXCStream] token response missing fields"); continue; }

    var q = new URLSearchParams();
    q.set(FIELD_MAP.id, idStr);
    q.set("b", type === "tv" ? "tv" : "movie");
    q.set(FIELD_MAP.ts, String(serverTs));
    q.set(FIELD_MAP.token, String(token));
    q.set(FIELD_MAP.fToken, td.xt);
    if (type === "tv" && season) {
      q.set(FIELD_MAP.season, String(season));
      q.set(FIELD_MAP.episode, String(episode || 1));
    }
    if (imdbId) q.set(FIELD_MAP.imdbId, String(imdbId));

    var sRes = await fetchRaw(base + "/backend_/embed/sentinel?" + q.toString(), {
      headers: { Referer: base + pagePath }, timeout: 12000,
    });
    if (sRes.status !== 200) {
      console.log("[ZXCStream] sentinel " + sRes.status);
      continue;
    }
    var sj = null;
    try { sj = JSON.parse(sRes.body); } catch (e) { /* not json */ }
    if (sj && typeof sj.embed === "string" && /^https:\/\//.test(sj.embed)) {
      return { embed: sj.embed, base: base, pagePath: pagePath };
    }
    console.log("[ZXCStream] sentinel returned no embed");
  }
  return null;
}

// ─── Stage B: Byse identity attestation (ECDSA P-256) ─────────────────────
var _attest = null; // {viewer_id, device_id, confidence, expiresAt}
var b64u = function (buf) { return Buffer.from(buf).toString("base64url"); }

// ECDSA P-256 keygen + sign — webcrypto first (browser/edge runtimes), then
// node:crypto generateKeyPairSync + JWK export (older/sandboxed runtimes
// without crypto.webcrypto, e.g. on-device Nuvio hosts).
function makeIdentityKey() {
  try {
    if (crypto.webcrypto && crypto.webcrypto.subtle) {
      return crypto.webcrypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
        .then(function (kp) {
          return crypto.webcrypto.subtle.exportKey("jwk", kp.publicKey)
            .then(function (pubJwk) {
              return {
                pubJwk: pubJwk,
                sign: function (msg) {
                  return crypto.webcrypto.subtle.sign(
                    { name: "ECDSA", hash: { name: "SHA-256" } }, kp.privateKey,
                    new TextEncoder().encode(msg)).then(b64u);
                },
              };
            });
        });
    }
  } catch (e) { /* fall through to node:crypto */ }
  return new Promise(function (resolve, reject) {
    try {
      var kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      var pubJwk = kp.publicKey.export({ format: "jwk" });
      resolve({
        pubJwk: pubJwk,
        sign: function (msg) {
          var sig = crypto.createSign("SHA256").update(msg).sign(kp.privateKey);
          return Promise.resolve(b64u(sig));
        },
      });
    } catch (e) { reject(e); }
  });
}

async function attestation() {
  if (_attest && _attest.expiresAt > Date.now()) return _attest;
  try {
    var key = await makeIdentityKey();

    var chalRes = await fetchRaw("https://mfw09.org/api/videos/access/challenge", {
      method: "POST", headers: CHROME_HEADERS, timeout: 12000,
    });
    if (chalRes.status !== 200) { console.log("[ZXCStream] access/challenge " + chalRes.status); return null; }
    var chal = JSON.parse(chalRes.body);
    if (!chal.challenge_id || !chal.nonce) return null;

    var signature = await key.sign(chal.nonce);

    var fp = browserFingerprint();
    var attestBody = {
      viewer_id: "", device_id: "",
      challenge_id: chal.challenge_id, nonce: chal.nonce,
      signature: signature, public_key: key.pubJwk,
      client: fp, storage: {}, attributes: { entropy: "medium" },
    };
    var attRes = await fetchRaw("https://mfw09.org/api/videos/access/attest", {
      method: "POST", headers: CHROME_HEADERS, body: JSON.stringify(attestBody), timeout: 12000,
    });
    if (attRes.status !== 200) { console.log("[ZXCStream] access/attest " + attRes.status); return null; }
    var att = JSON.parse(attRes.body);
    if (!att || !att.device_id) { console.log("[ZXCStream] attest missing device_id"); return null; }
    _attest = {
      viewer_id: att.viewer_id || "",
      device_id: att.device_id,
      confidence: typeof att.confidence === "number" ? att.confidence : 0.5,
      expiresAt: Date.now() + 45 * 60 * 1000,
    };
    console.log("[ZXCStream] attested (confidence " + _attest.confidence.toFixed(2) + ")");
    return _attest;
  } catch (e) {
    console.log("[ZXCStream] attestation failed: " + (e && e.message ? e.message : e));
    return null;
  }
}

function browserFingerprint() {
  return {
    user_agent: UA, pixel_ratio: 1, screen_width: 1920, screen_height: 1080, color_depth: 24,
    languages: ["en-US", "en"], timezone: "Europe/London",
    hardware_concurrency: 8, device_memory: 8, touch_points: 0,
    webgl_vendor: "Google Inc. (Intel)",
    webgl_renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    canvas_hash: crypto.createHash("sha256").update("byse-canvas").digest("base64url"),
    audio_hash: crypto.createHash("sha256").update("byse-audio").digest("base64url"),
    webgl_params_hash: crypto.createHash("sha256").update("byse-webgl").digest("base64url"),
    fonts_hash: crypto.createHash("sha256").update("byse-fonts").digest("base64url"),
    codecs_hash: crypto.createHash("sha256").update("byse-codecs").digest("base64url"),
    media_devices: "ai2ao3vi1", pointer_type: "fine,hover",
    extra: { vendor: "Google Inc.", appVersion: UA.replace("Mozilla/", "") },
  };
}

var CHROME_HEADERS = {
  "Content-Type": "application/json",
  "X-Embed-Origin": "https://player.zxcprime.xyz",
  "X-Embed-Referer": "https://player.zxcprime.xyz/embed/movie/1",
  "Origin": "https://mfw09.org",
  "Referer": "https://player.zxcprime.xyz/",
  "User-Agent": UA,
};

// ─── Stage C: the custom PoW hash (exact port of pow-DEJGtdh2.js) ─────────
function rotl(x, e) { return (x << e | x >>> (32 - e)) >>> 0; }
function mix4(t) {
  t[0] = (t[0] + t[1]) >>> 0; t[3] = rotl(t[3] ^ t[0], 16);
  t[2] = (t[2] + t[3]) >>> 0; t[1] = rotl(t[1] ^ t[2], 12);
  t[0] = (t[0] + t[1]) >>> 0; t[3] = rotl(t[3] ^ t[0], 8);
  t[2] = (t[2] + t[3]) >>> 0; t[1] = rotl(t[1] ^ t[2], 7);
}
function byseHash(bytes) {
  var st = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (var i = 0; i < bytes.length; i++) { st[0] = (st[0] + bytes[i]) >>> 0; st[0] = rotl(st[0], 7); mix4(st); }
  for (var k = 0; k < 8; k++) mix4(st);
  var tbl = new Uint32Array(512);
  for (var a = 0; a < 512; a++) { mix4(st); tbl[a] = (st[0] ^ st[2]) >>> 0; }
  for (var p = 0; p < 2; p++) {
    for (var s = 0; s < 512; s++) {
      var m = tbl[s] & 511;
      var c = (tbl[s] + tbl[m]) >>> 0;
      c = rotl(c, 13);
      c = (c ^ Math.imul(tbl[(s + 1) & 511], 2654435761)) >>> 0;
      tbl[s] = c;
      st[0] = (st[0] ^ c) >>> 0;
      mix4(st);
    }
  }
  var out = new Uint32Array(8);
  for (var w = 0; w < 8; w++) {
    mix4(st);
    var acc = st[0];
    var base = w * 64;
    for (var z = 0; z < 64; z++) {
      var d = tbl[base + z];
      acc = (acc + d) >>> 0;
      acc = rotl(acc, 5);
      acc = (acc ^ Math.imul(d, 2246822519)) >>> 0;
    }
    out[w] = (acc ^ st[2]) >>> 0;
  }
  return out;
}
function leadingZeroBits(words) {
  var bits = 0;
  for (var r = 0; r < words.length; r++) {
    var n = words[r];
    if (n === 0) { bits += 32; continue; }
    return bits + Math.clz32(n);
  }
  return bits;
}
function solveBysePoW(nonce, difficulty, maxMs) {
  if (difficulty <= 0) return "0";
  var t0 = Date.now();
  var s = 0;
  var scratch = new Uint8Array(256);
  for (;;) {
    var str = nonce + ":" + s;
    if (str.length > scratch.length) scratch = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) scratch[i] = str.charCodeAt(i) & 255;
    var view = scratch.subarray(0, str.length);
    if (leadingZeroBits(byseHash(view)) >= difficulty) return String(s);
    s++;
    if ((s & 1023) === 0 && Date.now() - t0 > (maxMs || 20000)) return null;
  }
}

// ─── Stage D: captcha → playback → AES-GCM decrypt ────────────────────────
async function resolveByseSources(embedUrl, attest) {
  var u = new URL(embedUrl);
  var code = u.pathname.split("/").pop();
  if (!code) return null;

  // 5. captcha challenge
  var cRes = await fetchRaw("https://mfw09.org/api/videos/" + code + "/embed/captcha", {
    method: "POST", headers: CHROME_HEADERS, body: "{}", timeout: 12000,
  });
  if (cRes.status !== 200) { console.log("[ZXCStream] captcha " + cRes.status); return null; }
  var ch = JSON.parse(cRes.body);
  if (!ch.pow_nonce || !ch.pow_token) { console.log("[ZXCStream] captcha payload missing"); return null; }

  // 6. solve + verify
  var solution = solveBysePoW(ch.pow_nonce, ch.pow_difficulty || 16, 15000);
  if (!solution) { console.log("[ZXCStream] PoW timeout"); return null; }
  var vRes = await fetchRaw("https://mfw09.org/api/videos/" + code + "/embed/captcha/verify", {
    method: "POST", headers: CHROME_HEADERS,
    body: JSON.stringify({ pow_token: ch.pow_token, solution: solution }), timeout: 12000,
  });
  if (vRes.status !== 200) { console.log("[ZXCStream] captcha/verify " + vRes.status); return null; }
  var vd = JSON.parse(vRes.body);
  if (vd.status !== "ok" || !vd.token) { console.log("[ZXCStream] verify status " + (vd.status || "?")); return null; }

  // 7. playback (attestation body is snake_case — verified 200)
  var pbHeaders = Object.assign({}, CHROME_HEADERS, { "X-Captcha-Token": vd.token });
  var pbBody = { fingerprint: { viewer_id: attest.viewer_id, device_id: attest.device_id, confidence: attest.confidence } };
  var pbRes = await fetchRaw("https://mfw09.org/api/videos/" + code + "/embed/playback", {
    method: "POST", headers: pbHeaders, body: JSON.stringify(pbBody), timeout: 15000,
  });
  if (pbRes.status !== 200) { console.log("[ZXCStream] playback " + pbRes.status + " (upstream gate — honest zero until it relents)"); return null; }
  var pbd = JSON.parse(pbRes.body);
  var pl = pbd && pbd.playback;
  if (!pl || !Array.isArray(pl.key_parts) || !pl.iv || !pl.payload) {
    console.log("[ZXCStream] playback payload missing");
    return null;
  }

  // 8. AES-256-GCM — key = key_parts[version-1] ++ key_parts[30-version]
  var parts = pl.key_parts;
  var ver = Number(pl.version);
  var i1 = ver - 1, i2 = 30 - ver;
  function part(idx) {
    if (idx < 0 || idx >= parts.length || typeof parts[idx] !== "string") return null;
    return Buffer.from(parts[idx].replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - parts[idx].replace(/-/g, "+").replace(/_/g, "/").length % 4) % 4), "base64");
  }
  var p1 = part(i1), p2 = part(i2);
  var key = (p1 && p2) ? Buffer.concat([p1, p2]) : Buffer.concat(parts.map(part));
  if (key.length !== 32) { console.log("[ZXCStream] bad key length " + key.length); return null; }
  var ivB = Buffer.from(pl.iv.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - pl.iv.replace(/-/g, "+").replace(/_/g, "/").length % 4) % 4), "base64");
  var dataB = Buffer.from(pl.payload.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - pl.payload.replace(/-/g, "+").replace(/_/g, "/").length % 4) % 4), "base64");
  var tag = dataB.subarray(dataB.length - 16);
  var ct = dataB.subarray(0, dataB.length - 16);
  var decipher = crypto.createDecipheriv("aes-256-gcm", key, ivB);
  decipher.setAuthTag(tag);
  var plain;
  try { plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"); }
  catch (e) { console.log("[ZXCStream] decrypt failed: " + e.message.slice(0, 60)); return null; }
  var cfg;
  try { cfg = JSON.parse(plain); } catch (e) { return null; }
  return cfg;
}

// ─── Stage E: subtitles from the sentinel sub.info JSON ───────────────────
// qqgcdn.cloud sits behind CF bot-fight: plain-node TLS 403s, Chrome-JA3
// (got-scraping) passes — h2 first, h1 fallback, then give up (cosmetic).
var _gsMod = null;
async function getGotScraping() {
  if (_gsMod !== null) return _gsMod;
  try { _gsMod = await import("got-scraping"); } catch (e) { _gsMod = false; }
  return _gsMod;
}
async function fetchSubtitleTracks(embedUrl) {
  try {
    var u = new URL(embedUrl);
    var subInfo = u.searchParams.get("sub.info");
    if (!subInfo) return [];
    var gs = await getGotScraping();
    var body = "";
    if (gs) {
      for (var h = 0; h < 3 && !body; h++) {
        try {
          if (h === 2) await new Promise(function (r) { setTimeout(r, 900); }); // cross the CF window
          var gr = await gs.gotScraping(subInfo, {
            headers: { "User-Agent": UA, Referer: "https://mfw09.org/" },
            timeout: { request: 10000 }, throwHttpErrors: false, http2: h !== 1,
          });
          if (gr.statusCode === 200) body = typeof gr.body === "string" ? gr.body : String(gr.body || "");
          else console.log("[ZXCStream] sub.info attempt " + h + " status " + gr.statusCode);
        } catch (e) { console.log("[ZXCStream] sub.info attempt " + h + " threw: " + String(e && e.message ? e.message : e).slice(0, 60)); }
      }
    } else {
      var r = await fetchRaw(subInfo, { headers: { Referer: "https://mfw09.org/", "User-Agent": UA }, timeout: 10000 });
      if (r.status === 200) body = r.body;
    }
    if (!body) { console.log("[ZXCStream] sub.info fetch failed (all transports)"); return []; }
    var arr = null;
    try { arr = JSON.parse(body); } catch (e) { console.log("[ZXCStream] sub.info JSON parse failed"); return []; }
    if (!Array.isArray(arr)) return [];
    return arr.filter(function (s) { return s && typeof s.file === "string" && /^https?:\/\//.test(s.file); })
      .map(function (s, i) {
        var label = (s.label || "Subtitles").toString();
        return { id: ("zxc" + i).slice(0, 8), url: s.file, lang: label.slice(0, 8), name: label };
      });
  } catch (e) { return []; }
}

// ─── TMDB info ────────────────────────────────────────────────────────────
function getTMDBInfo(tmdbId, type) {
  var endpoint = type === "tv" ? "tv" : "movie";
  var url = "https://api.themoviedb.org/3/" + endpoint + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  return fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) })
    .then(function (r) { return r.text(); })
    .then(function (body) {
      var d = JSON.parse(body);
      if (!d || d.success === false) return null;
      return {
        title: type === "tv" ? d.name : d.title,
        year: ((d.first_air_date || d.release_date || "") + "").split("-")[0],
        imdbId: (d.external_ids && d.external_ids.imdb_id) || (d.imdb_id || ""),
        type: type
      };
    })
    .catch(function () { return null; });
}

// ─── main ─────────────────────────────────────────────────────────────────
async function getStreams(tmdbId, type, season, episode) {
  var isMovie = type !== "tv";
  console.log("[ZXCStream] Request: tmdb=" + tmdbId + " type=" + type +
    (isMovie ? "" : " S" + season + "E" + episode));

  try {
    var info = await getTMDBInfo(tmdbId, type);
    if (!info || !info.title) { console.log("[ZXCStream] Could not resolve TMDB info"); return []; }
    console.log("[ZXCStream] TMDB: " + info.title + " (" + info.year + ")");

    var resolved = await resolveEmbed(tmdbId, isMovie ? "movie" : "tv", season, episode, info.imdbId);
    if (!resolved) { console.log("[ZXCStream] No embed resolved — returning 0 streams"); return []; }
    console.log("[ZXCStream] embed: " + resolved.embed.slice(0, 90));

    var attest = await attestation();
    if (!attest) { console.log("[ZXCStream] no attestation — returning 0 streams"); return []; }

    var cfg = await resolveByseSources(resolved.embed, attest);
    if (!cfg || !Array.isArray(cfg.sources) || cfg.sources.length === 0) {
      console.log("[ZXCStream] no playable sources decrypted — honest zero");
      return [];
    }

    var subs = await fetchSubtitleTracks(resolved.embed);
    console.log("[ZXCStream] " + cfg.sources.length + " source(s), " + subs.length + " subtitle track(s)");

    var titleLine = info.title + (isMovie ? "" : " S" + String(season || 1).padStart(2, "0") + "E" + String(episode || 1).padStart(2, "0")) + " (" + info.year + ")";
    var streams = [];
    for (var i = 0; i < cfg.sources.length; i++) {
      var src = cfg.sources[i];
      if (!src || typeof src.url !== "string" || !/^https?:\/\//.test(src.url)) continue;
      var isHls = /mpegurl|\.m3u8/i.test((src.mime_type || "") + " " + src.url);
      var height = Number(src.height) || 0;
      var quality = src.label || (height ? height + "p" : "HD");
      streams.push({
        name: PROVIDER_NAME + " - " + quality,
        title: titleLine,
        url: src.url,
        quality: quality,
        type: isHls ? "hls" : "mp4",
        // Referer here sets meta.nuvioReferer → NuvioExtractor routes the
        // m3u8 through /proxy (whole-tree URL rewriting). REQUIRED: the
        // sprintcdn media tokens are bound to the IP that fetched the
        // playback config (live-measured: 200 from the minting IP, 404 from
        // any other) — the /proxy fetches from the server that minted them.
        headers: { "User-Agent": UA, "Referer": "https://mfw09.org/" },
        behaviorHints: { bingeGroup: "zxcstream-" + (isHls ? "hls" : "mp4") },
        ...(subs.length > 0 ? { subtitles: subs } : {}),
      });
    }
    console.log("[ZXCStream] Returning " + streams.length + " extracted stream(s)");
    return streams;
  } catch (err) {
    console.log("[ZXCStream] Error: " + (err && err.message ? err.message : err));
    return [];
  }
}

module.exports = { getStreams: getStreams };
