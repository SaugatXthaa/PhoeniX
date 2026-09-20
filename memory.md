# memory.md — PhoeniX (ignatiusphoenix) Knowledge Base

> Read this BEFORE touching any code. Every fact here is production-measured,
> not guessed. The full per-task history lives in `/home/z/my-project/worklog.md`
> (append-only, authoritative). Paired rules file: `rules.md` (non-negotiables).

## 1. What this project is

- **Fork**: `SaugatXthaa/ignatiusphoenix` (ours) of `SaugatXthaa/PhoeniX` (orig).
- **Product**: Stremio/Nuvio addon serving movies / series / kdrama / animes from ~72 scraper sources.
- **Production**: https://ignatiusphoenix.onrender.com (Render free tier, 0.1 CPU, multi-instance possible).
- **Orig live deployment (A/B baseline)**: https://phoenix-hgs3.onrender.com — same egress as ours, valid comparison target.
- **Local run**: `node src/index.js` (PORT env, default 7000). No Docker needed for tests.
- **Deploy**: push to `main` → Render auto-deploys (~2–5 min). Verify via `/health` `uptime` reset + a code-behavior marker (e.g. new log line or new endpoint field).

## 2. Architecture map (where things live)

| Path | Role |
|---|---|
| `src/index.js` | Express app: `/stream/:type/:id.json` (single route; series uses COLONS `tt…:1:1` — 4-segment slash path 404s on BOTH ours and orig), `/proxy`, `/range-proxy`, `/health`, `/debug/source/:id`, `/debug/stream`, `/debug/env` |
| `src/utils/StreamResolver.js` | Source scheduling: concurrency 15, THREE-WAVE system, 40s client budget, background tail, card build (sort by height/bytes/4K-first), subtitle attach, streamGate consult |
| `src/utils/streamGate.cjs` | Server-side liveness verdicts for flaky hosts. `alive`/`dead`/`unknown`; only `dead` drops cards. Host circuit breaker + FILE_LEVEL exemption |
| `src/source/*.js` | Source wrappers (search → episode/pages → raw stream objects). Registered in `src/source/index.js` |
| `src/nuvio/*.cjs` | Heavy per-site scrapers (got-scraping/playwright-free), called via `callNuvioProvider` |
| `src/source/nuvioHelpers.js` | `buildStreamResults`: meta building, `NO_REFERER_HOSTS`, subtitle passthrough, referer/origin stamping |
| `src/extractor/*` | URL → final-card resolution (DirectStream, HubCloud, FileMoon, ZXCStream, NuvioExtractor, …) |
| `src/utils/SubtitleFetcher.js` + `subtitle-normalize.cjs` | Atlantic (granite/natsuki) subtitle pipeline, WebVTT normalization |
| `src/source/Source.js` | Per-source result cache: **empty results cached only 15s** (anti-poisoning), non-empty `min(this.ttl, 15min)`; in-flight dedupe |

## 3. Scheduling model (do not casually change)

