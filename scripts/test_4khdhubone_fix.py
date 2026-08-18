#!/usr/bin/env python3
"""Start the PhoeniX addon locally, run end-to-end tests for the
4khdhub_one.cjs fix, then shut it down cleanly.

Tests:
  1. /debug/source/fourkhdhubone — should now return hubcloud.ist URLs
     (previously returned hubdrive.tips which is broken).
  2. /extract on a hubcloud.ist URL — should 302 to pixel.hubcloud.cx.
  3. /stream/movie/tmdb:155.json — should include 4khdhubone streams
     that resolve to playable CDN URLs (not 503s).
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
TMDB_ID = "155"  # The Dark Knight (2008)

# hubcloud.ist URL extracted from 4khdhub.one post page for TDK
TEST_HUBCLOUD_URL = "https://hubcloud.ist/drive/imx13ptkm3kyley"


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


def http_get(path, method="GET", headers=None, timeout=90, allow_redirects=False):
    url = BASE + path
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        if allow_redirects:
            # default behavior follows redirects
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, dict(resp.headers), resp.read().decode("utf-8", errors="replace"), resp.url
        else:
            # manual — don't follow redirects
            opener = urllib.request.build_opener(NoRedirect)
            try:
                with opener.open(req, timeout=timeout) as resp:
                    return resp.status, dict(resp.headers), resp.read().decode("utf-8", errors="replace"), resp.url
            except urllib.error.HTTPError as e:
                return e.code, dict(e.headers), e.read().decode("utf-8", errors="replace"), url
    except Exception as e:
        return None, {}, f"EXCEPTION: {e}", url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # don't follow redirects


def main():
    print("=" * 70)
    print("Starting PhoeniX addon locally...")
    print("=" * 70)
    proc = subprocess.Popen(
        ["node", "src/index.js"],
        cwd="/home/z/my-project",
        stdout=open("/tmp/phoenix-test.log", "w"),
        stderr=subprocess.STDOUT,
        # put the server in its own process group so it survives
        start_new_session=True,
    )
    try:
        if not wait_for_health():
            print("FAILED: server did not become healthy")
            print(open("/tmp/phoenix-test.log").read()[-2000:])
            return 1
        print(f"Server healthy (pid {proc.pid})")
        print()

        # ---- TEST 1 ----
        print("=" * 70)
        print("TEST 1: /debug/source/fourkhdhubone?type=movie&id=tmdb:155")
        print("EXPECT: hubcloud.ist URLs (not hubdrive.tips)")
        print("=" * 70)
        status, hdrs, body, _ = http_get(f"/debug/source/fourkhdhubone?type=movie&id=tmdb:{TMDB_ID}", timeout=90)
        print(f"HTTP {status}")
        if status != 200:
            print(f"FAIL: expected 200, got {status}")
            print(body[:500])
            return 2
        try:
            d = json.loads(body)
        except Exception as e:
            print(f"FAIL: JSON parse error: {e}")
            print(body[:500])
            return 2
        results = d.get("results", [])
        print(f"count: {d.get('count')}")
        hubcloud_count = 0
        hubdrive_count = 0
        other_count = 0
        for r in results:
            url = r.get("url", "")
            m = r.get("meta", {})
            if "hubcloud" in url:
                hubcloud_count += 1
                marker = "HUBCLOUD"
            elif "hubdrive" in url:
                hubdrive_count += 1
                marker = "HUBDRIVE"
            else:
                other_count += 1
                marker = "OTHER"
            print(f"  [{marker}] h={m.get('height')} | {m.get('title','')[:55]}")
            print(f"           {url[:100]}")
        print()
        print(f"Summary: hubcloud={hubcloud_count}, hubdrive={hubdrive_count}, other={other_count}")
        if hubdrive_count > 0:
            print("FAIL: still returning hubdrive.tips URLs (broken)")
            return 2
        if hubcloud_count == 0:
            print("FAIL: no hubcloud.ist URLs returned")
            return 2
        print("PASS: returning hubcloud.ist URLs only")
        print()

        # ---- TEST 2 ----
        print("=" * 70)
        print(f"TEST 2: /extract?url={TEST_HUBCLOUD_URL}&index=0")
        print("EXPECT: HTTP 302 to pixel.hubcloud.cx or workers.dev")
        print("=" * 70)
        from urllib.parse import quote
        encoded = quote(TEST_HUBCLOUD_URL, safe="")
        status, hdrs, body, final_url = http_get(f"/extract?url={encoded}&index=0", timeout=90)
        print(f"HTTP {status}")
        loc = hdrs.get("location") or hdrs.get("Location") or ""
        print(f"Location: {loc[:130]}")
        if status != 302:
            print(f"FAIL: expected 302, got {status}")
            print(body[:300])
            return 3
        if "hubcloud.cx" not in loc and "workers.dev" not in loc and "googleusercontent" not in loc and "hubcdn" not in loc:
            print(f"FAIL: redirect target does not look like a CDN URL: {loc[:100]}")
            return 3
        print("PASS: 302 redirect to CDN URL")
        print()

        # ---- TEST 3 ----
        print("=" * 70)
        print(f"TEST 3: /stream/movie/tmdb:{TMDB_ID}.json (full pipeline)")
        print("EXPECT: at least one stream with '4KHDHub.one' in the name")
        print("=" * 70)
        status, hdrs, body, _ = http_get(f"/stream/movie/tmdb:{TMDB_ID}.json", timeout=180)
        print(f"HTTP {status}")
        if status != 200:
            print(f"FAIL: expected 200, got {status}")
            print(body[:500])
            return 4
        try:
            d = json.loads(body)
        except Exception as e:
            print(f"FAIL: JSON parse error: {e}")
            print(body[:500])
            return 4
        streams = d.get("streams", [])
        print(f"total streams: {len(streams)}")
        one_streams = [s for s in streams if "4khdhub.one" in (s.get("name","") + s.get("title","")).lower() or "4khdhubone" in (s.get("name","") + s.get("title","")).lower()]
        print(f"4khdhub.one streams: {len(one_streams)}")
        for s in one_streams[:6]:
            print(f"  name: {s.get('name','')[:75]}")
            print(f"  url:  {s.get('url','')[:110]}")
            print()
        if len(one_streams) == 0:
            print("FAIL: no 4khdhub.one streams in full pipeline")
            # show what hub-related streams ARE present
            hub_streams = [s for s in streams if "hubcloud" in s.get("url","").lower() or "hubdrive" in s.get("url","").lower() or "hub" in s.get("name","").lower()]
            print(f"  (for context: {len(hub_streams)} hub-related streams total)")
            for s in hub_streams[:3]:
                print(f"    {s.get('name','')[:60]} -> {s.get('url','')[:80]}")
            return 4
        # verify they're playable (URL is /proxy or direct CDN, not /extract)
        playable = 0
        for s in one_streams:
            url = s.get("url","")
            if "/proxy?" in url or "pixel.hubcloud.cx" in url or "workers.dev" in url or "googleusercontent" in url:
                playable += 1
        print(f"playable (proxy/CDN): {playable}/{len(one_streams)}")
        if playable == 0:
            print("FAIL: streams exist but none are playable (proxy/CDN)")
            return 4
        print("PASS: 4khdhub.one streams are in the pipeline and playable")
        print()

        print("=" * 70)
        print("ALL TESTS PASSED")
        print("=" * 70)
        return 0
    finally:
        # kill the server process group
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
