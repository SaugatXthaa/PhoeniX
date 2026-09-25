// src/extractor/UnlimPlay.js
// Task 92: unlimplay.com — the Spanish multi-server aggregator that now backs
// CineHDPlus delivery (the site's player embeds /f/embed/tv/{imdb}/{se}/{ep},
// /f/embed/movie/{imdb}).
//
// RE'd live 2026-09-25 (page JS, fully server-side reproducible — no browser):
//   1. Embed page HTML carries a PHP-resolved server map:  const EMBEDS = {latino:{name:url,...}, español:{...}, subtitulado:{...}}  (may be []).
//   2. The browser then runs the async "SoloLatino" loader:
//        GET {embedPath}?_sl=1&ID={imdb}&season={se}&episode={ep}
//      → JSON {embeds: {latino:{...}, español:{...}, subtitulado:{...}}}.
//   3. Server URLs that are NOT already .m3u8 are resolved through the site's
//      HLS-extraction worker:
//        POST https://unlimplay.com/f.php?_hlsextract=1   body {"url": "<server url>"}
//      → {streams:["https://.../master.m3u8", ...]} (verified live 2026-09-25:
//        the worker follows the vidhide/powvideo/rapidvideo/vidmoly/vidspeed
//        family redirects and returns resolved HLS; ~1.7s per call).
//   4. vimeos.* playback needs NO Referer (the page's own service worker
//      re-fetches vimeos.{net,zip,com} with no-referrer); worker-resolved
//      streams carry the family referer in the response and are played
//      through /proxy so Stremio never has to send it.
//
// Upstream state note (documented honestly): the aggregator's server DB
// answered EMPTY for every probed title on 2026-09-25 (EMBEDS=[] and
// _sl=1 → {embeds:{}} for Breaking Bad/Naruto/Dune2/etc.). The extraction
// worker itself is alive. This extractor is therefore built to resolve zero
// cleanly and self-heal the moment the aggregator repopulates — the embed
// candidate CineHDPlus ships is claimed here BEFORE the ExternalUrl fallback,
// which would otherwise list the embed page as an unplayable external card.

import * as cheerio from 'cheerio';
import { CountryCode, Format } from '../types.js';
import { Extractor } from './Extractor.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EXTRACT_ENDPOINT = 'https://unlimplay.com/f.php?_hlsextract=1';
const LANG_ORDER = [
  ['latino', [CountryCode.mx]],
  ['español', [CountryCode.es]],
  ['subtitulado', [CountryCode.es, CountryCode.en]],
];
const MAX_SERVERS = 14;     // per resolve — bound the _hlsextract fan-out
const MAX_CARDS = 10;       // per resolve — bound emitted cards
const PAGE_TIMEOUT = 12000;
const EXTRACT_TIMEOUT = 12000;
const VERIFY_TIMEOUT = 5000;