- `MAX_CONCURRENT_SOURCES = 15` (orig's exact value; Task 56 restored).
- Client budget `STREAM_CLIENT_BUDGET_MS = 40000` (orig's global cutoff; partial=false at ~36s on warm resolves).
- Three waves: `WAVE1_SOURCE_ORDER` (wave 0, ordered — light 1–3s sources first, then cinewave/watchseries/necro at positions 7–9, then 4K-capable group), `WAVE2_SOURCE_IDS` (wave 1), `BACKGROUND_ONLY_SOURCE_IDS` (wave 2). Anime-only sources: wave 1 for series, wave 2 for movies.
- **Order within wave 0 matters** (only 10 slots churn). The old "heavy aggregator goes last" idea was DISPROVED by Task 66 A/B: cinewave = 46 cards @1.5s isolated; tail placement starved it on cold 0.1-CPU boots.
- Post-budget background starts: concurrency drops to `STREAM_BACKGROUND_MAX_CONCURRENT` (2) and waits on the playback gate (no in-flight /proxy work) — Task 54 anti-"loading screen" mechanism. Never remove: it keeps playback responsive while the tail finishes.
- Per-instance memory caches mean background-tail results can be invisible after a multi-instance re-route — sources that matter must land IN-request (that's why desiflix/persianstremio were promoted to wave 2).

## 4. streamGate verdict classes (measured precedents — extend, don't reinvent)

Only GATED_HOST_RE hosts are probed. Verdicts: `alive` (ship, 10min), `dead` (drop, 5min), `unknown` (ship, not cached). Circuit breaker: ≥3 dead in 10min on one HOST opens 5min host-wide instant-dead — **pixeldrain is EXEMPT (FILE_LEVEL_HOST_RE)** because its unit of death is the FILE; Task 66 proved the host-circuit was the systemic "only ~10 sources return streams" regression (live-verified a circuit-dropped URL answering 206).

- `pixeldrain.com|dev` — file-level verdicts: 404/410, JSON, HTML, archive-filename, zip-CT → dead; video CT/filename → alive; **403 body `file_rate_limited`/`captcha_required` → dead; plain 403 → unknown (datacenter gate)**.
- `vimeos.(zip|net)`, `peakstorm.top`, `animeapps.top`, `vidbolt.xyz`, `nhdapi.com`, `anicore.tv` — host-class deaths; circuit BREAKER stays ON for these.
- `lh3.googleusercontent.com` — 403+image → **unknown** (`lh3-hotlink-block`; device IP gets the real file — MoviesHunt anime/movies chains). 200+image body → dead (thumbnail class). Hard 404/410 → dead.
- `fetch.nexabloom.top` / `*.vyrnex.top` (megaplay.buzz anime CDN) — **403 → unknown (`nexabloom-ipclass-gate`, Task 67)**: hard-403s ALL datacenter IPs but serves player residential IPs; that split is the design of `NO_REFERER_HOSTS` direct routing. Task 67 un-dropped ~25 anime cards on production (Raflix MegaPlay, Anikoto, AniMoTVSlash classes).
- DNS NXDOMAIN confirmed twice (OS-resolver recheck) → dead (anicore relay outage pattern).
- `video-downloads.googleusercontent.com` deliberately NOT gated — probes would consume one-time signed tokens.

## 5. Source classes (the "honest zero" map)

Sources verified delivering on production (last full matrix, Task 67): see Section 7. The remaining zeros are DOCUMENTED UPSTREAM classes — do not "fix" them blindly:

- **Datacenter-IP gates on the upstream (work from device IPs, zero from Render)**: kmmovies (magiclinks.lol CF-challenge, fast-honest zero via cfGated propagation), persianstremio (vercel 503 to Render), desiflix (workers.dev answers `{"streams":[]}` to DC), stellarrip (all 18 servers playback-unavailable to DC; protocol verified correct), KMMovies-magiclinks hop.
- **animeworldindia (watchanimeworld.one) — Task 68 re-RE**: the site family (.one AND .top) **403s Render's egress on all WordPress pages while serving other datacenter IPs** (same-moment proof: sandbox 200 / Render 403 via /proxy; both TLDs; search + series + root). The player domain `play.zephyrix.org` IS open from Render (getVideo POST, CDN). Full flow verified working from non-blocked egress: search `/?s=` → `/series|movies/<slug>` → admin-ajax `action_select_season` → `/episode/<slug>-<S>x<E>` → zephyrix `getVideo` POST → signed multi-audio master.m3u8 (jpn/eng/tel/tam/hin audio, 240p→1080p; site has NO 4K). Delivery = direct + proxyHeaders (Referer `https://play.zephyrix.org/` + UA, NO Origin — Origin measured 403 in some windows); grid segments (s11.zn-gridNN.top) hard-require that Referer. Per-language `player1.php` short.icu links are DEAD upstream (NXDOMAIN). 12 public relays measured dead/blocked/auth-walled (allorigins 522, codetabs 502, thingproxy/yacdn/whateverorigin defunct, corsproxy 401, cors.eu.org 429, isomorphic-git 403, test.cors.workers.dev 403, jina/textise CF-challenged by the site). Source is registered + correct (movies enabled, numeric SxE match, multi-audio meta) and self-heals the moment the site unblocks Render or a relay ladder becomes viable — re-probe before touching the code.
- **Site/backend dead**: animeflix (wp-json + ?s= search return empty), anineko (search returns no results), videasy/videasyto (speedracelight seed 502 — orig is zero too, byte-identical code).
- **CineHDPlus is series-only by design** (movies route through verhdlink).
- **Stellar (stellar.to family)** vs StellarRip (stellar.rip, 18 servers) are different sources.
- movielinkbd: site rotates subdomains (.li URLs are CF-gated aliases; scraper auto-resolves live base); series posts are ONE-PER-SEASON — season-aware post ordering shipped (Task 65).
- ZXCStream: full Byse chain (challenge → PoW custom hash → captcha → AES-GCM) in `src/nuvio/zxcstream.cjs`; media tokens are IP-BOUND → cards carry `Referer: mfw09.org` and route through /proxy. Player-page HTML exception lives here.
- MovieBlast ported verbatim from orig (Task 66) — keep as the parity reference for future orig diffs.

## 6. The orig-vs-fork comparison (Task 66 — method that found the root causes)

Method: clone orig to `/home/z/my-project/phoenix-orig`, boot BOTH locally on :7001/:7002 same egress for cold-cache A/B, PLUS use the orig live deployment for per-source `/debug/source` A/B (orig HAS `/debug/source/:sourceId` too). Compare per-source counts, not totals.

Findings: our CineWave/PlayImdb/uhdmovies code was byte-identical to orig all along — the infra (streamGate host-circuit + wave-0 tail) was killing them. Anime A/B (Task 67): ours 16–17/21 vs orig 12/21 delivering on JJK S1E1; only orig-exclusive anime source is `antova` (ours-exclusive: `animotvslash`).

**Lesson: when "most sources return nothing", diff against orig infra first, don't rewrite sources.**

## 7. Verification protocol (works today — reuse it)

1. `/debug/source/:id?type=…&id=…` — per-source isolated probe with captured logs. **Its console capture monkey-patches GLOBAL console → concurrent probes cross-contaminate logs. Run zero-chases SEQUENTIALLY (concurrency 1) and with unique `x-request-id`s.** (Task 67 lesson: an "animegg 0" was a transient timeout; an "animotvslash log" was another probe's lines.)
2. `/debug/stream?type=…&id=…` — per-source timings (status/count/durationMs/queueMs), partial flag, true clientBudgetMs echo. Does NOT echo full stream URLs.
3. Merged `/stream/:type/:id.json` — the client truth. Check: total cards, per-source grouping by name `·` part 3, subtitle coverage 100%, zero html-url cards, 4K presence. Cold boot converges r1 → r2 → r3 (empty-result caches are 15s; wave-1 starts are late on cold) — judge sources on warm rounds, not r1.
4. Local gate E2E: boot on a scratch port, assert cards survive the gate, subs, no html (see `scripts/task67_local_gate.mjs` as the template).
5. Baseline guard: `node scripts/task51_verify_all.cjs` — 6 checks (hdhub4uv2/vixsrc/pantyflix/kmmovies/raflix/bollyflix). Run before AND after any infra change; git-stash A/B when unsure.
6. Playability truth: ffmpeg (=mpv libavformat) probe of the FINAL card URL; mock-matrix proved 416/403/502 kill libavformat while a raw socket reset recovers (Task 62 — the /range-proxy Cues deep-seek fix).

## 8. Subtitles

- Atlantic pipeline = the subtitle providers for ALL sources (granite/natsuki et al.), normalized to WebVTT in `subtitle-normalize.cjs`; coverage must be 100% on merged responses (it is, on warm rounds).
- Cold full-budget rounds can skip the subs phase deadline (pre-existing, self-heals warm — Task 66). A transient 0-sub round = 5min negative cache replaying a transient granite window; next call self-heals.

## 9. Proxy endpoints

- `/proxy` (HLS whole-tree rewriting, referer/origin passthrough) and `/range-proxy` (ranged direct files, 206 semantics, google-family 302-to-direct). Cards must be directly playable via these or direct HLS/mp4 — no html-url cards (sole exception: ZXCStream player-page).
- /range-proxy Matroska Cues deep-seek: upstream ignores Range → proxy must destroy the socket WITHOUT an HTTP status on the 416 path (416/403/502 kill libavformat; connection reset recovers) — Task 62.

## 10. Known environment facts

- Render egress is datacenter-class: CF-challenge/tarpit/403 classes listed in §5 are expected; never route those through /proxy (proxy fetches from Render = same block).
- got-scraping (Chrome JA3) tarpit-hangs on some hosts where plain fetch succeeds (framextv, zoko) → transport ladders try plain fetch FIRST or early (Task 65/64 pattern).
- manifest.desitvhub.eu.org tarpits DC (no headers >12s) — desiflix ladder is workers.dev-first.
- Sandbox/Render clock: totalMs ≈36–44s for full settles; /debug/source hard-wraps at 35s.
- GitHub push token: provided by user in-session (see worklog Task 37+). Keep tokens out of committed files.

## 11. User communication contract

- Short chat replies. Do NOT paste reports/files/logs into chat unless explicitly asked. No artificial "End of report" markers.
- User needs streams that PLAY in Stremio/Nuvio on device — a datacenter-gated upstream is still "working" if device IPs play, but say so honestly and only with measurements.

## 12. Task 70 invariants — cache/lockout class (regression "you broke 4khdhub/desiflix/2peckle")

- A response must NEVER ship while a wave-0 source is still resolving: early ship is gated on wave0Settled >= wave0Total (StreamResolver.js). Early ship only trims a small, already-settled wave-1/2 tail.
- Failures are NEVER cached as empty (Source.js rethrows; Task 69 fix2 reverted). One contention timeout must cost one round, never a lockout. /debug/source still surfaces real errors (handleInternal direct).
- No empty-result cache exceeds 60s (ladder [15s,60s,60s]; the 5min rung turned CF soft-blocks into multi-minute source invisibility).
- Per-source in-module negative caches must be SHORT (4khdhub_one greenmotors: 90s neg / 30min pos; the 30min null TTL pinned "Resolved 0 file URLs" per title for half an hour). Cached-path calls must still thread fetcher/ctx.
- desiflix: upstream addon (desitvhub Azure) is flaky (30-95s chains, empty windows) and vixsrc.to playlists are its main deliverable — vixsrc.to CF-blocks datacenter IPs (403 in 0.037s = edge ASN block); cards ship DIRECT with nuvioDirectWithHeaders + Referer/Origin vixsrc.to (player-IP delivery, peraspera class). desiflix/vixsrc/peckle are wave-0 now.
- Verification pattern that caught it: /debug/source isolation (server) + clean-network sandbox A/B + per-source count@durationMs from /debug/stream. "count 0 at ~100ms duration" = cached empty; same scrape 200-from-sandbox = contention transient, not source death.
