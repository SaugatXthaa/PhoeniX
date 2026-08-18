#!/usr/bin/env python3
"""Trace MoviesHunt source behavior by mimicking what it does:
1. Fetch movieshunt.work/?s=dark+knight (should redirect to movieshunt.casa)
2. Parse the HTML for post links
3. Try to match by title + year
"""
import re
import urllib.request

BASE = "https://movieshunt.work"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

# Mimic the source's fetch: ?s= URL
search_url = f"{BASE}/?s=dark+knight"
print(f"=== Fetching: {search_url} ===")
req = urllib.request.Request(search_url, headers={
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en",
})
try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        print(f"Final URL (after redirects): {resp.url}")
        print(f"Status: {resp.status}")
        html = resp.read().decode("utf-8", errors="replace")
        print(f"HTML length: {len(html)}")
        print(f"<title>: {re.search(r'<title[^>]*>([^<]*)</title>', html).group(1)[:120] if re.search(r'<title[^>]*>([^<]*)</title>', html) else 'NONE'}")
        # Look for post links
        # The source looks for a[href*="BASE_URL/"]
        post_links = re.findall(rf'href="({re.escape(BASE)}/[^"]+)"', html)
        # Also look for movieshunt.casa links (in case redirect happened)
        casa_links = re.findall(r'href="(https://movieshunt\.casa/[^"]+)"', html)
        # Any movieshunt.* link
        any_ms_links = re.findall(r'href="(https://movieshunt\.[a-z]+/[^"]+)"', html)
        print(f"Post links (BASE_URL={BASE}): {len(post_links)}")
        print(f"movieshunt.casa links: {len(casa_links)}")
        print(f"any movieshunt.* links: {len(any_ms_links)}")
        if any_ms_links:
            print("First 5 movieshunt links:")
            for u in any_ms_links[:5]:
                print(f"  {u[:100]}")
        # Show first 1000 chars of body
        body_match = re.search(r'<body[^>]*>(.*)</body>', html, re.DOTALL)
        if body_match:
            body = body_match.group(1)
            # Strip scripts/styles
            body = re.sub(r'<script[^>]*>.*?</script>', '', body, flags=re.DOTALL)
            body = re.sub(r'<style[^>]*>.*?</style>', '', body, flags=re.DOTALL)
            text = re.sub(r'<[^>]+>', ' ', body)
            text = re.sub(r'\s+', ' ', text).strip()
            print(f"\nFirst 600 chars of body text:\n{text[:600]}")
except Exception as e:
    print(f"ERROR: {e}")
