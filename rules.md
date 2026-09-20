# rules.md — Non-Negotiable Rules (PhoeniX / ignatiusphoenix)

> Read together with `memory.md`. These rules exist because breaking them caused
> real incidents (task numbers reference `/home/z/my-project/worklog.md`).

## A. Product guarantees (never regress any of these)

1. **No torrent, ever.** P2P/WebTorrent embeds are excluded at extraction (e.g. AniMoTVSlash "Animo" p2pplay).
2. **Every card must be directly playable**: direct HLS/mp4, or wrapped in `/proxy` / `/range-proxy`. Zero html-url cards. Sole exception: ZXCStream player-page flow.
3. **4K priority**: sources supporting up-to-4K sort/rank first (height/bytes ordering + wave-0 4K group). Never downgrade ordering.
4. **Subtitles on every card** (Atlantic pipeline, normalized WebVTT). 100% coverage on warm merged responses is the acceptance bar.
5. **Anime parity**: all anime sources (21 registered incl. ours-only `animotvslash`) must deliver where their upstream is alive; sub+dub both shipped when the site offers them.
6. **Fail honestly**: an upstream dead end must produce a fast, documented zero — never a fake/hardcoded card, never a silent swallow, never a stuck-loading class on our side.

## B. Change discipline

7. **Evidence before code.** No fix without a measured root cause (real logs via `/debug/source` sequential probes, `/debug/stream` timings, ffmpeg probes, or A/B vs orig deployment). "Without guessing" is a hard user requirement.
8. **Minimal diffs.** Touch only the lines the root cause demands. If a fix needs a rewrite of a working source, stop and re-verify the diagnosis. ("Don't mess up / don't break anything unnecessarily.")
9. **Never edit working sources to "improve" them without a failing measurement first.** Task 66 proved byte-identical sources were victims of infra, not code.
10. **Baseline guard before and after** any infra change: `node scripts/task51_verify_all.cjs` must stay 6/6. Use git-stash A/B to attribute failures.
11. **Stale comments are bugs**: when behavior changes, update the comment AT the site (Task 66: the leftover "heavy aggregators go last" note could have resurrected the tail-starvation bug). Never let comments contradict code.
12. **One concept per verdict**: streamGate verdict classes (§4 of memory.md) are measured precedents. New host classes get their own evidence + note string (e.g. `nexabloom-ipclass-gate`); do not loosen 'dead' for a host without proving the device-side story.
13. **The host circuit breaker is file-level-exempt for pixeldrain and MUST STAY that way** (FILE_LEVEL_HOST_RE). Re-tightening it resurrects the Task 66 systemic zero-stream regression.
14. **Scheduling constants are orig-calibrated**: concurrency 15, budget 40s, wave ordering with light-first + cinewave/watchseries/necro at front positions 7–9. Changes require a production-measured reason, not a theory. **The "heavy aggregator" stays — it was measured fast (46 cards @1.5s) and removing it would lose the biggest deliverer.**
15. **Pre-warm must NOT return** (user-ordered removal; it degraded instances — 17-stream incident).
16. **DahmerMovies / DahmerMovies4k stay deleted** (user-ordered).
17. **Cache semantics**: empty results cache 15s max (anti-poisoning), non-empty `min(ttl, 15min)`; sources with signed/expiring URLs may declare shorter `this.ttl` (Task 65 movielinkbd lesson). Never cache errors.
18. **Diagnostic-layer honesty**: `/debug/source` console capture is global — concurrent probes cross-contaminate logs. Sequential probes + unique x-request-ids only. Judge sources on WARM merged rounds (cold r1 under-counts; 15s empty caches + late wave-1 starts).

## C. Upstream reality classes (expected, documented — do not "fix" blindly)

19. Datacenter-IP gates (magiclinks/kmmovies, persianstremio, desiflix workers.dev empty, stellarrip 18-server gate, lh3 403-image, nexabloom 403): addon-side code stays correct + fails fast/honest; device IPs stream. Route such finals DIRECT (NO_REFERER_HOSTS) or 'unknown' them in the gate — never /proxy them from Render.
20. Transport ladders for tarpit hosts: plain fetch before got-scraping where measured (framextv, zoko); workers.dev before tarpitting desitvhub manifest.
21. Site re-uploads/renames happen (animotvslash `-episode-N-2` duplicate slugs; hubcloud TLD moves; zxcstream backend migration): re-RE the live site before touching the parser, and keep the old path as a fallback rung, never a replacement.

## D. Verification & delivery protocol

22. Every fix: local E2E (scratch port, gate-survival + subs + html checks) → baseline guard → commit with task-ID message → push → Render deploy verified (uptime reset + behavior marker) → production merged `/stream` checks on ≥2 titles (cards, per-source groups, 100% subs, 0 html, 4K present, playprobe one card) → only then report.
23. Client truth matters: the acceptance bar is Stremio/Nuvio on the user's device, not just API JSON.
24. Append every task to `/home/z/my-project/worklog.md` (format fixed, append-only). Scripts persist under `scripts/` (taskNN_*.mjs) — they are the reproducible evidence chain; never delete past task scripts.
25. Chat replies stay short; no report/file dumps unless the user asks.

## E. STANDING RULE — every NEW source the user sends (Task 68, user-ordered)

When the user sends a new source URL to add, apply the user's standing prompt to it, every time:

26. **Reverse engineer the site properly and carefully before any code** — live-probe search, catalog pages, episode/movie pages, every player iframe and every server; decode packed JS (FirePlayer packers, base64 payload maps, aes/packed evals) rather than guessing; record every measured fact (endpoints, headers, referer gates, dead services) as comments at the code site.
27. **Direct playable streams** — every card must be directly playable (`/proxy`, `/range-proxy`, or direct + `behaviorHints.proxyHeaders` for client-IP delivery when the CDN 403s datacenter egress / requires Referer). Zero html-url cards.
28. **Correct enriched metadata** — real quality parsed from the source (never a hardcoded guess), audio-track languages surfaced through `audioTracks` → meta flags, honest sizes/labels.
29. **Sub + dub, multi-language, all servers** — ship every language track the site offers (sub and dub) and every working server. For multi-audio HLS masters, surface the language list on the card; never drop a working server.
30. **Up to 4K when the source has it** — report the real max (1080p sources ship 1080p — never fake 4K; 4K sources sort first per rule 3).
31. **Subtitles from the source when it has them** — pass through when present; when absent, universal Atlantic subs attach at StreamResolver level. Never ship a guessed/dead subtitle URL (the old `/cdn/down/<hash>/Subtitle/subtitle_eng.srt` guess 404s — removed).
32. **Only add if it works — and do everything to make it work** — exhaust the paths (direct, relay ladders, alternate TLDs/mirrors, player-domain shortcuts) with MEASUREMENTS before declaring an upstream class. If the upstream gates datacenter egress, document it as an honest-zero class (§C) and keep the source registered + correct so it self-heals if the upstream unblocks; device IPs may still stream.
33. **Never break anything while adding** — the new source is additive: no edits to other sources, no infra changes unless a measured failure demands it, baseline guard 6/6 before and after.
