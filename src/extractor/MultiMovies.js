// src/extractor/MultiMovies.js
// MultiMovies embed URL extractor — resolves iqsmartgames embed URLs to direct streams.
//
// The iqsmartgames embed flow:
//   1. /mymovieapi?imdbid={imdb}&key={key} → file list with fileslugs
//   2. POST /embedhelper2.php (on pro.iqsmartgames.com) with sid={fileslug}
//      → returns sources object with 6 providers (hanerix, smoothpre, etc.)
//   3. Each provider has siteUrl + file ID → embed page
//   4. Embed page has obfuscated JS that loads the video
//
// Since we can't deobfuscate the provider JS server-side, we return the
// provider embed URLs through /proxy so Stremio can attempt playback.
// If the provider page contains direct m3u8/mp4 URLs, the /proxy will
// find and serve them.
//
// For the iqsmartgames embed URL itself, we also try fetching the page
// and extracting any direct video URLs that might be present.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Hosts claimed by this extractor
const MULTIMOVIES_HOSTS = [
  'rozgarlelo.modiplay.xyz',
  'streams.iqsmartgames.com',
  'screenscape.me',
  'nxsha.space',
  'morencius.com',
  'filesforever.link',
];

function isMultiMoviesHost(hostname) {
  return MULTIMOVIES_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h));
}

let _gotScraping = null;
async function getGot() {
  if (_gotScraping) return _gotScraping;
  try {
    const mod = await import('got-scraping');
    _gotScraping = mod.gotScraping;
  } catch { /* fallback below */ }
  return _gotScraping;
}

