#!/usr/bin/env python3
"""Re-test the 12 empty + 1 timeout sources with MORE movie options.
Some sources may not have TDK or Endgame but have Avatar, Matrix, Titanic, etc."""
import concurrent.futures
import json
import sys
import time
import urllib.request

BASE = "https://phoenix-hgs3.onrender.com"

# Sources that returned 0 in the first test — re-test with more movies
RETEST_SOURCES = [
    "anidb", "animekai", "animezey", "cuevana", "dahmermovies",
    "dahmermovies4k", "goated", "hdhub4u", "oneembed", "uhdmovies",
    "vixsrc2", "zinkmovies", "animegg",
]

# Test each source with 6 different popular movies + anime/series
MOVIE_TESTS = [
    ("155", "The Dark Knight (2008)"),
    ("299536", "Avengers Endgame (2019)"),
    ("19995", "Avatar (2009)"),
    ("603", "The Matrix (1999)"),
    ("597", "Titanic (1997)"),
    ("11", "Star Wars (1977)"),
]
SERIES_TEST = ("1399:1:1", "GoT S1E1")
ANIME_TEST = ("85937:1:1", "Demon Slayer S1E1")


def http_get(path, timeout=70):
    try:
        req = urllib.request.Request(BASE + path, headers={"User-Agent": "PhoeniX-test/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        return None, f"EXCEPTION: {e}"


def test_source_all_movies(source_id):
    """Test a source with ALL movie options + series + anime."""
    results = []
    # Anime-only sources
    anime_only = {"9anime", "animeflix", "animegg", "animekai", "animesuge", "animeworld",
                  "animeworldindia", "animesdigital", "animezey", "anineko", "anipriv8",
                  "anivault", "anibd", "anichan", "anidoor", "anikage", "anikoto",
                  "anikototv", "animesalt", "hianime", "2dhive"}

    if source_id in anime_only:
        ct, tid, name = "series", ANIME_TEST[0], ANIME_TEST[1]
        status, body = http_get(f"/debug/source/{source_id}?type={ct}&id=tmdb:{tid}", timeout=70)
        if status == 200:
            try:
                d = json.loads(body)
                count = d.get("count", 0)
                results.append((f"{ct}:{tid}", count, d.get("durationMs", 0), name))
            except Exception:
                pass
        return results

    # Movies-only or general sources — try all 6 movies
    for mid, name in MOVIE_TESTS:
        status, body = http_get(f"/debug/source/{source_id}?type=movie&id=tmdb:{mid}", timeout=70)
        if status == 200:
            try:
                d = json.loads(body)
                count = d.get("count", 0)
                results.append((f"movie:{mid}", count, d.get("durationMs", 0), name))
                if count > 0:
                    return results  # Found working — stop early
            except Exception:
                pass

    # Also try series
    ct, tid, name = "series", SERIES_TEST[0], SERIES_TEST[1]
    status, body = http_get(f"/debug/source/{source_id}?type={ct}&id=tmdb:{tid}", timeout=70)
    if status == 200:
        try:
            d = json.loads(body)
            count = d.get("count", 0)
            results.append((f"{ct}:{tid}", count, d.get("durationMs", 0), name))
        except Exception:
            pass
    return results


def main():
    print("=" * 80)
    print("RE-TEST: 13 sources that returned 0 — testing with 6 movies + series + anime")
    print("=" * 80)
    print()

    start = time.time()
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        futures = {ex.submit(test_source_all_movies, sid): sid for sid in RETEST_SOURCES}
        for fut in concurrent.futures.as_completed(futures):
            sid = futures[fut]
            try:
                results[sid] = fut.result()
            except Exception as e:
                results[sid] = [("error", 0, 0, str(e)[:60])]

    print(f"Tested {len(RETEST_SOURCES)} sources in {time.time()-start:.0f}s")
    print()

    now_working = []
    still_broken = []

    for sid in RETEST_SOURCES:
        tests = results[sid]
        max_count = max((t[1] for t in tests), default=0)
        if max_count > 0:
            now_working.append((sid, max_count, tests))
        else:
            still_broken.append((sid, tests))

    print("--- NOW WORKING (found streams with different content) ---")
    for sid, count, tests in sorted(now_working, key=lambda x: -x[1]):
        winning = [t for t in tests if t[1] > 0][0]
        print(f"  {sid:18s}  streams={count:3d}  ({winning[3]} — {winning[0]})")

    print(f"\n--- STILL EMPTY (0 streams for all tests) ---")
    for sid, tests in sorted(still_broken, key=lambda x: x[0]):
        print(f"  {sid:18s}  tested {len(tests)} content IDs, all returned 0")

    print()
    print("=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print(f"  NOW WORKING:   {len(now_working):2d} / 13")
    print(f"  STILL BROKEN:  {len(still_broken):2d} / 13")

    # Save
    with open("/tmp/retest_results.json", "w") as f:
        json.dump({sid: tests for sid, tests in results.items()}, f, indent=2)


if __name__ == "__main__":
    sys.exit(main())
