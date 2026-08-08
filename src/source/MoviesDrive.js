// src/source/MoviesDrive.js
// new1.moviesdrive.christmas — movies/series with HubCloud links
// Search: /?s={query} → post page → mdrive.lol/archive/{id} → hubcloud.cx/drive/{id}
// The HubCloud links are resolved by the HubExtractor to direct CDN URLs.

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId, findCountryCodes, findHeight } from '../utils/index.js';
import { HUB_HOST_PATTERN } from '../utils/hub.js';
import { Source } from './Source.js';

export class MoviesDrive extends Source {
  constructor(fetcher) {
    super();
    this.id = 'moviesdrive';
    this.label = 'MoviesDrive';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://new2.moviesdrive.christmas';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    // Search for the title
    const postUrls = await this.searchPosts(ctx, name, year);
    if (postUrls.length === 0) return [];

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);
    const results = [];

    // Fetch each post page and find mdrive.lol archive links
    for (const postUrl of postUrls.slice(0, 5)) {
      try {
        const postHtml = await this.fetcher.text(ctx, new URL(postUrl));
        const $post = cheerio.load(postHtml);

        // Find mdrive.lol archive links
        const archiveLinks = [];
        $post('a[href*="mdrive.lol/archive"]').each((_i, el) => {
          const href = $post(el).attr('href');
          const text = $post(el).text().trim();
          if (href && !archiveLinks.find(a => a.url === href)) {
            archiveLinks.push({ url: href, label: text });
          }
        });

        // Also find direct hubcloud links on the post page itself.
        // The site structure changed — post pages now link directly to
        // hubcloud.foo/drive/search-recover.php?from_ac=... instead of
        // going through mdrive.lol/archive. These are JS-redirect pages
        // that call an API to find the actual hubcloud.cx/drive/{id} URL.
        // We call the API directly to resolve the real drive URL.
        if (archiveLinks.length === 0) {
          const directEntries = [];
          $post('a[href*="hubcloud"]').each((_i, el) => {
            const href = $post(el).attr('href');
            const text = $post(el).text().trim();
            if (!href || !HUB_HOST_PATTERN.test(href)) return;

            // Parse quality and size from the link text
            const qualityMatch = text.match(/(\d{3,})p|4k|2160p/i);
            const sizeMatch = text.match(/([\d.]+)\s*(GB|MB)/i);

            let quality = null;
            if (qualityMatch) {
              if (/4k|2160/i.test(qualityMatch[0])) quality = '2160p';
              else quality = qualityMatch[1] + 'p';
            }

            directEntries.push({
              episode: null,
              quality,
              size: sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : null,
              url: href,
              label: text,
            });
          });

          // Process direct entries — resolve search-recover.php URLs via API
          for (const entry of directEntries) {
            if (tmdbId.season) {
              const reqEp = tmdbId.episode || 1;
              if (!entry.episode || entry.episode !== reqEp) continue;
            }

            let entryTitle = entry.label || title;
            const countryCodes = [CountryCode.multi, ...findCountryCodes(entryTitle)];
            const height = entry.quality ? parseInt(entry.quality) : findHeight(entryTitle);

            let fileSize = undefined;
            if (entry.size) {
              const sm = entry.size.match(/([\d.]+)\s*(GB|MB)/i);
              if (sm) {
                const val = parseFloat(sm[1]);
                const unit = sm[2].toUpperCase();
                fileSize = unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
              }
            }

            // If this is a search-recover.php URL, resolve it via the API
            // to get the actual hubcloud.cx/drive/{id} URL that HubExtractor
            // can handle. The API returns all episodes for the show, so we
            // filter by requested season+episode using the file_name field.
            let resolvedUrl = entry.url;
            if (entry.url.includes('search-recover.php')) {
              try {
                const parsed = new URL(entry.url);
                const fromAc = parsed.searchParams.get('from_ac') || '';
                const q = parsed.searchParams.get('q') || '';
                // Decode q if it's base64
                let query = q;
                try { query = Buffer.from(q, 'base64').toString('utf-8'); } catch {}

                const apiUrl = new URL('/drive/search-recover.php', parsed.origin);
                apiUrl.searchParams.set('api', 'search');
                apiUrl.searchParams.set('q', query);
                apiUrl.searchParams.set('page', '1');
                apiUrl.searchParams.set('from_ac', fromAc);

                const apiRes = await this.fetcher.json(ctx, apiUrl, {
                  headers: { 'Accept': 'application/json' },
                  timeout: 8000,
                });

                if (apiRes?.hits && Array.isArray(apiRes.hits) && apiRes.hits.length > 0) {
                  // For series: find the hit matching the requested SxxExx
                  // The file_name contains the season/episode info (e.g.
                  // "House.of.the.Dragon.S02E01.720p...")
                  let bestHit = apiRes.hits[0];
                  if (tmdbId.season) {
                    const reqS = tmdbId.season;
                    const reqE = tmdbId.episode || 1;
                    // Build regex: S{season}E{episode} (with optional leading zeros)
                    const sxxexxRegex = new RegExp(`S0*${reqS}E0*${reqE}[^0-9]`, 'i');
                    const matchingHit = apiRes.hits.find(h =>
                      sxxexxRegex.test(String(h.file_name || '')));
                    if (matchingHit) {
                      bestHit = matchingHit;
                    } else {
                      // No matching episode found — skip this entry entirely
                      // to prevent wrong episodes from showing up
                      continue;
                    }
                  }
                  resolvedUrl = bestHit.url;
                  // Update file size from API if available
                  if (bestHit.size && !fileSize) {
                    const sm = String(bestHit.size).match(/([\d.]+)\s*(GB|MB)/i);
                    if (sm) {
                      const val = parseFloat(sm[1]);
                      const unit = sm[2].toUpperCase();
                      fileSize = unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
                    }
                  }
                  // Update title with the actual file name from API (more accurate)
                  if (bestHit.file_name) {
                    entryTitle = bestHit.file_name;
                  }
                }
              } catch { /* API failed — use original URL (HubExtractor will try) */ }
            }

            results.push({
              url: new URL(resolvedUrl),
              meta: {
                countryCodes,
                ...(height && { height }),
                title: entryTitle,
                ...(fileSize && { bytes: fileSize }),
              },
            });
          }
        }

        // For each archive link, fetch it and extract hubcloud links
        for (const archive of archiveLinks) {
          try {
            const archHtml = await this.fetcher.text(ctx, new URL(archive.url));
            const $arch = cheerio.load(archHtml);

            // Extract all h5 elements that contain EP{N} labels followed by hubcloud links
            const entries = [];
            const h5s = $arch('h5').toArray();
            // Track the current season as we iterate through h5s.
            // Archive pages have season headers like "Season 3 [Hindi – English] 480p"
            // followed by episode entries like "EP01 – 480p [252.7 MB]".
            // Without tracking the season, EP01 from Season 3 would match a
            // request for S1E1 — showing the wrong episode.
            let currentSeason = null;

            for (let i = 0; i < h5s.length; i++) {
              const h5Text = $arch(h5s[i]).text().trim();

              // Check if this h5 is a season header (e.g. "Season 3 [Hindi – English] 480p")
              const seasonHeaderMatch = h5Text.match(/^Season\s+(\d+)/i);
              if (seasonHeaderMatch) {
                currentSeason = parseInt(seasonHeaderMatch[1]);
                continue;
              }

              // Check if this h5 has an EP label (e.g. "EP01 – 1080p [1.3GB]")
              const epMatch = h5Text.match(/EP\s*0*(\d+)/i);
              const qualityMatch = h5Text.match(/(\d{3,})p/i);
              const sizeMatch = h5Text.match(/([\d.]+)\s*(GB|MB)/i);

              // Check if next h5 has a hubcloud link
              const nextH5 = h5s[i + 1];
              if (nextH5) {
                const link = $arch(nextH5).find('a[href*="hubcloud"]').attr('href');
                if (link) {
                  entries.push({
                    episode: epMatch ? parseInt(epMatch[1]) : null,
                    season: currentSeason,
                    quality: qualityMatch ? qualityMatch[1] + 'p' : null,
                    size: sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : null,
                    url: link,
                  });
                }
              }
            }

            // Also check for standalone hubcloud links (movies without episodes)
            if (entries.length === 0) {
              $arch('a[href*="hubcloud"]').each((_i, el) => {
                const href = $arch(el).attr('href');
                if (href && HUB_HOST_PATTERN.test(href)) {
                  // Walk up to find quality/size context
                  const parent = $arch(el).closest('h5, h4, p, div');
                  const context = parent.text().trim();
                  const qualityMatch = context.match(/(\d{3,})p/i);
                  const sizeMatch = context.match(/([\d.]+)\s*(GB|MB)/i);
                  entries.push({
                    episode: null,
                    season: null,
                    quality: qualityMatch ? qualityMatch[1] + 'p' : null,
                    size: sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : null,
                    url: href,
                  });
                }
              });
            }

            // Filter by requested season+episode for series
            for (const entry of entries) {
              if (tmdbId.season) {
                const reqS = tmdbId.season;
                const reqEp = tmdbId.episode || 1;
                // Only include entries that explicitly match BOTH the requested
                // season AND episode. Skip null-season/episode entries (can't
                // verify match) — prevents wrong episodes from showing.
                if (entry.season !== reqS || !entry.episode || entry.episode !== reqEp) continue;
              }

              // Build meta
              const entryTitle = archive.label || title;
              const countryCodes = [CountryCode.multi, ...findCountryCodes(entryTitle)];
              const height = entry.quality ? parseInt(entry.quality) : findHeight(entryTitle);

              let fileSize = undefined;
              if (entry.size) {
                const sm = entry.size.match(/([\d.]+)\s*(GB|MB)/i);
                if (sm) {
                  const val = parseFloat(sm[1]);
                  const unit = sm[2].toUpperCase();
                  fileSize = unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
                }
              }

              results.push({
                url: new URL(entry.url),
                meta: {
                  countryCodes,
                  ...(height && { height }),
                  title: entryTitle,
                  ...(fileSize && { bytes: fileSize }),
                },
              });
            }
          } catch { /* skip failed archive page */ }
        }
      } catch { /* skip failed post page */ }
    }