export class MultiMovies extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'multimovies';
    this.label = 'MultiMovies';
    this.ttl = 1800000; // 30min
  }

  supports(_ctx, url, meta) {
    // Only claim URLs from MultiMovies source
    if (meta?.sourceId !== 'multimovies') return false;
    return isMultiMoviesHost(url.hostname);
  }

  async extractInternal(ctx, url, meta) {
    const got = await getGot();
    if (!got) {
      // Fallback: return as external URL
      return [{
        url,
        format: Format.unknown,
        isExternal: true,
        label: this.label,
        meta: { ...meta },
      }];
    }

    // Try to fetch the embed page and extract direct video URLs
    try {
      const res = await got(url.href, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/json,*/*',
          'Referer': 'https://multimovies.beer/',
        },
        timeout: { request: 12000 },
        throwHttpErrors: false,
        followRedirect: true,
        http2: true,
      });

      if (res.statusCode === 200 && res.body) {
        // Look for direct m3u8 URLs
        const m3u8Match = res.body.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
        if (m3u8Match) {
          try {
            const m3u8Url = new URL(m3u8Match[0]);
            // Route through /proxy with Referer
            const proxyUrl = new URL('/proxy', ctx.hostUrl);
            proxyUrl.searchParams.set('url', m3u8Url.href);
            proxyUrl.searchParams.set('referer', url.origin + '/');
            return [{
              url: proxyUrl,
              format: Format.hls,
              label: this.label,
              meta: { ...meta },
            }];
          } catch {}
        }

        // Look for direct mp4/mkv URLs
        const mp4Match = res.body.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
        const mkvMatch = res.body.match(/https?:\/\/[^"'\s<>]+\.mkv[^"'\s<>]*/i);
        const videoMatch = mp4Match || mkvMatch;
        if (videoMatch) {
          try {
            const videoUrl = new URL(videoMatch[0]);
            // Route through /proxy with Referer
            const proxyUrl = new URL('/proxy', ctx.hostUrl);
            proxyUrl.searchParams.set('url', videoUrl.href);
            proxyUrl.searchParams.set('referer', url.origin + '/');
            return [{
              url: proxyUrl,
              format: Format.mp4,
              label: this.label,
              meta: { ...meta },
            }];
          } catch {}
        }

        // For iqsmartgames: try the /mymovieapi to get file slugs,
        // then resolve through /embedhelper2.php to provider embeds
        if (url.hostname.includes('iqsmartgames')) {
          const streams = await this.resolveIqSmartGames(ctx, url, meta, got);
          if (streams.length > 0) return streams;
        }
      }
    } catch { /* fall through to external */ }

    // Fallback: return as external URL (Stremio opens in browser)
    return [{
      url,
      format: Format.unknown,
      isExternal: true,
      label: this.label,
      meta: { ...meta },
    }];
  }

  // Resolve iqsmartgames embed URL via /mymovieapi → /embedhelper2.php → provider embeds
  async resolveIqSmartGames(ctx, url, meta, got) {
    try {
      // Extract IMDB ID and key from the embed URL
      // URL format: https://streams.iqsmartgames.com/embed/movie/tt1375666?key=XXX
      // or: https://streams.iqsmartgames.com/embed/tv/31910/1/1?key=XXX
      const pathMatch = url.pathname.match(/\/embed\/(?:movie|tv)\/([a-z0-9:]+)(?:\/(\d+)\/(\d+))?/i);
      if (!pathMatch) return [];
      const mediaId = pathMatch[1];
      const key = url.searchParams.get('key');
      if (!key) return [];

      // Step 1: Call /mymovieapi to get file list
      const isImdb = mediaId.startsWith('tt');
      const apiParam = isImdb ? `imdbid=${mediaId}` : `tmdbid=${mediaId}`;
      const apiUrl = `https://streams.iqsmartgames.com/mymovieapi?${apiParam}&key=${key}`;
      const apiRes = await got(apiUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': url.href },
        timeout: { request: 10000 }, throwHttpErrors: false,
      });
      if (apiRes.statusCode !== 200) return [];
      const apiData = JSON.parse(apiRes.body);
      if (!apiData?.success || !Array.isArray(apiData.data) || apiData.data.length === 0) return [];

      // Step 2: For each file, resolve via /embedhelper2.php on pro.iqsmartgames.com
      const results = [];
      for (const file of apiData.data.slice(0, 5)) {
        const slug = file.fileslug;
        if (!slug) continue;

        try {
          // POST to /embedhelper2.php
          const body = new URLSearchParams({
            sid: slug,
            UserFavSite: '',
            currentDomain: JSON.stringify(['streams.iqsmartgames.com']),
          });
          const helperRes = await got.post('https://pro.iqsmartgames.com/embedhelper2.php', {
            headers: {
              'User-Agent': UA,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Referer': 'https://pro.iqsmartgames.com/',
              'Origin': 'https://pro.iqsmartgames.com',
            },
            body: body.toString(),
            timeout: { request: 10000 },
            throwHttpErrors: false,
          });
          if (helperRes.statusCode !== 200) continue;
          const helperData = JSON.parse(helperRes.body);
          if (!helperData?.sources) continue;

          // Decode mresult to get provider file IDs
          const mresult = helperData.mresult ? JSON.parse(Buffer.from(helperData.mresult, 'base64').toString('utf-8')) : {};

          // Try each provider — return the first that gives a playable URL
          for (const [providerKey, providerData] of Object.entries(helperData.sources)) {
            const providerFileId = mresult[providerKey];
            if (!providerFileId || !providerData.siteUrl) continue;

            const providerEmbedUrl = providerData.siteUrl + providerFileId;
            try {
              const providerHost = new URL(providerEmbedUrl).hostname;
              // Fetch the provider embed page
              const pRes = await got(providerEmbedUrl, {
                headers: { 'User-Agent': UA, 'Referer': 'https://pro.iqsmartgames.com/' },
                timeout: { request: 8000 }, throwHttpErrors: false, followRedirect: true,
              });

              if (pRes.statusCode === 200 && pRes.body) {
                // Look for direct video URLs
                const m3u8 = pRes.body.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
                const mp4 = pRes.body.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
                const videoUrl = m3u8?.[0] || mp4?.[0];

                if (videoUrl) {
                  const parsed = new URL(videoUrl);
                  const proxyUrl = new URL('/proxy', ctx.hostUrl);
                  proxyUrl.searchParams.set('url', parsed.href);
                  proxyUrl.searchParams.set('referer', providerEmbedUrl);

                  results.push({
                    url: proxyUrl,
                    format: m3u8 ? Format.hls : Format.mp4,
                    label: this.label,
                    meta: {
                      ...meta,
                      serverName: providerData.friendlyName || providerHost,
                    },
                  });
                  break; // Found a playable URL for this file — stop trying providers
                }
              }
            } catch {}
          }
        } catch {}
      }

      return results;
    } catch {
      return [];
    }
  }
}
