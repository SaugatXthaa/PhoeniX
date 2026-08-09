// src/extractor/AnimeDirect.js
// Passthrough extractor for direct playable anime HLS/MP4 URLs.
//
// Anime sources (AniDB, AniNeko, HiAnime, AnimeFlix, NineAnime) return
// direct playable URLs from various CDN hosts. Without an extractor claiming
// these URLs, they're silently dropped by ExtractorRegistry.
//
// Hosts handled:
//   - hls.anidb.app (AniDB direct HLS)
//   - *.dramiyos-cdn.com, *.harborlane*, *.pinecliff* (AniNeko HLS)
//   - *.creativewritingtips.site, *.savannahridgedesignlab* (AniNeko/Netlio)
//   - gn1r5n.org, playmogo.com (HiAnime embed pages — need extraction)
//   - gogoanime.com.by (AnimeFlix/NineAnime embed pages — need extraction)
//
// For direct HLS URLs (anidb, anineko CDNs), we pass through with the
// appropriate Referer. For embed pages (hianime, gogoanime), we extract
// the actual stream URL from the page HTML.

import * as cheerio from 'cheerio';
import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

// Direct HLS CDN hosts (pass through as-is, just add Referer)
const DIRECT_HLS_HOSTS = [
  'hls.anidb.app',
  'play.zephyrix.top',
  // AniKage — prox.anicore.tv serves direct HLS (requires Referer: anikage.cc)
  'prox.anicore.tv',
  // AniBD — playeng.animeapps.top serves direct HLS (requires Referer: anibd.app)
  'playeng.animeapps.top',
];

// CDN host suffixes that serve direct HLS (AniNeko + Netlio + VidSpark CDNs)
const DIRECT_HLS_SUFFIXES = [
  '.dramiyos-cdn.com',
  '.harborlanecreativeworks.space',
  '.pinecliffdesigncollective.store',
  '.creativewritingtips.site',
  '.savannahridgedesignlab.cyou',
  '.netrocdn.site',
];

// Embed page hosts (need HTML extraction to find the actual stream URL)
const EMBED_HOSTS = [
  'gn1r5n.org',
  'playmogo.com',
  'gogoanime.com.by',
];

function isDirectHls(url) {
  if (DIRECT_HLS_HOSTS.includes(url.hostname)) return true;
  return DIRECT_HLS_SUFFIXES.some(suffix => url.hostname.endsWith(suffix));
}

function isEmbedPage(url) {
  return EMBED_HOSTS.includes(url.hostname);
}

// Check if URL has Netlio path patterns (cf-master, /v4/, /hls3/)
function isNetlioCdnUrl(url) {
  const path = url.pathname.toLowerCase();
  return path.includes('cf-master') ||
         path.includes('/v4/') ||
         path.includes('/hls3/');
}

