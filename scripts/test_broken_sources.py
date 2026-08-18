#!/usr/bin/env python3
"""Test the 12 broken movie sources locally (with my 2 fixes) AND on live
(pre-my-fix code), to identify which sources my fixes may have broken
vs which were already broken before my changes.

Run on LOCAL only — the live comparison is done separately."""
import concurrent.futures
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

PORT = 7000
BASE = f"http://localhost:{PORT}"

# Test the 12 "broken" sources + 3 sanity-check sources (4khdhub, fourkhdhubone, movieshunt)
SOURCES_TO_TEST = [
    "cinejoy", "cuevana", "desiflix", "goated", "hdhub4u", "oneembed",
    "oneshows", "peckle", "uhdmovies", "vidlove", "vixsrc2", "zxcstream",
    # sanity checks
    "4khdhub", "fourkhdhubone", "movieshunt",
]


def http_get(path, timeout=70):
    try:
        req = urllib.request.Request(BASE + path, headers={"User-Agent": "PhoeniX-test/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return None, f"EXCEPTION: {e}"


def test_source(sid, content_type, test_id):
    status, body = http_get(f"/debug/source/{sid}?type={content_type}&id=tmdb:{test_id}", timeout=70)
    if status != 200:
        return ("http_error", 0, 0, "", f"HTTP {status}")
    try:
        d = json.loads(body)
        if d.get("timedOut"):
            return ("timeout", 0, d.get("durationMs", 0), "", "timed out")
        count = d.get("count", 0)
        results = d.get("results", [])
        first_url = results[0].get("url", "")[:80] if results else ""
        return ("ok" if count > 0 else "empty", count, d.get("durationMs", 0), first_url, "")
    except Exception as e:
        return ("error", 0, 0, "", str(e)[:200])


def wait_for_health(timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{BASE}/health", timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.5)
    return False


def main():
    print("=" * 70)
    print("LOCAL test (with my 2 fixes) — 12 'broken' sources + 3 sanity checks")
    print("=" * 70)
    proc = subprocess.Popen(
        ["node", "src/index.js"],
        cwd="/home/z/my-project",
        stdout=open("/tmp/phoenix-broken-test.log", "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        if not wait_for_health():
            print("FAILED: server did not become healthy")
            return 1
        print(f"Server healthy (pid {proc.pid})")
        print(f"Testing 12 broken + 3 sanity sources against Avengers Endgame (tmdb:299536)")
        print()

        results = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
            futures = {ex.submit(test_source, sid, "movie", "299536"): sid for sid in SOURCES_TO_TEST}
            for fut in concurrent.futures.as_completed(futures):
                sid = futures[fut]
                try:
                    results[sid] = fut.result()
                except Exception as e:
                    results[sid] = ("error", 0, 0, "", str(e)[:200])

        # Sort by status then name
        for sid in sorted(results.keys()):
            status, count, dur, url, err = results[sid]
            mark = "OK   " if status == "ok" else "EMPTY"
            if status == "timeout": mark = "TMOUT"
            if status in ("error", "http_error"): mark = "ERROR"
            print(f"  {mark}  {sid:15s}  count={count:3d}  dur={dur:6d}ms  {url[:55]}{err[:55]}")

        # Compare to live results
        live_results = {
            "cinejoy": 0, "cuevana": 0, "desiflix": 1, "goated": 0, "hdhub4u": 0,
            "oneembed": 1, "oneshows": 0, "peckle": 6, "uhdmovies": 0, "vidlove": 0,
            "vixsrc2": 0, "zxcstream": 0,
        }
        print()
        print("=" * 70)
        print("COMPARISON: local (my fixes) vs live (old code)")
        print("=" * 70)
        print(f"  {'source':15s} {'live':>6s} {'local':>6s}  {'verdict':15s}")
        regressions = []
        improvements = []
        for sid in SOURCES_TO_TEST[:12]:
            local_count = results.get(sid, ("empty", 0))[1]
            live_count = live_results.get(sid, 0)
            if local_count > 0 and live_count == 0:
                verdict = "LOCAL FIXED"
                improvements.append(sid)
            elif local_count == 0 and live_count > 0:
                verdict = "*** REGRESSION ***"
                regressions.append((sid, live_count, local_count))
            elif local_count > 0 and live_count > 0:
                verdict = "BOTH WORKING"
            else:
                verdict = "BOTH BROKEN"
            print(f"  {sid:15s} {live_count:6d} {local_count:6d}  {verdict}")

        if regressions:
            print()
            print(f"!!! REGRESSIONS DETECTED: {len(regressions)}")
            for sid, lc, loc in regressions:
                print(f"  - {sid}: live={lc} -> local={loc}")
            return 2
        print()
        print("No regressions detected.")
        return 0
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=5)
        except Exception:
            try: proc.kill()
            except Exception: pass


if __name__ == "__main__":
    sys.exit(main())
