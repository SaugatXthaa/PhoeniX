#!/usr/bin/env python3
"""Fetch a 4khdhub.one post page for 'The Dark Knight' and dump all
hubcloud / hubdrive / hubcdn links present, so we can see what the
scraper has to work with."""
import re
import sys
import urllib.request

# 4khdhub.one search URL for "The Dark Knight"
SEARCH = "https://4khdhub.one/?s=The+Dark+Knight"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def fetch(url, referer=None):
    headers = {"User-Agent": UA, "Accept": "text/html,*/*"}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace"), resp.url


# Step 1: search
search_html, _ = fetch(SEARCH)
print(f"=== search page: {len(search_html)} chars ===")

# Find post URLs matching /title-movie-123/ or /title-series-456/
post_urls = re.findall(r'href="(/[^"]+-(?:movie|series)-\d+/?)"', search_html)
post_urls = list(dict.fromkeys(post_urls))  # dedupe
print(f"post URLs found: {len(post_urls)}")
for u in post_urls[:8]:
    print(f"  https://4khdhub.one{u}")
print()

if not post_urls:
    print("No posts found — aborting")
    sys.exit(0)

# Step 2: fetch the first matching post
post_url = "https://4khdhub.one" + post_urls[0]
print(f"=== fetching post: {post_url} ===")
post_html, _ = fetch(post_url, referer="https://4khdhub.one/")
print(f"post html: {len(post_html)} chars")
print()

# Step 3: extract ALL hubcloud / hubdrive / hubcdn links
print("--- All hub* links on the post page ---")
all_links = re.findall(r'href="(https?://[^"]*(?:hubcloud|hubdrive|hubcdn|gdflix|gyanigurus)[^"]*)"', post_html, re.IGNORECASE)
uniq = list(dict.fromkeys(all_links))
print(f"total: {len(all_links)}, unique: {len(uniq)}")
for u in uniq[:20]:
    print(f"  {u[:150]}")
print()

# Step 4: show context around each hub link (the <a> text + nearby badges)
print("--- Context around each unique hub link ---")
for u in uniq[:10]:
    # find the link in the html and show surrounding context
    idx = post_html.find(u)
    if idx == -1:
        continue
    start = max(0, idx - 400)
    end = min(len(post_html), idx + len(u) + 200)
    snippet = post_html[start:end]
    # extract just the <a> tag and any badges near it
    print(f"  URL: {u[:120]}")
    # find the <a ...>...</a> containing this URL
    a_match = re.search(r'<a\b[^>]*href="' + re.escape(u) + r'"[^>]*>([^<]*)</a>', post_html)
    if a_match:
        print(f"  <a> text: {a_match.group(1).strip()[:80]}")
    # find nearest badges
    badges = re.findall(r'<span[^>]*class="[^"]*badge[^"]*"[^>]*>([^<]*)</span>', snippet)
    if badges:
        print(f"  nearby badges: {badges[:5]}")
    print()