export class AnimeDirect extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'animedirect';
    this.label = 'Anime';
    this.ttl = 3600000; // 1h
  }

  supports(_ctx, url) {
    return isDirectHls(url) || isEmbedPage(url) || isNetlioCdnUrl(url);
  }

  async extractInternal(ctx, url, meta) {
    // Direct HLS — pass through with appropriate Referer
    if (isDirectHls(url)) {
      // Use Referer from source meta if provided (e.g., VidSpark sets
      // requestHeaders: { Referer: 'https://vidspark.to/' })
      // Otherwise infer from hostname
      const referer = meta?.requestHeaders?.Referer ||
        (url.hostname === 'hls.anidb.app' ? 'https://anidb.app/'
        : url.hostname === 'play.zephyrix.top' ? 'https://play.zephyrix.top/'
        : url.hostname === 'prox.anicore.tv' ? 'https://anikage.cc/'
        : url.hostname === 'playeng.animeapps.top' ? 'https://anibd.app/'
        : url.hostname.endsWith('.netrocdn.site') ? 'https://vidspark.to/'
        : 'https://anineko.to/');

      // Route through /proxy for CDN hosts that need Referer
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      proxyUrl.searchParams.set('referer', referer);

      return [{
        url: proxyUrl,
        format: Format.hls,
        label: this.label,
        meta: { ...meta },
      }];
    }

    // Netlio CDN URLs — route through /proxy with Netlio Referer
    if (isNetlioCdnUrl(url)) {
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      proxyUrl.searchParams.set('referer', 'https://netlio.vercel.app/');

      return [{
        url: proxyUrl,
        format: Format.hls,
        label: this.label,
        meta: { ...meta },
      }];
    }

    // Embed pages — extract the actual stream URL from HTML
    if (isEmbedPage(url)) {
      try {
        const html = await this.fetcher.text(ctx, url, {
          headers: { 'Referer': 'https://hianime.win/' },
          timeout: 10000,
        });

        // Check for megaplay.buzz iframe (used by gogoanime.com.by embeds)
        // gogoanime embeds contain: <iframe src="https://megaplay.buzz/stream/s-2/{id}/{sub|dub}">
        const megaplayIframe = html.match(/<iframe[^>]+src=["'](https:\/\/megaplay\.buzz\/stream\/[^"']+)["']/i);
        if (megaplayIframe?.[1]) {
          // Resolve via the Megaplay getSourcesNew API (same flow as Megaplay extractor)
          const megaUrl = new URL(megaplayIframe[1]);
          const megaResult = await this.resolveMegaplay(ctx, megaUrl, meta);
          if (megaResult) return [megaResult];
        }

        // Look for HLS/MP4 URLs in the page
        const hlsMatch = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
        const mp4Match = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
        const sourceMatch = html.match(/source:\s*["']([^"']+)["']/i);
        const fileMatch = html.match(/file:\s*["']([^"']+)["']/i);

        const streamUrl = hlsMatch?.[0] || mp4Match?.[0] || sourceMatch?.[1] || fileMatch?.[1];

        if (streamUrl) {
          let parsed;
          try { parsed = new URL(streamUrl); } catch { return []; }

          // If the stream URL is itself an embed, try extracting from it too
          if (parsed.hostname.includes('gogoanime') || parsed.hostname.includes('streaming.php')) {
            // Try fetching the streaming page
            try {
              const streamHtml = await this.fetcher.text(ctx, parsed, {
                headers: { 'Referer': url.origin + '/' },
                timeout: 10000,
              });
              // Check for megaplay iframe in the streaming page too
              const megaIframe2 = streamHtml.match(/<iframe[^>]+src=["'](https:\/\/megaplay\.buzz\/stream\/[^"']+)["']/i);
              if (megaIframe2?.[1]) {
                const megaUrl2 = new URL(megaIframe2[1]);
                const megaResult2 = await this.resolveMegaplay(ctx, megaUrl2, meta);
                if (megaResult2) return [megaResult2];
              }
              const hls2 = streamHtml.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
              const mp42 = streamHtml.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
              const source2 = streamHtml.match(/source:\s*["']([^"']+)["']/i);
              const file2 = streamHtml.match(/file:\s*["']([^"']+)["']/i);
              const innerUrl = hls2?.[0] || mp42?.[0] || source2?.[1] || file2?.[1];
              if (innerUrl) {
                try { parsed = new URL(innerUrl); } catch { return []; }
              } else {
                return [];
              }
            } catch { return []; }
          }

          const format = parsed.href.includes('.m3u8') ? Format.hls : Format.mp4;

          // Route through proxy if needed
          let finalUrl = parsed;
          if (parsed.hostname.endsWith('.workers.dev') ||
              parsed.hostname.includes('cloudflare')) {
            const proxyUrl = new URL('/proxy', ctx.hostUrl);
            proxyUrl.searchParams.set('url', parsed.href);
            proxyUrl.searchParams.set('referer', url.origin + '/');
            finalUrl = proxyUrl;
          }

          return [{
            url: finalUrl,
            format,
            label: this.label,
            meta: { ...meta },
          }];
        }

        // Look for packed eval JS (common in gogoanime players)
        const evalMatch = html.match(/eval\(function\(p,a,c,k,e,d\).*?\)\)/s);
        if (evalMatch) {
          // Can't evaluate packed JS server-side — return the embed URL
          // through the proxy so Stremio can at least try
          return [];
        }
      } catch { /* extraction failed */ }
    }

    return [];
  }

  // Resolve a megaplay.buzz embed URL to a direct m3u8 via getSourcesNew API.
  // Same flow as the Megaplay extractor: fetch page → extract data-id →
  // call getSourcesNew → route through /proxy with megaplay.buzz Referer.
  async resolveMegaplay(ctx, megaUrl, meta) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    try {
      const { gotScraping } = await import('got-scraping');

      // Fetch the megaplay embed page to extract data-id
      const pageRes = await gotScraping.get(megaUrl.href, {
        headers: { 'User-Agent': UA, 'Referer': 'https://hianime.win/' },
        timeout: { request: 15000 }, throwHttpErrors: false,
      });
      if (pageRes.statusCode !== 200) return null;

      const dataIdMatch = pageRes.body.match(/data-id="(\d+)"/);
      if (!dataIdMatch) return null;
      const dataId = dataIdMatch[1];

      // Call getSourcesNew API
      const apiUrl = `https://megaplay.buzz/stream/getSourcesNew?id=${dataId}`;
      const apiRes = await gotScraping.get(apiUrl, {
        headers: {
          'User-Agent': UA,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': megaUrl.href,
          'Accept': 'application/json,text/plain,*/*',
        },
        timeout: { request: 15000 }, throwHttpErrors: false,
      });
      if (apiRes.statusCode !== 200) return null;

      const data = JSON.parse(apiRes.body);
      if (!data?.sources?.file) return null;

      const m3u8Url = new URL(data.sources.file);

      // Try to extract resolution from the m3u8 playlist
      let height;
      try {
        const playlistRes = await gotScraping.get(m3u8Url.href, {
          headers: { 'User-Agent': UA, 'Referer': 'https://megaplay.buzz/' },
          timeout: { request: 10000 }, throwHttpErrors: false,
        });
        if (playlistRes.statusCode === 200) {
          const resMatch = playlistRes.body.match(/RESOLUTION=\d+x(\d+)/i);
          if (resMatch) height = parseInt(resMatch[1]);
        }
      } catch { /* resolution detection failed — not critical */ }

      // Route through /proxy with megaplay.buzz Referer
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', m3u8Url.href);
      proxyUrl.searchParams.set('referer', 'https://megaplay.buzz/');

      return {
        url: proxyUrl,
        format: Format.hls,
        label: this.label,
        meta: { ...(meta || {}), ...(height && { height }) },
      };
    } catch { return null; }
  }
}
