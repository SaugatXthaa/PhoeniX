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

## 13. Task 71 audit map — full production sweep (72 sources, 2026-09-21)

- Audit method (reuse): 3-pass — (a) /debug/source per-source sweep at concurrency 3 (movie=Dune2 tmdb:693134, series=SquidGame tmdb:93405:1:1, anime-only=JJK tmdb:95479:1:1); (b) merged /stream rounds with badge-distribution parse (badge = name split on '·', first non-PhoeniX/non-quality part = sourceLabel); (c) /debug/stream per-source status for merged-path anomalies. Never `| head` a tee (SIGPIPE kills mid-run).
- Label verdict: every sampled card's meta.sourceLabel matches the registry; subSource variants (BollyFlix→Pantyflix, CineFreak/VegaMovies Direct→AcerMovies, MovieHunt→Nuvio) are HONEST extractor-routing labels (the card really rides that extractor's pipeline), not mislabeling. buildName order: quality → sourceLabel → serverName/extractorLabel/provider/subSource.
- Fixed this task: atlantic (artemis flat-playlist branch + aphrodite unsignedGateGet — gate bootstrap 403 forbidden upstream, plain GET serves content; both validated on production: 2 cards); zxcstream (token route bugok→burat, TOKEN_ROUTES ladder burat→bugok→abaygagoka; FIELD_MAP+SECRET unchanged across the rotation); hindmoviez (worker CDN gate upgraded tarpit→fail-fast 401; filterDeadStreams ipClassStatuses opt-in keeps 401/403 for this source only — 15-16 cards isolated); raflix (media/CinePro/VidStorm stages were sequential 12s each → 35s cutoff timeout every merged resolve; Promise.allSettled fan-out → 8 cards @1.5-2.9s); hindmoviez wave promotion medium→wave-0 tail.
- Contention boundary (documented, not a bug): hindmoviez merged delivery = 0 whenever its obfuscated serial chain (5 MvLinks, 30s provider cap) exceeds the 35s resolver cutoff under contention — isolated 15-16 always. desiflix status timeout @36s on flaky desitvhub windows. zxcstream PoW timeouts (mfw09) come and go; the route fix keeps it future-proof through route rotations.
- Upstream outages seen 2026-09-21: api.speedracelight.com 502 (cineby+videasy class), moon.ironwallnet.net 403 WAF block (videasy), mfw09 sentinel 502 windows (zxcstream — recovered same day). These are honest zeros; re-probe before touching code.
- Catalog gaps (correct honest zeros, do NOT "fix"): MovieBox movie search lacks Dune2 (series/other titles fine — fuzzy matcher correctly rejects <60 score); Netlio movie GitHub raw 404 for some tmdb ids (series fine).
- ZXCStream stage-A evidence trail: player.zxcstream.xyz 302s everything to player.zxcprime.xyz; PAGE 200; route lives in chunk 0uktzs59zudq..js → module 55790 (`let r="23423653"` SECRET + FIELD_MAP byte-identical). Sentinel 502 = CF origin down, NOT a route problem (502 body = cloudflare structured error).
- Atlantic edge serving: atlantic.st/edge-*/index.m3u8 flat VOD playlists (8-seg 60s class for Dune2 today = upstream's own placeholder content; segments are real TS, headerless 206). wrapArtemis wraps peraspera/totallyacdn only — edge-* ships direct (headerless-verified). Aphrodite master = 2 variants (3840x1600 + 2592x1080) but its children currently 302 → atlantic.st/test-video HTML placeholder; validation correctly refuses them until the upstream finishes its migration.

## 14. Task 73 invariants — outage fast-fail + the cold-r1 lottery (regression "only 7-8 streams")

- Symptom root cause (measured, not guessed): COLD r1 under 0.1 CPU is a completion lottery at the 40s cap — "client budget 40000ms hit (34/52 sources settled)". Early ship can NEVER fire on cold (needs ≤10 outstanding; cold has ~18-32 at any t<40s, and the Task 70 wave-0 gate needs all ~25 wave-0 settled). Boot-window rounds (Render spin-down wake) are worse: shared-CPU starvation → 1-4 cards. Production warm r2 converges as designed (68 = Task 71 level; Inception 81). The user's "7-8" = first-open experience on cold/boot rounds.
- vidking/speedracelight outage (2026-09-21, CONFIRMED global): www.vidking.net authoritative NS REFUSE globally (CF DoH EDE 22/23 — not sandbox-local); api.speedracelight.com edge 502 CONSTANT (10/10 probes / 2.5min, /seed + all provider servers, movie+series); vidking.com parked; vidking.to/cc/pro + speedracelight.net/to NXDOMAIN. cineby+videasy+vidking extractor honest-zero until recovery; recovery check = `node scripts/task72_srl_window.mjs` (first non-502 seed = back).
- Fast-fail invariant (Task 73, commit 207dd94): a DEFINITIVE edge >=500 on a fresh /seed probe marks the API down for 120s in the shared store (srlSeed.cjs: isSrlDown/markSrlDown/probeSeedDown). Three layers: (1) Cineby/VidEasy wrappers skip at entry (no TMDB calls, 0-1ms honest zero) + probe-before-retry stops the EMPTY_RETRY ladder; (2) speedracelight.js fetchSeed throws instantly for all other consumers (VidKing extractor, cinestream, videasyto.cjs); (3) self-heals via TTL — one live attempt ≤120s after recovery. SCOPE: only confirmed edge 5xx; timeouts/network-errors/honest-empties NEVER mark down (Task 70 failures-never-cached invariant intact for every other class).
- Effect (production measured): cineby 9.3s→4.3s first call → 0ms within TTL; freed wave-0 slots → Inception cold r1 39 cards 4K=14 (best cold r1 in days vs 1-4 class), r2 56.
- Render-spec sandbox is the STANDING test env (scripts/render_sandbox.cjs): 0.1 CPU via SIGSTOP/SIGCONT 100ms duty cycle (CFS quota semantics) + 448MB heap + RSS watchdog. Production-matches on counts/4K/timing/error signatures. Always test under it (user standing order).
- Baseline guard truthfully updated (task23_baseline.mjs): source count 72 (Task 66 movieblast re-port — Task 19 had deleted it, Task 66 re-added by design, expect PRESENT), cineby guard is outage-aware (seed-probe gate: edge 5xx → expect honest-zero fast-fail; alive → >=2 streams), videasyto Part B network-aware (videasy.to WAF-unreachable → INFO-skip, not FAIL). Suite: 42 PASS / 0 FAIL.
- Contention classes re-confirmed 2026-09-21 (NOT code bugs): uhdmovies isolated 5@9.1s clean / >35s+0 on contended Render (chain-sensitive); hindmoviez 16@14.7s isolated / 0 merged; desiflix+acermovies+cinehdplus+persianstremio zeroing from clean network same day (upstream-side windows); moviesdrivev2 4@5.9s isolated. All retry fresh every round (uncached-failure contract) and land via background cache when a round succeeds.

## 15. Task 74 invariants — "UptimeRobot keeps it awake" ≠ warm streams (keep-alive investigation)

- The user keeps the Render free service awake 24/7 with UptimeRobot (ping `/`) and still saw cold-lottery opens. Mechanism (measured): keep-alive only prevents the SPIN-DOWN boot penalty — the per-source stream caches (Source.handle, 15min non-empty TTL) expire independently and a `/` ping never warms them, so EVERY open >15 min since the previous one is a full-cold round on 0.1 CPU (Task 73 lottery). UptimeRobot cannot fix caches.
- Restarts still happen despite keep-alive (deploys, Render platform recycles, OOM) → boot-window rounds (1-4 cards class) remain possible. Task 74 telemetry makes them visible: /health now exposes bootAt, instanceId (RENDER_INSTANCE_ID), memoryMB{rss,heapUsed,heapTotal}, keepalive{rootHits,lastRootHitAt}, cacheKeeper stats — all additive, original fields untouched. `__phoenixBootAt` is finally SET at boot (startedAt used to fall back to per-request Date.now()).
- Multi-instance trap: one keep-alive monitor warms only the instance it lands on; a second sleeping instance = cold boot for the user routed there. Watcher `scripts/task74_health_watch.mjs` flags instanceId alternation + bootAt resets + rootHits cadence (proves whether the monitor actually reaches this deployment). Free-hours math: 24/7 keep-alive ≈ 744h/month — with >1 free service/instance on the account the 750 free hours burn out mid-month and Render suspends spins regardless of UptimeRobot (user should keep 24/7 pinging on ONE service/instance only).
- Cache-Keeper (src/utils/cacheKeeper.js, Task 74): while IDLE (≥CACHE_KEEPER_IDLE_MS=180s with zero /stream activity), re-resolve the user's own recently-opened titles (LRU 5) through the resolver's exact scheduling so the caches their next open hits never go stale. Safety contract: user-titles-only (no catalog/speculative scraping), idle-gated, yields before EVERY source start once a user request lands (in-flight ones finish; inflightHandles dedupes with the user's resolve), memory-gated (rss>440MB skip), conc 3, 20s per-source caps, CACHE_KEEPER=off kill-switch. NOT a prewarm revival — nothing runs at boot and nothing runs before a prior user request (Task 54 standing removal preserved).
- Wave tables (WAVE1_SOURCE_ORDER / WAVE2 / BACKGROUND_ONLY / ANIME_ONLY + waveOf/isScheduled) moved to module scope as exported `orderSourcesForRequest(sources, type)` — single source of truth shared by resolve() and the keeper (keeper-warmed cache == exactly what a warm round uses). Mechanical move; resolve() behavior unchanged (baseline guard 42/0 after).
- Sandbox E2E (scripts/task74_keeper_e2e.mjs, 0.1-CPU throttle): cold r1 Dune2 46 cards (4K=13, html=0) → keeper pass #1 50 sources warmed / 143 cached results @47.5s → [final verdict — see worklog]. Production verification pattern: /health keeper.passes climbs while idle; the deploy-time title stays warm-class at +17min with zero refreshes (15min TTL expired underneath).