    return results;
  }

  async searchPosts(ctx, name, year) {
    // Use WordPress REST API (regular search form doesn't work on this site)
    const queries = [
      name,
      name.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
    ].filter((q, i, arr) => q && arr.indexOf(q) === i);

    const postUrls = [];

    // Normalize a string for fuzzy matching:
    // - decode HTML entities (&#038; → &, &amp; → &)
    // - replace & and "and" with space (so "Minions & Monsters" and "Minions and Monsters" both match)
    // - strip special chars
    // - collapse whitespace
    const normalize = (s) => {
      return s
        .toLowerCase()
        .replace(/&#0*38;/g, '&')   // HTML entity for &
        .replace(/&amp;/g, '&')      // another HTML entity form
        .replace(/&/g, ' ')          // & → space
        .replace(/\band\b/g, ' ')    // "and" → space
        .replace(/[^a-z0-9\s]/g, '') // strip remaining special chars
        .replace(/\s+/g, ' ')        // collapse whitespace
        .trim();
    };

    const nameNormalized = normalize(name);

    for (const query of queries) {
      const apiUrl = new URL(`/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=10`, this.baseUrl);
      try {
        const posts = await this.fetcher.json(ctx, apiUrl, { timeout: 10000 });
        if (Array.isArray(posts)) {
          for (const post of posts) {
            const link = post.link;
            if (!link) continue;
            const title = post.title?.rendered || '';
            const titleNormalized = normalize(title);

            // Strict matching: the post title MUST contain the full movie/series name.
            // Both are normalized so "Minions & Monsters" matches "Minions and Monsters"
            // and "Minions &#038; Monsters".
            if (!titleNormalized.includes(nameNormalized)) continue;

            if (!postUrls.includes(link)) postUrls.push(link);
          }
        }
        if (postUrls.length > 0) break;
      } catch { /* continue to next query */ }
    }

    return postUrls;
  }
}
