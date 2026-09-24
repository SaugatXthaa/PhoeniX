// src/extractor/NuvioExtractor.js
// Extractor for Nuvio provider streams (Cineby, DesiFlix, Goated, etc.)
//
// Each Nuvio source returns ORIGINAL stream URLs (not /proxy URLs) with meta
// containing:
//   - meta.sourceId       — the Nuvio source ID (cineby, desiflix, goated, etc.)
//   - meta.nuvioProvider  — true (marks this as a Nuvio stream)
//   - meta.nuvioReferer   — Referer to send (if any)
//   - meta.nuvioForceHls   — true if URL is ambiguous (use forceHls=1)
//
// This extractor matches by meta.nuvioProvider === true, and:
//   - HLS + Referer → /proxy with referer (proxy rewrites m3u8 URLs)
//   - Ambiguous URL + Referer → /proxy with forceHls=1 (proxy does HEAD check)
//   - MP4/MKV + Referer → direct URL with requestHeaders (proxyHeaders)
//   - No Referer → direct URL (DirectStream/ExternalUrl handles)
//
// This follows the same pattern as HiAnime/AnimeKai extractors which match
// by meta.sourceId and route through /proxy with the correct Referer.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';
import { HUB_HOST_PATTERN } from '../utils/index.js';

// Embed/player PAGE hosts (HTML SPA players — not media files). Nuvio sources
// that emit third-party embed fallbacks (StreamXTV: vidsrc-embed.ru /
// vidking.net / player.vidzee.wtf / player.videasy.net; anime: megaplay.buzz
// /stream sub-dub pages, vidnest.fun) must NOT ship those pages raw — a raw
// HTML page URL is a guaranteed "[mpv] unrecognized file format" card.
// Returning [] here (same pattern as the HUB_HOST block below) lets the
// registry's fallback chain hand the URL to the dedicated extractors
// (Megaplay, VidSrc, Vidzee, VidKing, EmbedResolver), which resolve the pages
// server-side into real HLS. Only NON-media URLs are bypassed: direct
// HLS/video files on these hosts keep their normal NuvioExtractor routing.
const EMBED_PAGE_HOST_PATTERN = /(^|\.)(vidsrc-embed\.ru|vidking\.net|vidzee\.wtf|videasy\.net|megaplay\.buzz|vidnest\.fun)$/i;

// Download-page hosts that a dedicated extractor resolves server-side.
// Task 41: hblinks.co/<archive> pages (emitted by hdhub4u_v2's greenmotors
// decode) shipped RAW as direct cards — the player fetched an HTML archive
// page and threw "[mpv] unrecognized file format" / 403s. Returning [] lets
// the registry fall through to the HBLinks extractor (supports /hblinks/),
// which parses the page's hubcloud/hubcdn/hubdrive links into real files.
// Task 51: TLD-agnostic — the host rotated hblinks.co → hblinks.lol (same
// page shape, same funnel); hardcoding the TLD re-created the poison class.
const DOWNLOAD_PAGE_HOST_PATTERN = /(^|\.)hblinks\.[a-z]{2,}$/i;

