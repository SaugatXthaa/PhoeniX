#!/usr/bin/env python3
"""Test all 5 newly added sources one by one.
Starts server, tests each source, captures logs, then shuts down."""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request

PORT = 7000
BASE = f"http://localhost:{PORT}"

# (source_id, content_type, test_id, description)
TESTS = [
    ("cinejoy", "movie", "155", "The Dark Knight"),
    ("uhdmovies", "movie", "155", "The Dark Knight"),
    ("hdhub4u", "movie", "155", "The Dark Knight"),
    ("zxcstream", "movie", "155", "The Dark Knight"),
    ("animezey", "series", "85937:1:1", "Demon Slayer S1E1"),
]


def http_get(path, timeout=60):
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
    print("Testing 5 new sources (cinejoy, uhdmovies, hdhub4u, zxcstream, animezey)")
    print("=" * 70)
    proc = subprocess.Popen(
        ["node", "src/index.js"],
        cwd="/home/z/my-project",
        stdout=open("/tmp/phoenix-new5.log", "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        if not wait_for_health():
            print("FAILED: server did not become healthy")
            print(open("/tmp/phoenix-new5.log").read()[-2000:])
            return 1
        print(f"Server healthy (pid {proc.pid})")
        print()

        results = {}
        for sid, ct, tid, desc in TESTS:
            print(f"--- {sid} ({desc}, tmdb:{tid}) ---")
            start_lines = sum(1 for _ in open("/tmp/phoenix-new5.log"))
            status, body = http_get(f"/debug/source/{sid}?type={ct}&id=tmdb:{tid}", timeout=60)
            if status != 200:
                print(f"  HTTP {status} — FAIL")
                results[sid] = ("fail", f"HTTP {status}")
                print()
                continue
            try:
                d = json.loads(body)
                count = d.get("count", 0)
                dur = d.get("durationMs", 0)
                timed_out = d.get("timedOut", False)
                results_list = d.get("results", [])
                print(f"  count={count}  dur={dur}ms  timedOut={timed_out}")
                for r in results_list[:3]:
                    url = r.get("url", "")
                    m = r.get("meta", {})
                    h = m.get("height", "?")
                    print(f"    h={h} | {url[:90]}")
                results[sid] = ("ok" if count > 0 else "empty", count)
            except Exception as e:
                print(f"  parse error: {e}")
                results[sid] = ("error", str(e)[:100])

            # Show relevant log lines
            with open("/tmp/phoenix-new5.log") as f:
                lines = f.readlines()
            new_lines = lines[start_lines:]
            for line in new_lines:
                ll = line.lower()
                if sid in ll or "error" in ll or "warn" in ll or "fail" in ll:
                    print(f"  LOG: {line.rstrip()[:120]}")
            print()

        print("=" * 70)
        print("SUMMARY")
        print("=" * 70)
        working = []
        broken = []
        for sid, (status, info) in results.items():
            mark = "OK   " if status == "ok" else "BROKEN"
            print(f"  {mark}  {sid:15s}  {info}")
            if status == "ok":
                working.append(sid)
            else:
                broken.append(sid)
        print()
        print(f"Working: {len(working)} / 5 — {working}")
        print(f"Broken:  {len(broken)} / 5 — {broken}")
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
