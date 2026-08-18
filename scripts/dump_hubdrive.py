#!/usr/bin/env python3
"""Dump the hubdrive.tips page HTML so we can see what it actually returns."""
import urllib.request

URL = "https://hubdrive.tips/file/3358522230"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

req = urllib.request.Request(URL, headers={"User-Agent": UA, "Referer": URL, "Accept": "text/html,*/*"})
with urllib.request.urlopen(req, timeout=30) as resp:
    html = resp.read().decode("utf-8", errors="replace")

print(f"=== final URL (after redirects): {resp.url}")
print(f"=== status: {resp.status}")
print(f"=== length: {len(html)}")
print()
print("=== HTML DUMP (first 6000 chars) ===")
print(html[:6000])
print()
print("=== HTML DUMP (last 2000 chars) ===")
print(html[-2000:])