// Nuvio source IDs handled by this extractor
const NUVIO_SOURCE_IDS = new Set([
  'cineby', 'hindmoviez',
  'movies4u', 'playimdb',
  // Batch 2: videasy, anikototv, animesalt,
  // animesdigital (animeworldindia REMOVED 2026-09 — dead upstream, user request)
  'videasy', 'anikototv',
  'animesalt', 'animesdigital',
  // AniChan — anime sub+dub HLS via AniList ID + anichan.net API
  'anichan',
  // ZinkMovies — movies/series via gemma416okl.com API, HLS on rasta428jem.com
  'zinkmovies',
  // 1Embed — movies/TV HLS via 1embed.cc API, requires Referer: 1embed.cc
  'oneembed',
  // Re-added sources (from uploaded Nuvio scrapers):
  // zxcstream — embed URLs from player.zxcstream.xyz (route through /proxy)
  // animezey — anime HLS from workers.dev (direct)
  // uhdmovies — movies from googleusercontent (Referer: driveseed.org)
  // moviesdrive — direct googleusercontent URLs (resolved via hub_extractor)
  // NOTE: hdhub4u is NOT here — its hubcdn/hubcloud URLs are handled by
  // HubExtractor/HubCloud downstream, not NuvioExtractor.
  // NOTE: 'cinejoy' (the old v1 source) was deleted — only 'cinejoyaio' remains.
  'zxcstream', 'animezey', 'uhdmovies', 'moviesdrive', 'framextv', 'cinejoyaio',
  // nikastream — anime sub+dub HLS via Anivexa API (kryntal.top needs Referer)
  'nikastream',
  // animesuge — anime sub/dub HLS via megaplay.buzz getSourcesNew. Since the
  // 2026-09 megaplay encryption change the decrypted m3u8 lives on
  // fetch.nexabloom.top which hard-403s datacenter IPs — NuvioExtractor's
  // NO_REFERER_HOSTS (nuvioHelpers) routes it as a direct player-IP fetch.
  // Without joining this set the m3u8 would match NO extractor and be dropped.
  'animesuge',
  // streamxtv — streamxtv.sbs direct HLS via api.framextv.tech (20 providers,
  // up to 4K). Per-CDN Referer (player.videasy.to / yesmovies.ag / …) MUST be
  // routed through /proxy or the CDNs return 403.
  'streamxtv',
  // atlantic — atlantic.st (Task 48 RE): peraspera.nbsycfzrpa4.workers.dev +
  // totallyacdn.org m3u8-proxy payloads are Origin/Referer-gated (200 text/html
  // decoys without Origin: atlantic.st) → nuvioReferer/nuvioOrigin/nuvioForceHls
  // route through /proxy with whole-tree auth. Without joining this set every
  // card matched NO extractor and was silently dropped (Task 25 failure class).
  'atlantic',
  // cinebyrocks — movies/TV/anime via VidRock API (multi-CDN direct m3u8/mp4)
  'cinebyrocks',
  // stellar — movies/TV/anime via PoW + AES-GCM (HLS gated behind
  //   Origin/Referer: stellar.gdn since 2026-09-11 upstream change — routed
  //   through /proxy with origin= + referer=; see src/source/Stellar.js)
  'stellar',
  // raflixnuvio — Raflix's server-resolved CinePro streams (sourceId is a
  // dedicated pseudo-ID so ONLY those streams route through here — /proxy
  // with whole-tree Referer rewriting; Raflix's raw embed results keep
  // flowing through the normal extractor registry as sourceId 'raflix')
  'raflixnuvio',
  // raflixvidstorm — Task 63: Raflix's server-resolved vidstorm.ru streams
  //   (AES-GCM token decrypt + playlist validation). Ships ALREADY self-proxied
  //   /proxy URLs (origin=vidstorm.ru baked in) — the early passthrough below
  //   ships them unchanged. Under the plain 'raflix' id they matched NO
  //   extractor and were silently dropped (0 VidStorm cards in /stream).
  'raflixvidstorm',
  // desiflix — movies/TV/anime via manifest.desitvhub.eu.org Stremio addon
  //   Streams are direct URLs (flixsix.com MP4, manifest proxy HLS/MP4) with
  //   no Referer needed — NuvioExtractor passes them through as direct URLs.
  'desiflix',
  // V2 Nuvio-helper sources — use buildStreamResults from nuvioHelpers.js
  // which sets meta.nuvioProvider = true. These don't currently set
  // nuvioReferer (URLs are direct-playable), so NuvioExtractor routes them
  // as direct URLs (the "else" fallback). Adding them here ensures that if
  // they ever start returning Referer headers, the extractor will handle
  // them correctly instead of silently dropping the Referer.
  //   - hindmovie: GDShine workers.dev (direct MKV, no Referer)
  //   - hdhub4uv2: GDrive googleusercontent + acek-cdn/dramiyos-cdn HLS
  //   - movieshuntv2: hubcloud R2 + pixeldrain + GDrive (no Referer)
  //   - moviesdrivev2: GDrive googleusercontent (no Referer, /range-proxy)
  'hindmovie', 'hdhub4uv2', 'movieshuntv2', 'moviesdrivev2',
  // vixsrc — Task 51 revival: playlist API URL ships DIRECT with
  // Referer/Origin: vixsrc.to (meta.nuvioDirectWithHeaders) — vixsrc.to
  // CF-blocks datacenter IPs so /proxy can never work; the player's
  // residential IP with proxyHeaders is the only viable path (peraspera
  // precedent). Without joining this set the playlist URL matched NO
  // extractor and was silently dropped.
  'vixsrc',
  // persianstremio — Persian dual-audio direct MP4/MKV (needs Referer:
  // persianstremio.vercel.app for cinamadownload.top / aslmd.sbs URLs)
  'persianstremio',
  // Orphan Nuvio sources (registered in batch) — all use buildStreamResults
  //   - videasyto: speedracelight API (direct playable, no Referer)
  //   - kmmovies: kmmovies.pics → R2 + Pixeldrain (direct playable MKV, no Referer)
  //   (dahmermovies + dahmermovies4k removed Task 50 — user request)
  'videasyto', 'kmmovies',
  // Task 25 ground-truth audit: both sources scrape fine but their results
  // matched NO extractor → silently dropped at StreamResolver's extraction
  // stage (0 cards in every /stream response despite healthy scrapes).
  //   - imdbplay: returns ALREADY-PROXIED self /proxy URLs (ctx.hostUrl) —
  //     NuvioExtractor's no-Referer passthrough ships them unchanged
  //     (mirrors 'playimdb', which was already in this set)
  //   (stellarrip was in this set — REMOVED 2026-09, dead upstream)
  'imdbplay',
  // animotvslash — anime hardsub/softsub via animotvslash.org (Task 28).
  //   Streams: rumble.com HLS (Referer: animotvslash.org), videas.fr HLS
  //   (Origin-gated, INVERTED hotlink gate — 403 WITH Referer; ships
  //   nuvioOrigin only), videas.fr MP4 tiers, VidHide hls2/hls3 masters
  //   (Referer from embed origin), Vidara API HLS (Referer), megaplay
  //   fetch.nexabloom.top (NO_REFERER_HOSTS → direct player-IP fetch, same
  //   as animesuge). Without joining this set every URL matched NO extractor
  //   and was silently dropped at StreamResolver's extraction stage.
  'animotvslash',
  // antarctica — Task 77: comet.feels.legal (TorBox debrid cache) direct MKVs.
  //   Extension-less /playback/<hash>/<idx> URLs, NO Referer (UA only) →
  //   no-Referer branch ships them DIRECT (player's own IP; 206 Range from
  //   sandbox). Without joining this set every card matched NO extractor
  //   and was silently dropped (Task 25 failure class).
  'antarctica',
]);

