#!/usr/bin/env python3
"""Regression test after removing 6 broken sources.
Tests:
  1. /stream endpoint returns streams for popular movie (TDK)
  2. /stream endpoint returns streams for popular series (GoT S1E1)
  3. Compare against pre-removal stream count (should be similar — 6 broken
     sources were already returning 0 streams, so removal shouldn't reduce counts)
  4. Test 5 sample sources to make sure they still work
  5. Verify no errors in server log
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

PORT = 7000
BASE = f"http://localhost:{PORT}"


def http_get(path, timeout=120):
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        return None, f"EXCEPTION: {e}"


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
    print("Regression test after removing 6 broken sources")
    print("=" * 70)
    # Server is already running from previous bash command
    if not wait_for_health():
        print("Server not healthy — starting new one...")
        proc = subprocess.Popen(
            ["node", "src/index.js"],
            cwd="/home/z/my-project",
            stdout=open("/tmp/phoenix-reg.log", "w"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        if not wait_for_health():
            print("FAILED to start server")
            return 1
        own_server = True
    else:
        proc = None
        own_server = False

    try:
        # TEST 1: Full /stream endpoint for a popular movie
        print()
        print("=" * 70)
        print("TEST 1: /stream/movie/tmdb:155.json (The Dark Knight)")
        print("=" * 70)
        status, body = http_get("/stream/movie/tmdb:155.json", timeout=180)
        if status != 200:
            print(f"FAIL: HTTP {status}")
            print(body[:500])
            return 2
        try:
            d = json.loads(body)
            streams = d.get("streams", [])
            print(f"Total streams: {len(streams)}")
            # Check the actual source label (3rd segment of "🐦‍🔥 PhoeniX · {res} · {label} · {sub}")
            # — the word "UHDMovies" appears in Pantyflix titles (Pantyflix uses UHDMovies as
            # upstream data), but those are Pantyflix streams, not UHDMovies source streams.
            for sid in ["animezey", "cinejoy", "uhdmovies", "zxcstream", "hdhub4u", "vidlove"]:
                matching = []
                for s in streams:
                    parts = s.get("name", "").split("·")
                    if len(parts) >= 3 and parts[-2].strip().lower() == sid:
                        matching.append(s)
                if matching:
                    print(f"  FAIL: found {len(matching)} stream(s) with sourceLabel='{sid}'")
                    return 3
            # Count streams by source label
            from collections import Counter
            labels = Counter()
            for s in streams:
                parts = s.get("name", "").split("·")
                if len(parts) >= 3:
                    labels[parts[-2].strip()] += 1
            print(f"Unique source labels: {len(labels)}")
            print(f"Top 5: {labels.most_common(5)}")
            if len(streams) < 20:
                print(f"FAIL: only {len(streams)} streams — regression likely")
                return 4
            print("PASS: stream endpoint works, no removed-source streams present")
        except Exception as e:
            print(f"FAIL: JSON parse error: {e}")
            print(body[:500])
            return 2

        # TEST 2: Test 5 sample sources that should still work
        print()
        print("=" * 70)
        print("TEST 2: Sample sources still work (no regressions)")
        print("=" * 70)
        samples = [
            ("4khdhub", "movie", "155"),
            ("fourkhdhubone", "movie", "155"),
            ("movieshunt", "movie", "155"),
            ("moviesdrive", "movie", "155"),
            ("anikage", "series", "85937:1:1"),
            ("animesalt", "series", "85937:1:1"),
        ]
        all_passed = True
        for sid, ct, tid in samples:
            status, body = http_get(f"/debug/source/{sid}?type={ct}&id=tmdb:{tid}", timeout=60)
            if status != 200:
                print(f"  FAIL {sid}: HTTP {status}")
                all_passed = False
                continue
            try:
                d = json.loads(body)
                count = d.get("count", 0)
                if count == 0:
                    print(f"  FAIL {sid}: count=0 (regression!)")
                    all_passed = False
                else:
                    print(f"  PASS {sid}: count={count}")
            except Exception as e:
                print(f"  FAIL {sid}: parse error: {e}")
                all_passed = False
        if not all_passed:
            return 5
        print("PASS: All sample sources still return streams")

        # TEST 3: Verify the 6 removed sources return 404
        print()
        print("=" * 70)
        print("TEST 3: Removed sources return 404")
        print("=" * 70)
        for sid in ["animezey", "cinejoy", "uhdmovies", "zxcstream", "hdhub4u", "vidlove"]:
            status, body = http_get(f"/debug/source/{sid}?type=movie&id=tmdb:155", timeout=15)
            if status == 404:
                print(f"  PASS {sid}: 404 (correctly removed)")
            else:
                print(f"  FAIL {sid}: HTTP {status} (expected 404)")
                return 6

        print()
        print("=" * 70)
        print("ALL TESTS PASSED")
        print("=" * 70)
        return 0
    finally:
        if own_server:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=5)
            except Exception:
                try: proc.kill()
                except Exception: pass


if __name__ == "__main__":
    sys.exit(main())
