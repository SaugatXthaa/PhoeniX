#!/usr/bin/env python3
import re

data = open('/tmp/pengu_inline_0.js').read()

# Find all source definitions
sources = re.findall(r'\{ key: "source_\w+", id: "\w+", name: "[^"]+", tags: \[[^\]]+\] \}', data)
print('=== All PenguPlay sources ===')
for s in sources: print(s)

# Find API endpoints
print('\n=== API endpoints (paths starting with /api, /direct, /stream, /source) ===')
apis = set(re.findall(r'["\x60]/(?:api|direct|stream|source|provider)[^"\x60]*["\x60]', data))
for a in sorted(apis): print(f'  {a}')

# Find fetch calls
print('\n=== Fetch calls ===')
fetches = set(re.findall(r'fetch\s*\(\s*["\x60`]([^"\x60`]+)["\x60`]', data))
for f in sorted(fetches): print(f'  {f}')

# Find URL patterns with http
print('\n=== HTTP URLs ===')
urls = set(re.findall(r'https?://[a-z0-9.\-]+\.[a-z]{2,}[/\w.-]*', data, re.IGNORECASE))
for u in sorted(urls):
    if 'cloudflare' not in u and 'esm.sh' not in u and 'lucide' not in u:
        print(f'  {u}')

# Find the stream resolution logic
print('\n=== Stream resolution context ===')
for m in re.finditer(r'stream|/direct/|external', data, re.IGNORECASE):
    i = m.start()
    ctx = data[max(0,i-100):i+200]
    if '/api' in ctx or '/direct' in ctx or 'fetch' in ctx:
        print(f'  @{i}: ...{ctx}...')
        print()
