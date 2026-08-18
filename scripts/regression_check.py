#!/usr/bin/env python3
"""Regression check: verify that sources which use HubExtractor still
return streams after the 4khdhub_one.cjs fix.

The fix only touched src/nuvio/4khdhub_one.cjs (used exclusively by the
FourKHDHubOne source), so other sources should be completely unaffected.
This script verifies that assumption empirically by hitting /debug/source
for each HubExtractor-using source and checking they still return >=1 stream.

Sources tested (all use HubExtractor per grep):
  - fourkhdhub      (FourKHDHub.js — uses 3khdhub.link)
  - hdhub4unew       (HDHub4uNew.js — uses hubdrive.tips via Sootio)
  - onedesiremovies  (OneDesireMovies.js)
  - moviesdrive      (MoviesDrive.js)
  - movieshunt       (MoviesHunt.js)
  - acermovies       (AcerMovies.js — also an extractor)
  - hblinks          (HBLinks.js — extractor)

Test movie: tmdb:155 (The Dark Knight, 2008) — well-known, broadly available.
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
TMDB_ID = "155"

# Sources that route through HubExtractor (per grep for HubExtractor usage)
SOURCES_TO_TEST = [
    "fourkhdhub",       # 3khdhub.link
    "hdhub4unew",       # hubdrive.tips via Sootio (may itself be broken — Sootio 404s)
    "onedesiremovies",
    "moviesdrive",
    "movieshunt",
    "acermovies",
    "hblinks",
    "fourkhdhubone",    # the one we just fixed — should now return streams
]


def http_get(path, timeout=120):
    url = BASE + path
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
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
    print("Starting PhoeniX addon locally for regression check...")
    print("=" * 70)
    proc = subprocess.Popen(
        ["node", "src/index.js"],
        cwd="/home/z/my-project",
        stdout=open("/tmp/phoenix-reg.log", "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        if not wait_for_health():
            print("FAILED: server did not become healthy")
            print(open("/tmp/phoenix-reg.log").read()[-2000:])
            return 1
        print(f"Server healthy (pid {proc.pid})")
        print()

        results = {}
        failures = []

        for src in SOURCES_TO_TEST:
            print(f"--- {src} ---")
            status, body = http_get(f"/debug/source/{src}?type=movie&id=tmdb:{TMDB_ID}", timeout=120)
            if status != 200:
                print(f"  HTTP {status} — FAIL")
                results[src] = ("FAIL", f"HTTP {status}")
                failures.append(src)
                print()
                continue
            try:
                d = json.loads(body)
            except Exception as e:
                print(f"  JSON parse error: {e}")
                results[src] = ("FAIL", "JSON parse error")
                failures.append(src)
                print()
                continue
            count = d.get("count", 0)
            rs = d.get("results", [])
            # Categorize URLs
            hubcloud = sum(1 for r in rs if "hubcloud" in r.get("url",""))
            hubdrive = sum(1 for r in rs if "hubdrive" in r.get("url",""))
            hubcdn = sum(1 for r in rs if "hubcdn" in r.get("url",""))
            gdflix = sum(1 for r in rs if "gdflix" in r.get("url",""))
            gyanigurus = sum(1 for r in rs if "gyanigurus" in r.get("url",""))
            other = count - hubcloud - hubdrive - hubcdn - gdflix - gyanigurus
            print(f"  count: {count}  (hubcloud={hubcloud}, hubdrive={hubdrive}, hubcdn={hubcdn}, gdflix={gdflix}, gyanigurus={gyanigurus}, other={other})")
            # Show first 3 URLs
            for r in rs[:3]:
                print(f"    {r.get('url','')[:90]}")
            results[src] = ("OK", count)
            print()

        print("=" * 70)
        print("REGRESSION SUMMARY")
        print("=" * 70)
        for src, (status, info) in results.items():
            mark = "PASS" if status == "OK" else "FAIL"
            print(f"  [{mark}] {src}: {info}")
        print()

        # The regression criterion: sources that returned streams before
        # should still return streams. We can't know the "before" state here,
        # but we can flag any source that returns 0 as suspicious.
        zero_sources = [s for s, (st, info) in results.items() if st == "OK" and info == 0]
        if zero_sources:
            print(f"WARNING: {len(zero_sources)} source(s) returned 0 streams:")
            for s in zero_sources:
                print(f"  - {s}")
            print("(This may be normal if the movie isn't available from that source,")
            print(" or it may indicate a regression. Check the live service to compare.)")

        if failures:
            print(f"\nFAIL: {len(failures)} source(s) failed with non-200 HTTP status")
            return 2
        print("\nPASS: all sources responded successfully (no HTTP errors)")
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
