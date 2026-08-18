#!/usr/bin/env python3
"""Fetch and analyze neodrivev2.5.min.js to find the API endpoint
that hubdrive.tips uses to load file content via JS."""
import re
import urllib.request

URL = "https://hubdrive.tips/assets/js/neodrivev2.5.min.js?v=5"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

req = urllib.request.Request(URL, headers={"User-Agent": UA, "Referer": "https://hubdrive.tips/"})
with urllib.request.urlopen(req, timeout=30) as resp:
    js = resp.read().decode("utf-8", errors="replace")

print(f"=== js length: {len(js)} chars ===")
print()

# Look for URL patterns
print("--- /api/ paths ---")
for m in re.findall(r'/api/[a-zA-Z0-9_/{}.\-]+', js):
    print(f"  {m}")
print()

print("--- fetch() calls ---")
for m in re.findall(r'fetch\(\s*[\'"]([^\'"]+)', js):
    print(f"  {m[:120]}")
print()

print("--- $.ajax / $.get / $.post ---")
for m in re.findall(r'\$\.(?:ajax|get|post|getJSON)\(\s*[\'"]([^\'"]+)', js):
    print(f"  {m[:120]}")
print()

print("--- url: properties ---")
for m in re.findall(r'url\s*:\s*[\'"]([^\'"]+)', js):
    print(f"  {m[:120]}")
print()

print("--- /file/, /ajax/, /dl/, /download/, /get/ paths ---")
for m in re.findall(r'[\'"](/[a-zA-Z][a-zA-Z0-9_/.-]*)[\'"]', js):
    if any(k in m for k in ['/file', '/ajax', '/dl', '/download', '/get', '/api', '/link', '/stream', '/server']):
        print(f"  {m}")
print()

print("--- location.pathname / window.location usage ---")
for m in re.findall(r'(?:location|window\.location)\.[\w]+', js):
    pass
# Check for path parsing — extracting ID from URL
if 'pathname' in js:
    idx = js.find('pathname')
    while idx != -1:
        snippet = js[max(0, idx-60):idx+200].replace('\n', ' ')
        print(f"  pathname usage: ...{snippet}...")
        idx = js.find('pathname', idx+1)
        if idx > 10000: break
print()

# Save the full JS for inspection
with open('/tmp/neodrive.js', 'w') as f:
    f.write(js)
print("Full JS saved to /tmp/neodrive.js")
print()
print("--- First 1500 chars of JS ---")
print(js[:1500])
