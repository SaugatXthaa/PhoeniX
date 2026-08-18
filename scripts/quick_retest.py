#!/usr/bin/env python3
"""Quick re-test of empty sources with Avatar (tmdb:19995) — known to work for
hdhub4u, uhdmovies, dahmermovies. Plus Demon Slayer for anime sources."""
import json
import sys
import time
import urllib.request

BASE = "https://phoenix-hgs3.onrender.com"

# Re-test these sources with Avatar (tmdb:19995) and Matrix (tmdb:603)
RETEST_MOVIE = ["19995", "603"]  # Avatar, Matrix
RETEST_ANIME_SERIES = "85937:1:1"  # Demon Slayer

ANIME_SOURCES = {"anidb", "animekai", "animezey", "animegg"}
MOVIE_SOURCES = {"cuevana", "dahmermovies", "dahmermovies4k", "goated", "hdhub4u",
                 "oneembed", "uhdmovies", "vixsrc2", "zinkmovies"}


def http_get(path, timeout=60):
    try:
        req = urllib.request.Request(BASE + path, headers={"User-Agent": "PhoeniX-test/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        return None, f"EXCEPTION: {e}"


def main():
    all_sources = list(ANIME_SOURCES) + list(MOVIE_SOURCES)
    print(f"Re-testing {len(all_sources)} sources with Avatar (tmdb:19995) + Matrix (tmdb:603) + Demon Slayer")
    print()
    now_working = []
    still_broken = []
    for sid in all_sources:
        tests = []
        if sid in ANIME_SOURCES:
            status, body = http_get(f"/debug/source/{sid}?type=series&id=tmdb:{RETEST_ANIME_SERIES}", timeout=60)
            if status == 200:
                try:
                    d = json.loads(body)
                    tests.append(("anime:DemonSlayer", d.get("count", 0), d.get("durationMs", 0)))
                except Exception:
                    pass
        else:
            for mid in RETEST_MOVIE:
                status, body = http_get(f"/debug/source/{sid}?type=movie&id=tmdb:{mid}", timeout=60)
                if status == 200:
                    try:
                        d = json.loads(body)
                        count = d.get("count", 0)
                        dur = d.get("durationMs", 0)
                        tests.append((f"movie:{mid}", count, dur))
                    except Exception:
                        pass
        max_count = max((t[1] for t in tests), default=0)
        if max_count > 0:
            winning = [t for t in tests if t[1] > 0][0]
            now_working.append((sid, max_count, winning[0]))
        else:
            still_broken.append((sid, [(t[0], t[2]) for t in tests]))
        mark = "OK   " if max_count > 0 else "EMPTY"
        print(f"  {mark}  {sid:18s}  max_count={max_count}")

    print()
    print("--- NOW WORKING ---")
    for sid, count, test in now_working:
        print(f"  {sid:18s}  streams={count}  ({test})")
    print()
    print("--- STILL EMPTY ---")
    for sid, tests in still_broken:
        print(f"  {sid:18s}  tested: {tests}")
    print()
    print(f"SUMMARY: now_working={len(now_working)}, still_broken={len(still_broken)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