// Detect if URL is clearly HLS (m3u8 file or /playlist path)
function isHlsUrl(url) {
  const p = url.pathname.toLowerCase();
  return p.endsWith('.m3u8') || p.includes('.m3u8') || p.includes('/m3u8/') || p.includes('/playlist');
}

// Detect if URL is clearly a video file (MP4/MKV)
function isVideoFileUrl(url) {
  const p = url.pathname.toLowerCase();
  return p.endsWith('.mp4') || p.endsWith('.mkv') || p.endsWith('.webm') || p.endsWith('.avi') || p.endsWith('.mov');
}

export class NuvioExtractor extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'nuvio';
    this.label = 'Nuvio';
    this.ttl = 1800000; // 30min — Nuvio stream URLs often have short-lived tokens
  }

  supports(_ctx, _url, meta) {
    // Match any Nuvio source by meta.sourceId
    return NUVIO_SOURCE_IDS.has(meta?.sourceId);
  }

  async extractInternal(ctx, url, meta) {
    const referer = meta?.nuvioReferer || '';
    const forceHls = meta?.nuvioForceHls === true;
    const userAgent = meta?.nuvioUserAgent || '';
    // Origin header (Stellar: its CDN workers 403 without Origin: stellar.gdn).
    // Appended as origin= on /proxy URLs; the proxy sends it upstream AND
    // propagates it onto every rewritten m3u8 URL (whole-tree auth).
    const origin = meta?.nuvioOrigin || '';
    const hls = isHlsUrl(url);
    const videoFile = isVideoFileUrl(url);

    // Task 60: some Nuvio sources (Atlantic) ship ALREADY self-proxied URLs —
    // the addon's own /proxy with origin/referer/hls baked into the query
    // (peraspera payload masters need whole-tree header injection, which only
    // the proxy can do: iOS players never send custom headers). Ship them
    // unchanged — re-wrapping here would double every Render hop per segment.
    if (url.hostname === ctx.hostUrl.hostname && url.pathname === '/proxy') {
      return [{
        url,
        format: Format.hls,
        meta: { ...meta },
      }];
    }

    // Hub-family hosts (hubcloud/hubdrive/hubcdn/gdflix) are DOWNLOAD PAGES —
    // direct-shipping them is a guaranteed "[mpv] unrecognized file format"
    // (KMMovies' 15 hubcloud.foo/drive pages shipped raw this way). This
    // extractor sits BEFORE HubExtractor in the registry order, so returning
    // [] here lets the registry's fallback chain hand the URL to
    // HubExtractor, which resolves the page into real direct-file URLs.
    if (HUB_HOST_PATTERN.test(url.hostname)) {
      return [];
    }

    // hblinks.co archive pages — same poison class, dedicated extractor
    // downstream (HBLinks). Task 41: see DOWNLOAD_PAGE_HOST_PATTERN comment.
    if (!hls && !videoFile && DOWNLOAD_PAGE_HOST_PATTERN.test(url.hostname)) {
      return [];
    }

    // Embed/player PAGE hosts — never ship the raw HTML page (poison class).
    // Return [] so the registry fallback chain resolves via the dedicated
    // extractors (Megaplay / VidSrc / Vidzee / VidKing / EmbedResolver).
    // See EMBED_PAGE_HOST_PATTERN comment above.
    if (!hls && !videoFile && EMBED_PAGE_HOST_PATTERN.test(url.hostname)) {
      return [];
    }

    // Google Drive hosts don't support HTTP Range — route through /range-proxy
    // for Range translation so Stremio can seek. This applies to UHDMovies
    // (googleusercontent) and MoviesDrive (lh3.googleusercontent).
    // /range-proxy does NOT support Referer — Google URLs don't need Referer.
    if (url.hostname.includes('googleusercontent.com')) {
      const proxyUrl = new URL('/range-proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      return [{
        url: proxyUrl,
        format: Format.mp4,
        meta: { ...meta },
      }];
    }

    // Task 54 fix4 — DATACENTER-EGRESS-BLOCKED referer hosts. Verified LIVE on
    // i-cdn-*.salsa436jam.com (cineby hdmovie family): the host serves plain
    // fetch 200 #EXTM3U (with the vidking referer) to residential/sandbox IPs
    // but 404s EVERYTHING from our Render datacenter egress — got-scraping AND
    // plain undici alike, so no /proxy fetcher strategy can ever work (the
    // fix3 fingerprint fallback cannot rescue an IP block). The playlist's
    // embedded IP signature is NOT enforced (a Render-signed URL fetched 200
    // from a different IP), so the PLAYER's residential IP + the vidking
    // referer via Stremio behaviorHints.proxyHeaders is the viable path —
    // same peraspera class as atlantic (nuvioDirectWithHeaders) / vixsrc.
    const DATACENTER_DIRECT_RE = /(^|\.)salsa\d*jam\.com$/i;
    if (DATACENTER_DIRECT_RE.test(url.hostname) && referer) {
      const requestHeaders = { Referer: referer };
      if (origin) requestHeaders['Origin'] = origin;
      if (userAgent) requestHeaders['User-Agent'] = userAgent;
      return [{
        url,
        format: videoFile ? Format.mp4 : Format.hls,
        meta: { ...meta },
        requestHeaders,
      }];
    }

    // Task 48: atlantic's peraspera.nbsycfzrpa4.workers.dev 429-blocks
    // DATACENTER IPs (Cloudflare) — server-side /proxy fetch fails for
    // everyone (502/429, both undici and got-scraping), but the PLAYER's
    // residential IP with Origin/Referer passes (exactly the request the real
    // site's browser makes — sandbox-verified 200). Ship the URL DIRECT with
    // requestHeaders → Stremio proxyHeaders on the final card. Opt-in via
    // meta.nuvioDirectWithHeaders (only the atlantic source sets it).
    if (meta?.nuvioDirectWithHeaders === true) {
      const requestHeaders = {};
      if (referer) requestHeaders['Referer'] = referer;
      if (origin) requestHeaders['Origin'] = origin;
      if (userAgent) requestHeaders['User-Agent'] = userAgent;
      return [{
        url,
        format: videoFile ? Format.mp4 : Format.hls,
        meta: { ...meta },
        requestHeaders,
      }];
    }

    // Routing strategy (same as HiAnime/AnimeKai pattern):
    //   - HLS + Referer → /proxy (proxy rewrites m3u8 URLs + sends Referer)
    //   - Ambiguous URL + Referer → /proxy with forceHls=1
    //   - MP4/MKV + Referer → direct URL with requestHeaders (proxyHeaders)
    //   - forceHls (no Referer) → /proxy with forceHls=1 (AniChan: m3u8 with
    //     relative variant URLs that need rewriting, but no Referer needed)
    //   - No Referer, no forceHls → direct URL
    if (referer && hls) {
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      proxyUrl.searchParams.set('referer', referer);
      if (origin) proxyUrl.searchParams.set('origin', origin);
      return [{
        url: proxyUrl,
        format: Format.hls,
        meta: { ...meta },
      }];
    } else if (referer && !videoFile) {
      // Ambiguous URL with Referer — use forceHls so proxy detects HLS
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      proxyUrl.searchParams.set('referer', referer);
      if (origin) proxyUrl.searchParams.set('origin', origin);
      proxyUrl.searchParams.set('forceHls', '1');
      return [{
        url: proxyUrl,
        format: Format.hls,
        meta: { ...meta },
      }];
    } else if (forceHls) {
      // forceHls without Referer — route through /proxy with forceHls=1
      // (AniChan m3u8 has relative variant URLs that need rewriting)
      const proxyUrl = new URL('/proxy', ctx.hostUrl);
      proxyUrl.searchParams.set('url', url.href);
      if (origin) proxyUrl.searchParams.set('origin', origin);
      proxyUrl.searchParams.set('forceHls', '1');
      return [{
        url: proxyUrl,
        format: Format.hls,
        meta: { ...meta },
      }];
    } else if (referer) {
      // MP4/MKV with Referer → direct URL with requestHeaders
      const requestHeaders = { Referer: referer };
      if (userAgent) requestHeaders['User-Agent'] = userAgent;
      if (origin) requestHeaders['Origin'] = origin;
      return [{
        url,
        format: Format.mp4,
        meta: { ...meta },
        requestHeaders,
      }];
    } else {
      // No Referer → direct URL
      return [{
        url,
        format: hls ? Format.hls : Format.mp4,
        meta: { ...meta },
      }];
    }
  }
}
