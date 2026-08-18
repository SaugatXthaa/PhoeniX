#!/usr/bin/env python3
"""Test MoviesHunt fix: starts server, tests multiple movies + full stream
pipeline, then shuts down — all in one process so the server can't die
between commands."""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

PORT = 7000
BASE = f"http://localhost:{PORT}"

MOVIES = [
    ("155",   "The Dark Knight (2008)"),
    ("299536", "Avengers: Endgame (2019)"),
    ("597",   "Titanic (1997)"),
    ("19995", "Avatar (2009)"),
    ("603",   "The Matrix (1999)"),
]


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


def http_get(path, timeout=120):
    try:
        with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", errors="replace")
    except Exception as e:
        return None, f"EXCEPTION: {e}"


def main():
    print("=" * 70)
    print("Starting PhoeniX addon with movieshunt.casa fix...")
    print("=" * 70)
    proc = subprocess.Popen(
        ["node", "src/index.js"],
        cwd="/home/z/my-project",
        stdout=open("/tmp/phoenix-mhtest.log", "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        if not wait_for_health():
            print("FAILED: server did not become healthy")
            print(open("/tmp/phoenix-mhtest.log").read()[-2000:])
            return 1
        print(f"Server healthy (pid {proc.pid})")
        print()

        # ---- TEST 1: /debug/source/movieshunt for several movies ----
        print("=" * 70)
        print("TEST 1: /debug/source/movieshunt for 5 movies")
        print("EXPECT: count > 0 for most movies")
        print("=" * 70)
        any_success = False
        for tmdb_id, name in MOVIES:
            status, body = http_get(f"/debug/source/movieshunt?type=movie&id=tmdb:{tmdb_id}", timeout=60)
            if status != 200:
                print(f"  tmdb:{tmdb_id} {name[:40]} -> HTTP {status} FAIL")
                continue
            try:
                d = json.loads(body)
                count = d.get("count", 0)
                dur = d.get("durationMs", 0)
                timed_out = d.get("timedOut", False)
                results = d.get("results", [])[:2]
                print(f"  tmdb:{tmdb_id} {name[:40]:42s} -> count={count} dur={dur}ms timedOut={timed_out}")
                for r in results:
                    print(f"      {r.get('url','')[:90]}")
                if count > 0:
                    any_success = True
            except Exception as e:
                print(f"  tmdb:{tmdb_id} {name[:40]} -> parse error: {e}")
        print()
        if not any_success:
            print("FAIL: no movies returned any streams")
            return 2
        print("PASS: at least one movie returned streams")
        print()

        # ---- TEST 2: Full /stream pipeline ----
        print("=" * 70)
        print("TEST 2: /stream/movie/tmdb:155.json — full pipeline")
        print("EXPECT: at least one stream with 'MoviesHunt' in name")
        print("=" * 70)
        status, body = http_get("/stream/movie/tmdb:155.json", timeout=180)
        if status != 200:
            print(f"FAIL: HTTP {status}")
            print(body[:500])
            return 3
        try:
            d = json.loads(body)
        except Exception as e:
            print(f"FAIL: JSON parse error: {e}")
            print(body[:500])
            return 3
        streams = d.get("streams", [])
        mh_streams = [s for s in streams if "movieshunt" in (s.get("name","") + s.get("title","")).lower()]
        print(f"total streams: {len(streams)}")
        print(f"movieshunt streams: {len(mh_streams)}")
        for s in mh_streams[:5]:
            print(f"  name: {s.get('name','')[:75]}")
            print(f"  url:  {s.get('url','')[:100]}")
            print()
        if len(mh_streams) == 0:
            print("FAIL: no MoviesHunt streams in full pipeline")
            return 3
        # Check they're playable
        playable = 0
        for s in mh_streams:
            url = s.get("url","")
            if "/proxy?" in url or "/extract?" in url or "vcloud.fit" in url or "hubcloud" in url:
                playable += 1
        print(f"playable (proxy/extract/direct): {playable}/{len(mh_streams)}")
        if playable == 0:
            print("FAIL: streams exist but none are playable")
            return 3
        print("PASS: MoviesHunt streams in pipeline are playable")
        print()

        # ---- TEST 3: Regression — verify 4khdhub still works ----
        print("=" * 70)
        print("TEST 3 (regression): /debug/source/4khdhub (must still work)")
        print("=" * 70)
        status, body = http_get("/debug/source/4khdhub?type=movie&id=tmdb:155", timeout=90)
        if status != 200:
            print(f"FAIL: HTTP {status}")
            return 4
        try:
            d = json.loads(body)
            count = d.get("count", 0)
            print(f"4khdhub: count={count}")
            if count == 0:
                print("FAIL: 4khdhub returned 0 streams (regression!)")
                return 4
            print("PASS: 4khdhub still returns streams (no regression)")
        except Exception as e:
            print(f"FAIL: parse error: {e}")
            return 4
        print()

        # ---- TEST 4 (regression): fourkhdhubone (my earlier fix) ----
        print("=" * 70)
        print("TEST 4 (regression): /debug/source/fourkhdhubone")
        print("=" * 70)
        status, body = http_get("/debug/source/fourkhdhubone?type=movie&id=tmdb:155", timeout=90)
        if status != 200:
            print(f"FAIL: HTTP {status}")
            return 5
        try:
            d = json.loads(body)
            count = d.get("count", 0)
            print(f"fourkhdhubone: count={count}")
            if count == 0:
                print("FAIL: fourkhdhubone returned 0 streams (regression!)")
                return 5
            # Verify URLs are hubcloud.ist (not broken hubdrive.tips)
            results = d.get("results", [])
            hubcloud_count = sum(1 for r in results if "hubcloud" in r.get("url",""))
            hubdrive_count = sum(1 for r in results if "hubdrive" in r.get("url",""))
            print(f"  hubcloud.ist URLs: {hubcloud_count}")
            print(f"  hubdrive.tips URLs: {hubdrive_count} (should be 0)")
            if hubdrive_count > 0:
                print("FAIL: still returning hubdrive.tips URLs")
                return 5
            print("PASS: fourkhdhubone returns hubcloud.ist URLs only (my fix intact)")
        except Exception as e:
            print(f"FAIL: parse error: {e}")
            return 5
        print()

        print("=" * 70)
        print("ALL TESTS PASSED")
        print("=" * 70)
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
