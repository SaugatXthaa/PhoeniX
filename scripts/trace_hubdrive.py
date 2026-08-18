#!/usr/bin/env python3
"""Trace the HubExtractor resolution path for a hubdrive.tips URL.
Fetches the page and inspects what links/markers are present so we can
understand where HubExtractor.extractViaHubCloud fails."""
import re
import sys
import urllib.request

URL = "https://hubdrive.tips/file/3358522230"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

req = urllib.request.Request(URL, headers={"User-Agent": UA, "Referer": URL})
with urllib.request.urlopen(req, timeout=30) as resp:
    html = resp.read().decode("utf-8", errors="replace")

print(f"html length: {len(html)} chars")
print()

# 1. <title>
m = re.search(r"<title[^>]*>([^<]*)</title>", html)
print(f"<title>: {m.group(1)[:120] if m else 'NONE'}")
print()

# 2. Any links containing hubcloud
hubcloud_links = re.findall(r'https?://[^\s"\'<>]*hubcloud[^\s"\'<>]*', html, re.IGNORECASE)
print(f"hubcloud links: {len(hubcloud_links)}")
for u in hubcloud_links[:8]:
    print(f"  {u[:130]}")
print()

# 3. <a> elements containing the text "HubCloud"
print('--- <a> elements containing text "HubCloud" ---')
# Find <a ...>...</a> blocks whose inner text mentions HubCloud
for m in re.finditer(r'<a\b[^>]*>([^<]*)</a>', html, re.IGNORECASE):
    inner = m.group(1).strip()
    if 'hubcloud' in inner.lower():
        # back up to find the start of this <a> tag to read its href
        start = html.rfind('<a', 0, m.start())
        if start != -1:
            tag = html[start:m.end()-len(inner)-4][:300]
            href_m = re.search(r'href\s*=\s*["\']([^"\']+)["\']', tag, re.IGNORECASE)
            print(f"  text={inner[:50]!r}")
            print(f"  href={href_m.group(1)[:130] if href_m else 'NONE'}")
            print()
print()

# 4. Other host markers
print("--- Other host markers ---")
for pat in ['gyanigurus', 'gamerxyt', 'hubcdn', 'googleusercontent', 'workers.dev', 'hubdrive']:
    matches = re.findall(r'https?://[^\s"\'<>]*' + pat + r'[^\s"\'<>]*', html, re.IGNORECASE)
    if matches:
        uniq = list(dict.fromkeys(matches))
        print(f"{pat}: {len(matches)} total, {len(uniq)} unique")
        for u in uniq[:3]:
            print(f"  {u[:130]}")
print()

# 5. File Size / File size text
print("--- File size markers ---")
for m in re.finditer(r'([Ff]ile [Ss]ize)', html):
    ctx = html[m.start():m.start()+120].replace('\n', ' ')
    print(f"  ...{ctx}...")
print()

# 6. Check for stck() cookie marker (used by hubcloud downstream)
print("--- stck() cookie marker ---")
for m in re.finditer(r'stck\(\s*[\'"](\w+)[\'"]', html):
    print(f"  cookie name: {m.group(1)}")
if not re.search(r'stck\(', html):
    print("  (none — hubdrive page does not set stck cookie, that's hubcloud's job)")
