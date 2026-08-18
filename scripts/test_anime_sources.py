#!/usr/bin/env python3
"""Test all 22 anime sources with appropriate anime content.

Test cases:
  - Demon Slayer S1E1 (tmdb:85937:1:1) — for series-capable sources
  - Your Name (tmdb:372058) — for movie-capable sources (popular anime movie)

A source is considered WORKING if EITHER test returns >0 streams.
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

# All 22 anime-related sources
ANIME_SOURCES = [
    "2dhive", "9anime", "anibd", "anichan", "anidb", "anidoor", "anikage",
    "anikoto", "anikototv", "animeflix", "animegg", "animekai", "animesalt",
    "animesdigital", "animesuge", "animeworld", "animeworldindia", "animezey",
    "anineko", "anipriv8", "anivault", "hianime",
]

# Series-only sources (skip movie test)
SERIES_ONLY = {"anikototv", "animesalt", "animesdigital", "animeworldindia", "animezey"}

# Test cases
SERIES_TEST = ("series", "85937:1:1")  # Demon Slayer: Kimetsu no Yaiba S1E1
MOVIE_TEST = ("movie", "372058")  # Your Name (2016)


def http_get(path, timeout=70):
    try:
        req = urllib.request.Request(BASE + path, headers={"User-Agent": "PhoeniX-test/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except Exception as e:
        return None, f"EXCEPTION: {e}"


def test_source(source_id, content_type, test_id):
    path = f"/debug/source/{source_id}?type={content_type}&id=tmdb:{test_id}"
    status, body = http_get(path, timeout=70)
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
    print("Anime sources — comprehensive test with proper anime content")
    print("=" * 70)
    proc = subprocess.Popen(
        ["node", "src/index.js"],
        cwd="/home/z/my-project",
        stdout=open("/tmp/phoenix-animetest.log", "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        if not wait_for_health():
            print("FAILED: server did not become healthy")
            return 1
        print(f"Server healthy (pid {proc.pid})")
        print(f"Testing {len(ANIME_SOURCES)} anime sources with:")
        print(f"  - Series test: Demon Slayer S1E1 (tmdb:85937:1:1)")
        print(f"  - Movie test:  Your Name (tmdb:372058) — only for movie-capable sources")
        print()

        # Submit both tests in parallel for each source
        tasks = []  # list of (source_id, content_type, test_id)
        for sid in ANIME_SOURCES:
            tasks.append((sid, *SERIES_TEST))
            if sid not in SERIES_ONLY:
                tasks.append((sid, *MOVIE_TEST))

        results = {}  # source_id -> {"series": result, "movie": result}
        for sid in ANIME_SOURCES:
            results[sid] = {}

        start = time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
            futures = {}
            for sid, ct, tid in tasks:
                futures[ex.submit(test_source, sid, ct, tid)] = (sid, ct)
            for fut in concurrent.futures.as_completed(futures):
                sid, ct = futures[fut]
                try:
                    results[sid][ct] = fut.result()
                except Exception as e:
                    results[sid][ct] = ("error", 0, 0, "", str(e)[:200])

        # Categorize
        working = []
        broken = []
        for sid in ANIME_SOURCES:
            series_r = results[sid].get("series", ("empty", 0, 0, "", "not tested"))
            movie_r = results[sid].get("movie", ("empty", 0, 0, "", "not tested"))
            if series_r[0] == "ok" or movie_r[0] == "ok":
                working.append((sid, series_r, movie_r))
            else:
                broken.append((sid, series_r, movie_r))

        print("=" * 70)
        print(f"RESULTS — {len(ANIME_SOURCES)} anime sources (took {time.time()-start:.0f}s)")
        print("=" * 70)

        print(f"\n--- WORKING: {len(working)} ---")
        for sid, s, m in sorted(working):
            s_str = f"series={s[1]}" if s[0] == "ok" else "series=0"
            m_str = f"movie={m[1]}" if m[0] == "ok" else ("movie=n/a" if m == ("empty",0,0,"","not tested") else "movie=0")
            url = (s[3] if s[0] == "ok" else m[3])[:60]
            print(f"  {sid:22s} {s_str:10s} {m_str:12s}  {url}")

        print(f"\n--- BROKEN: {len(broken)} ---")
        for sid, s, m in sorted(broken):
            s_str = f"series={s[1]}({s[2]}ms)" if s[0] != "not tested" else "series=n/a"
            m_str = f"movie={m[1]}({m[2]}ms)" if m[0] != "not tested" else "movie=n/a"
            err = s[4] or m[4]
            print(f"  {sid:22s} {s_str:25s} {m_str:25s}  {err[:50]}")

        print()
        print("=" * 70)
        print("SUMMARY")
        print("=" * 70)
        print(f"  WORKING: {len(working)} / {len(ANIME_SOURCES)}")
        print(f"  BROKEN:  {len(broken)} / {len(ANIME_SOURCES)}")

        # Save full results
        with open("/tmp/anime_test_results.json", "w") as f:
            json.dump({sid: {"series": list(r.get("series", ())), "movie": list(r.get("movie", ()))} for sid, r in results.items()}, f, indent=2)
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
