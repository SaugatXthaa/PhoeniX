#!/usr/bin/env python3
"""Systematically test ALL sources against tmdb:155 (The Dark Knight, 2008)
to determine which are working vs broken.

Uses the LOCAL server (with my fixes committed), so the results reflect
what the live service WILL look like once Render deploys.

Concurrency: 6 parallel requests to avoid CF rate-limiting.
Per-source timeout: 60s (the /debug/source endpoint has a 35s internal cap
plus 5s buffer for network).

Output: clean categorized table — Working / Empty / Timeout / Error.
"""
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
TMDB_ID = "155"  # The Dark Knight (2008)


def get_all_source_ids():
    """Fetch /health which lists all source IDs in order."""
    try:
        with urllib.request.urlopen(f"{BASE}/health", timeout=10) as r:
            d = json.loads(r.read().decode())
            return d.get("sources", [])
    except Exception as e:
        print(f"ERROR getting source list: {e}")
        return []


def test_source(source_id):
    """Test a single source, return (status, count, duration_ms, first_url, error)."""
    url = f"{BASE}/debug/source/{source_id}?type=movie&id=tmdb:{TMDB_ID}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "PhoeniX-test/1.0"})
        with urllib.request.urlopen(req, timeout=70) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            d = json.loads(body)
            if d.get("timedOut"):
                return ("timeout", 0, d.get("durationMs", 0), "", "source timed out (35s internal cap)")
            count = d.get("count", 0)
            results = d.get("results", [])
            first_url = results[0].get("url", "")[:80] if results else ""
            return ("ok" if count > 0 else "empty", count, d.get("durationMs", 0), first_url, "")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:200]
        return ("http_error", 0, 0, "", f"HTTP {e.code}: {body}")
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
    print("Starting PhoeniX addon locally (with my 2 fixes)...")
    print("=" * 70)
    proc = subprocess.Popen(
        ["node", "src/index.js"],
        cwd="/home/z/my-project",
        stdout=open("/tmp/phoenix-alltest.log", "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        if not wait_for_health():
            print("FAILED: server did not become healthy")
            print(open("/tmp/phoenix-alltest.log").read()[-2000:])
            return 1
        print(f"Server healthy (pid {proc.pid})")
        print()

        source_ids = get_all_source_ids()
        print(f"Found {len(source_ids)} sources")
        print(f"Testing all against tmdb:{TMDB_ID} (The Dark Knight, 2008)")
        print(f"Concurrency: 6 parallel requests")
        print("=" * 70)

        results = {}
        start = time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
            futures = {ex.submit(test_source, sid): sid for sid in source_ids}
            for fut in concurrent.futures.as_completed(futures):
                sid = futures[fut]
                try:
                    results[sid] = fut.result()
                except Exception as e:
                    results[sid] = ("error", 0, 0, "", str(e)[:200])
                # progress bar
                done = len(results)
                if done % 10 == 0 or done == len(source_ids):
                    print(f"  {done}/{len(source_ids)} done ({time.time()-start:.0f}s)")

        print()
        print("=" * 70)
        print(f"RESULTS — {len(source_ids)} sources tested (total time: {time.time()-start:.0f}s)")
        print("=" * 70)

        # Categorize
        working = [(sid, r) for sid, r in results.items() if r[0] == "ok"]
        empty = [(sid, r) for sid, r in results.items() if r[0] == "empty"]
        timeouts = [(sid, r) for sid, r in results.items() if r[0] == "timeout"]
        errors = [(sid, r) for sid, r in results.items() if r[0] in ("error", "http_error")]

        def print_section(title, items, show_urls=True):
            print()
            print(f"--- {title}: {len(items)} ---")
            for sid, (status, count, dur, url, err) in sorted(items, key=lambda x: x[0]):
                line = f"  {sid:25s} count={count:3d}  dur={dur:5d}ms"
                if show_urls and url:
                    line += f"  {url[:60]}"
                elif err:
                    line += f"  ERR: {err[:60]}"
                print(line)

        print_section("WORKING (returns streams)", working, show_urls=True)
        print_section("EMPTY (returned 0 streams)", empty, show_urls=False)
        print_section("TIMEOUT (35s internal cap reached)", timeouts, show_urls=False)
        print_section("ERRORS (HTTP error or exception)", errors, show_urls=False)

        print()
        print("=" * 70)
        print("SUMMARY")
        print("=" * 70)
        print(f"  WORKING:  {len(working):3d} / {len(source_ids)}")
        print(f"  EMPTY:    {len(empty):3d} / {len(source_ids)}")
        print(f"  TIMEOUT:  {len(timeouts):3d} / {len(source_ids)}")
        print(f"  ERRORS:   {len(errors):3d} / {len(source_ids)}")
        # Save full results to file for reference
        with open("/tmp/source_test_results.json", "w") as f:
            json.dump({sid: list(r) for sid, r in results.items()}, f, indent=2)
        print()
        print("Full results saved to /tmp/source_test_results.json")
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
