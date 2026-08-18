#!/usr/bin/env python3
"""Re-test sources that returned 0 for The Dark Knight, using a more
appropriate test case for each source's content type:

  - Anime sources -> tt2861424 (Demon Slayer: Mugen Train) or tmdb:597463
  - Series sources -> tmdb:1399 (Game of Thrones S1E1)
  - Movie sources -> tmdb:299536 (Avengers: Endgame — extremely popular)

This gives a fairer "working vs broken" verdict."""
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

# Map sources to appropriate test IDs.
# Anime sources get an anime movie; everything else gets Avengers Endgame
# (extremely popular, should be on most general movie sites).
# Series-only sources get GoT S1E1.
ANIME_SOURCES = {
    "9anime", "animeflix", "animegg", "animekai", "animesuge", "animeworld",
    "animeworldindia", "animesdigital", "animezey", "anineko", "anipriv8",
    "anivault", "anibd", "anichan", "anidoor", "anikage", "anikoto",
    "anikototv", "animesalt", "hianime", "2dhive",
}
SERIES_SOURCES = {
    "oneshows",  # only series, no movies
}

# Test IDs:
#   Anime movie: Demon Slayer: Mugen Train (tmdb:597463, also tt11032394)
#   Blockbuster movie: Avengers: Endgame (tmdb:299536)
#   Series: Game of Thrones S1E1 (tmdb:1399)
ANIME_TEST = ("movie", "597463")
MOVIE_TEST = ("movie", "299536")
SERIES_TEST = ("series", "1399:1:1")  # GoT S1E1


def http_get(path, timeout=70):
    try:
        req = urllib.request.Request(BASE + path, headers={"User-Agent": "PhoeniX-test/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return None, f"EXCEPTION: {e}"


def test_source_with_id(source_id, content_type, test_id):
    path = f"/debug/source/{source_id}?type={content_type}&id=tmdb:{test_id}"
    status, body = http_get(path, timeout=70)
    if status != 200:
        return ("http_error", 0, 0, "", f"HTTP {status}")
    try:
        d = json.loads(body)
        if d.get("timedOut"):
            return ("timeout", 0, d.get("durationMs", 0), "", "source timed out")
        count = d.get("count", 0)
        results = d.get("results", [])
        first_url = results[0].get("url", "")[:80] if results else ""
        return ("ok" if count > 0 else "empty", count, d.get("durationMs", 0), first_url, "")
    except Exception as e:
        return ("error", 0, 0, "", str(e)[:200])


def pick_test(source_id):
    if source_id in ANIME_SOURCES:
        return ANIME_TEST
    if source_id in SERIES_SOURCES:
        return SERIES_TEST
    return MOVIE_TEST


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
    print("Re-testing EMPTY sources with content-appropriate test cases")
    print("=" * 70)
    proc = subprocess.Popen(
        ["node", "src/index.js"],
        cwd="/home/z/my-project",
        stdout=open("/tmp/phoenix-retest.log", "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        if not wait_for_health():
            print("FAILED: server did not become healthy")
            return 1
        print(f"Server healthy (pid {proc.pid})")
        print()

        # Load the sources that returned empty for TDK
        empty_sources = [
            "2dhive", "9anime", "anibd", "anichan", "anidb", "anidoor", "anikage",
            "anikoto", "anikototv", "animeflix", "animegg", "animekai", "animesalt",
            "animesdigital", "animesuge", "animeworld", "animeworldindia", "animezey",
            "anineko", "anipriv8", "anivault", "cinejoy", "cuevana", "desiflix",
            "goated", "hdhub4u", "hianime", "movieblast", "moviebox", "netlio",
            "oneembed", "oneshows", "peckle", "uhdmovies", "vidlove", "vixsrc2", "zxcstream",
        ]
        print(f"Re-testing {len(empty_sources)} sources with appropriate content")
        print()

        results = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
            futures = {}
            for sid in empty_sources:
                ct, tid = pick_test(sid)
                futures[ex.submit(test_source_with_id, sid, ct, tid)] = (sid, ct, tid)
            for fut in concurrent.futures.as_completed(futures):
                sid, ct, tid = futures[fut]
                try:
                    results[sid] = (ct, tid, fut.result())
                except Exception as e:
                    results[sid] = (ct, tid, ("error", 0, 0, "", str(e)[:200]))

        # Print categorized
        def print_section(title, items):
            print(f"--- {title}: {len(items)} ---")
            for sid, ct, tid, r in sorted(items, key=lambda x: x[0]):
                status, count, dur, url, err = r
                line = f"  {sid:25s}  tmdb:{tid} ({ct:6s})  count={count:3d}  dur={dur:5d}ms"
                if url:
                    line += f"  {url[:55]}"
                elif err:
                    line += f"  ERR: {err[:55]}"
                print(line)
            print()

        # Unpack the (ct, tid, r) tuples into flat tuples for sorting
        def flatten(items):
            return [(sid, ct, tid, r) for sid, (ct, tid, r) in items.items()]

        print_section("NOW WORKING (with appropriate test case)", flatten(now_working_dict := {sid: (ct, tid, r) for sid, (ct, tid, r) in results.items() if r[0] == "ok"}))
        print_section("STILL EMPTY (likely broken)", flatten({sid: (ct, tid, r) for sid, (ct, tid, r) in results.items() if r[0] == "empty"}))
        print_section("TIMEOUT", flatten({sid: (ct, tid, r) for sid, (ct, tid, r) in results.items() if r[0] == "timeout"}))
        print_section("ERRORS", flatten({sid: (ct, tid, r) for sid, (ct, tid, r) in results.items() if r[0] in ("error", "http_error")}))

        print("=" * 70)
        print("FINAL SUMMARY")
        print("=" * 70)
        print(f"  Sources that returned 0 for TDK but work for other content: {sum(1 for ct, tid, r in results.values() if r[0] == 'ok')}")
        print(f"  Sources that returned 0 even with appropriate test:        {sum(1 for ct, tid, r in results.values() if r[0] == 'empty')}")
        print(f"  Timeouts:                                                    {sum(1 for ct, tid, r in results.values() if r[0] == 'timeout')}")
        print(f"  Errors:                                                      {sum(1 for ct, tid, r in results.values() if r[0] in ('error', 'http_error'))}")
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
