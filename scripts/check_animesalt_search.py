#!/usr/bin/env python3
"""Check animesalt.link search results for 'Demon Slayer' to see what's available."""
import re
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# Search for Demon Slayer
url = "https://animesalt.link/?s=Demon+Slayer"
req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://animesalt.link/"})
with urllib.request.urlopen(req, timeout=15) as resp:
    html = resp.read().decode("utf-8", errors="replace")

print(f"html length: {len(html)}")

# Find all /series/ and /movies/ links
series_links = re.findall(r'href="(https://animesalt\.link/series/[^"]+)"', html)
movie_links = re.findall(r'href="(https://animesalt\.link/movies/[^"]+)"', html)
episode_links = re.findall(r'href="(https://animesalt\.link/episode/[^"]+)"', html)

print(f"series links: {len(series_links)}")
for u in series_links[:10]:
    print(f"  {u}")
print(f"movie links: {len(movie_links)}")
for u in movie_links[:10]:
    print(f"  {u}")
print(f"episode links: {len(episode_links)}")
for u in episode_links[:5]:
    print(f"  {u}")

# Show all article blocks
articles = re.findall(r'<article[^>]*>([\s\S]*?)</article>', html)
print(f"\narticles: {len(articles)}")
for i, art in enumerate(articles[:5]):
    print(f"\n--- article {i} ---")
    # extract href, title, year
    href_m = re.search(r'href="(https://animesalt\.link/(series|movies)/[^"]+)"', art)
    title_m = re.search(r'class="entry-title"[^>]*>([^<]+)<', art)
    year_m = re.search(r'class="year"[^>]*>(\d{4})<', art)
    print(f"  href: {href_m.group(1) if href_m else 'NONE'}")
    print(f"  type: {href_m.group(2) if href_m else 'NONE'}")
    print(f"  title: {title_m.group(1).strip() if title_m else 'NONE'}")
    print(f"  year: {year_m.group(1) if year_m else 'NONE'}")