export class UnlimPlay extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'unlimplay';
    this.label = 'UnlimPlay';
    this.cacheVersion = 1;
    this.ttl = 5 * 60 * 1000; // aggregator lists change; short cache
  }

  supports(_ctx, url) {
    return /(^|\.)unlimplay\.com$/i.test(url.hostname);
  }

  async extractInternal(ctx, url, meta) {
    try {
      // Direct media passthrough (already-resolved aggregator URLs)
      if (/\.(m3u8|mp4|mkv)(\?|$)/i.test(url.pathname)) {
        const hls = /\.m3u8$/i.test(url.pathname);
        return [{
          url,
          format: hls ? Format.hls : Format.unknown,
          meta: { ...meta, extractorId: 'unlimplay_direct' },
          label: 'UnlimPlay (direct)',
        }];
      }

      // Only embed pages carry the server map
      if (!/\/f\/embed\//.test(url.pathname)) return [];

      // ── 1. Page HTML: PHP-resolved EMBEDS map + _SL_* constants ──
      let html = '';
      try {
        html = await this.fetcher.text(ctx, url, { headers: { Referer: meta.referer ?? 'https://cinehdplus.surf/' }, timeout: PAGE_TIMEOUT });
      } catch { return []; }

      const embeds = {};
      const m = html.match(/const\s+EMBEDS\s*=\s*([\s\S]*?);\s*(?:const|let|var|\/\/|window\.|$)/);
      if (m) {
        try { Object.assign(embeds, JSON.parse(m[1])); } catch { /* PHP map absent */ }
      }

      // ── 2. Async SoloLatino loader (server-side equivalent of the page's
      //      slLazyLoad fetch): same path + ?_sl=1&ID=...&season=&episode= ──
      const imdb = url.pathname.match(/\/f\/embed\/(?:tv|movie)\/(tt\d{7,8})/)?.[1];
      const season = url.pathname.match(/\/embed\/tv\/tt\d+\/(\d+)/)?.[1];
      const episode = url.pathname.match(/\/embed\/tv\/tt\d+\/\d+\/(\d+)/)?.[1];
      try {
        const slUrl = new URL(`${url.pathname}?_sl=1&ID=${imdb ?? ''}`, url.origin);
        if (season) slUrl.searchParams.set('season', season);
        if (episode) slUrl.searchParams.set('episode', episode);
        const res = await fetch(slUrl.href, {
          headers: { 'User-Agent': UA, Accept: 'application/json', Referer: url.href },
          signal: AbortSignal.timeout(PAGE_TIMEOUT),
        });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data && typeof data.embeds === 'object' && !Array.isArray(data.embeds)) {
            for (const [lang, srvs] of Object.entries(data.embeds)) {
              if (!embeds[lang]) embeds[lang] = {};
              for (const [n, u] of Object.entries(srvs || {})) {
                if (!embeds[lang][n]) embeds[lang][n] = u;
              }
            }
          }
        }
      } catch { /* _sl endpoint optional */ }

      // ── 3. Resolve servers: direct .m3u8 → card; everything else through
      //      the f.php?_hlsextract=1 worker ──
      const cards = [];
      const seen = new Set();
      let processed = 0;
      for (const [lang, codes] of LANG_ORDER) {
        const srvs = embeds[lang] || {};
        for (const [name, rawUrl] of Object.entries(srvs)) {
          if (processed >= MAX_SERVERS || cards.length >= MAX_CARDS) break;
          if (!rawUrl || typeof rawUrl !== 'string' || seen.has(rawUrl)) continue;
          seen.add(rawUrl);
          processed++;
          const langTag = name ? `${lang} · ${name}` : lang;

          if (/\.m3u8(\?|$)/i.test(rawUrl)) {
            // Aggregator-resolved HLS (vimeos family — no-referrer playback,
            // same as the site's own service worker)
            if (await this._isHls(rawUrl)) {
              cards.push({
                url: new URL(rawUrl),
                format: Format.hls,
                meta: { ...meta, countryCodes: codes, extractorId: 'unlimplay', title: `${meta.title || ''} (${langTag})`.trim() },
                label: 'UnlimPlay',
              });
            }
            continue;
          }

          // Embed-family server → site's own HLS extraction worker
          const resolved = await this._extractViaWorker(rawUrl);
          for (const s of resolved.slice(0, MAX_CARDS - cards.length)) {
            cards.push({
              url: this._proxyUrl(ctx, s.url, s.referer),
              format: Format.hls,
              meta: {
                ...meta,
                countryCodes: codes,
                extractorId: 'unlimplay',
                title: `${meta.title || ''} (${langTag})`.trim(),
                ...(s.referer && { referer: s.referer }),
              },
              label: 'UnlimPlay',
            });
          }
        }
        if (processed >= MAX_SERVERS || cards.length >= MAX_CARDS) break;
      }

      this.logger.log?.(`[unlimplay] ${url.pathname.slice(0, 40)} → ${processed} servers, ${cards.length} card(s)`);
      return cards;
    } catch {
      return []; // honest zero — never external, never throw
    }
  }

  // POST {url} → {streams:[m3u8...], referer?} — the site's own worker call
  // (doExtract in the page JS), single attempt with a hard timeout.
  async _extractViaWorker(serverUrl) {
    try {
      const res = await fetch(EXTRACT_ENDPOINT, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Referer: 'https://unlimplay.com/' },
        body: JSON.stringify({ url: serverUrl }),
        signal: AbortSignal.timeout(EXTRACT_TIMEOUT),
      });
      if (!res.ok) return [];
      const data = await res.json().catch(() => null);
      const streams = Array.isArray(data?.streams) ? data.streams : [];
      const referer = typeof data?.referer === 'string' && data.referer.startsWith('http') ? data.referer : null;
      return streams
        .filter(s => typeof s === 'string' && /^https?:\/\//.test(s))
        .map(s => ({ url: s, referer }));
    } catch {
      return [];
    }
  }

  // Light playability gate: the aggregator's own UI only "confirms" servers
  // whose extraction returned streams; we additionally require the playlist
  // to actually answer HLS before emitting (everything-plays rule).
  async _isHls(url) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT),
      });
      const ct = res.headers.get('content-type') || '';
      if (res.status >= 400) return false;
      if (/mpegurl|x-mpegURL/i.test(ct)) { try { await res.body?.cancel(); } catch {} return true; }
      const text = await res.text();
      return text.includes('#EXTM3U');
    } catch {
      return false;
    }
  }

  // Worker-resolved streams ride /proxy with the family Referer the worker
  // itself used (vidhide-family CDNs check it; Stremio won't send one).
  _proxyUrl(ctx, urlStr, referer) {
    try {
      const p = new URL('/proxy', ctx.hostUrl);
      p.searchParams.set('url', urlStr);
      if (referer) p.searchParams.set('referer', referer);
      return p;
    } catch {
      return new URL(urlStr);
    }
  }
}
