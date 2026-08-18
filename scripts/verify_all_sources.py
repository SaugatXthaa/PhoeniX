#!/usr/bin/env python3
"""Comprehensive verification of ALL sources.
Tests each source against LIVE Render service with appropriate content:
  - Movie sources: The Dark Knight (tmdb:155) + Avengers Endgame (tmdb:299536)
  - Series sources: GoT S1E1 (tmdb:1399:1:1)
  - Anime sources: Demon Slayer S1E1 (tmdb:85937:1:1)

A source is considered WORKING if ANY test returns >0 streams.
Reports per-source status + categorizes working/broken/empty.
"""
import concurrent.futures
import json
import sys
import time
import urllib.request

BASE = "https://phoenix-hgs3.onrender.com"

# Test cases — each source tested against the most appropriate content
MOVIE_TESTS = ["155", "299536"]  # TDK, Avengers Endgame
SERIES_TEST = "1399:1:1"  # GoT S1E1
ANIME_TEST = "85937:1:1"  # Demon Slayer S1E1

# Sources that are anime-only (series) — test with Demon Slayer
ANIME_ONLY = {
    "9anime", "animeflix", "animegg", "animekai", "animesuge", "animeworld",
    "animeworldindia", "animesdigital", "animezey", "anineko", "anipriv8",
    "anivault", "anibd", "anichan", "anidoor", "anikage", "anikoto",
    "anikototv", "animesalt", "hianime", "2dhive",
}
# Sources that are series-only (no movies)
SERIES_ONLY = {
    "oneshows",
}
# Sources that are movies-only (no series)
MOVIES_ONLY = {
    "uhdmovies", "movieblast", "movies4u", "dahmermovies", "dahmermovies4k",
    "playimdb", "vidlove", "acermovies",
}


def http_get(path, timeout=70):
    try:
        req = urllib.request.Request(BASE + path, headers={"User-Agent": "PhoeniX-test/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return None, f"EXCEPTION: {e}"


def get_all_source_ids():
    try:
        with urllib.request.urlopen(f"{BASE}/health", timeout=15) as r:
            return json.loads(r.read().decode()).get("sources", [])
    except Exception as e:
        print(f"ERROR getting source list: {e}")
        return []


def test_source(source_id):
    """Test a source with appropriate content. Return (status, count, dur, first_url)."""
    tests = []
    if source_id in ANIME_ONLY:
        tests.append(("series", ANIME_TEST))
    elif source_id in SERIES_ONLY:
        tests.append(("series", SERIES_TEST))
    elif source_id in MOVIES_ONLY:
        for mid in MOVIE_TESTS:
            tests.append(("movie", mid))
    else:
        # General source — try movie first, then series
        for mid in MOVIE_TESTS:
            tests.append(("movie", mid))
        tests.append(("series", SERIES_TEST))

    best = ("empty", 0, 0, "")
    for ct, tid in tests:
        status, body = http_get(f"/debug/source/{source_id}?type={ct}&id=tmdb:{tid}", timeout=70)
        if status != 200:
            continue
        try:
            d = json.loads(body)
            if d.get("timedOut"):
                if best[0] != "ok":
                    best = ("timeout", 0, d.get("durationMs", 0), "")
                continue
            count = d.get("count", 0)
            results = d.get("results", [])
            first_url = results[0].get("url", "")[:80] if results else ""
            dur = d.get("durationMs", 0)
            if count > 0:
                return ("ok", count, dur, first_url)
            # Track the best non-zero result
            if best[0] == "empty" and dur > best[2]:
                best = ("empty", 0, dur, first_url)
        except Exception:
            pass
    return best


def main():
    print("=" * 80)
    print("COMPREHENSIVE SOURCE VERIFICATION — LIVE Render service")
    print(f"  Movie tests: TDK (tmdb:155), Avengers Endgame (tmdb:299536)")
    print(f"  Series test: GoT S1E1 (tmdb:1399:1:1)")
    print(f"  Anime test:  Demon Slayer S1E1 (tmdb:85937:1:1)")
    print("=" * 80)
    print()

    source_ids = get_all_source_ids()
    print(f"Found {len(source_ids)} sources. Testing each with appropriate content...")
    print(f"Concurrency: 5 parallel requests (avoid CF rate limits)")
    print()

    results = {}
    start = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        futures = {ex.submit(test_source, sid): sid for sid in source_ids}
        done = 0
        for fut in concurrent.futures.as_completed(futures):
            sid = futures[fut]
            try:
                results[sid] = fut.result()
            except Exception as e:
                results[sid] = ("error", 0, 0, str(e)[:80])
            done += 1
            if done % 10 == 0 or done == len(source_ids):
                print(f"  {done}/{len(source_ids)} done ({time.time()-start:.0f}s)")

    # Categorize
    working = [(sid, r) for sid, r in results.items() if r[0] == "ok"]
    empty = [(sid, r) for sid, r in results.items() if r[0] == "empty"]
    timeouts = [(sid, r) for sid, r in results.items() if r[0] == "timeout"]
    errors = [(sid, r) for sid, r in results.items() if r[0] == "error"]

    print()
    print("=" * 80)
    print(f"RESULTS — {len(source_ids)} sources tested (total: {time.time()-start:.0f}s)")
    print("=" * 80)

    # Working sources
    print(f"\n--- WORKING: {len(working)} / {len(source_ids)} ---")
    for sid, (status, count, dur, url) in sorted(working, key=lambda x: -x[1][1]):
        print(f"  {sid:22s}  streams={count:3d}  dur={dur:5d}ms  {url[:55]}")

    # Empty sources
    if empty:
        print(f"\n--- EMPTY (returned 0 streams): {len(empty)} ---")
        for sid, (status, count, dur, url) in sorted(empty, key=lambda x: x[0]):
            print(f"  {sid:22s}  dur={dur:5d}ms  {url[:55]}")

    if timeouts:
        print(f"\n--- TIMEOUT: {len(timeouts)} ---")
        for sid, (status, count, dur, url) in sorted(timeouts, key=lambda x: x[0]):
            print(f"  {sid:22s}  dur={dur:5d}ms")

    if errors:
        print(f"\n--- ERRORS: {len(errors)} ---")
        for sid, (status, count, dur, url) in sorted(errors, key=lambda x: x[0]):
            print(f"  {sid:22s}  {url[:60]}")

    print()
    print("=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print(f"  WORKING:  {len(working):3d} / {len(source_ids)}  ({100*len(working)/len(source_ids):.0f}%)")
    print(f"  EMPTY:    {len(empty):3d} / {len(source_ids)}  ({100*len(empty)/len(source_ids):.0f}%)")
    print(f"  TIMEOUT:  {len(timeouts):3d} / {len(source_ids)}")
    print(f"  ERRORS:   {len(errors):3d} / {len(source_ids)}")

    # Save full results
    with open("/tmp/all_sources_verify.json", "w") as f:
        json.dump({sid: list(r) for sid, r in results.items()}, f, indent=2)
    print(f"\nFull results saved to /tmp/all_sources_verify.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
