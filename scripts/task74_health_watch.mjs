#!/usr/bin/env node
// task74_health_watch.mjs — production keep-alive watcher (Task 74).
//
// Samples /health on a cadence and flags, with DATA (not guesses):
//   - RESTART / boot recycle: bootAt or instanceId changes between samples
//   - multi-instance: instanceId alternates between two values across samples
//     (an UptimeRobot ping keeps only ONE instance warm — a sleeping second
//     instance wakes COLD for the next user = the "still cold despite
//     UptimeRobot" class)
//   - UptimeRobot reachability: keepalive.rootHits climbing ~1 per monitor
//     interval while bootAt is stable = the monitor IS pointed at this URL
//   - memory trend (OOM pressure on the 512MB free tier)
//   - cache keeper activity: passes / warmed / results / yields
//
// Usage: node scripts/task74_health_watch.mjs [BASE] [SAMPLES] [INTERVAL_S]
//   BASE default https://ignatiusphoenix.onrender.com
//   SAMPLES default 12, INTERVAL_S default 150  (~30 min window)

const BASE = process.argv[2] || 'https://ignatiusphoenix.onrender.com';
const SAMPLES = parseInt(process.argv[3], 10) || 12;
const INTERVAL_S = parseInt(process.argv[4], 10) || 150;

const seen = { bootAts: new Set(), instanceIds: new Set() };
let prev = null;
let rootPingDeltas = 0;
let restarts = 0;

function ts() { return new Date().toISOString().slice(11, 19); }

async function sample() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(`${BASE}/health`, { signal: ac.signal });
    clearTimeout(t);
    return await r.json();
  } catch (e) {
    clearTimeout(t);
    return null;
  }
}

console.log(`[watch] ${BASE} — ${SAMPLES} samples every ${INTERVAL_S}s`);

for (let i = 1; i <= SAMPLES; i++) {
  const h = await sample();
  if (!h) {
    console.log(`${ts()} [#${i}] FETCH FAILED (service down / waking — Render free cold start can take ~60s)`);
  } else {
    seen.bootAts.add(h.bootAt);
    seen.instanceIds.add(h.instanceId);
    const up = Math.round((h.uptime || 0) / 60);
    const k = h.cacheKeeper?.stats || {};
    const line = `${ts()} [#${i}] up=${up}m rss=${h.memoryMB?.rss}MB heap=${h.memoryMB?.heapUsed}MB bootAt=${h.bootAt} inst=${String(h.instanceId).slice(0, 18)} rootHits=${h.keepalive?.rootHits ?? '?'} keeper(passes=${k.passes ?? '?'} warmed=${k.lastPassWarmed ?? '?'} results=${k.lastPassResults ?? '?'} ${k.lastPassMs ?? '?'}ms${k.lastPassYielded ? ' YIELDED' : ''}) hot=${(h.cacheKeeper?.hotKeys || []).length}`;
    console.log(line);
    if (prev) {
      if (h.bootAt !== prev.bootAt) { restarts++; console.log(`${ts()}   ⚠ RESTART/NEW BOOT detected (bootAt changed)`); }
      if (h.instanceId !== prev.instanceId) console.log(`${ts()}   ⚠ INSTANCE SWITCH — multi-instance deployment (load balancer alternates)`);
      const dh = (h.keepalive?.rootHits ?? 0) - (prev.keepalive?.rootHits ?? 0);
      if (dh > 0 && h.bootAt === prev.bootAt) { rootPingDeltas += dh; console.log(`${ts()}   ✓ keepalive ping observed (+${dh}) — monitor IS reaching this deployment`); }
    }
    prev = h;
  }
  if (i < SAMPLES) await new Promise(r => setTimeout(r, INTERVAL_S * 1000));
}

console.log('\n=== SUMMARY ===');
console.log(`distinct bootAt values: ${seen.bootAts.size} (1 = no restart in window)`);
console.log(`distinct instanceIds: ${seen.instanceIds.size} (1 = single instance; >1 = MULTI-INSTANCE — UptimeRobot keeps only one warm)`);
console.log(`restarts detected: ${restarts}`);
console.log(`keepalive pings observed: ${rootPingDeltas} (0 over ~30 min = UptimeRobot is NOT hitting this URL — check the monitor target)`);
