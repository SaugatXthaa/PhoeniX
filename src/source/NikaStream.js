// src/source/NikaStream.js
// nikastream.blog — anime with sub + dub audio and multi-language subtitles
//
// Uses the all-in-one NikaStream scraper (src/nuvio/nikastream.cjs) which
// queries the Anivexa Cloudflare Worker API (anivexa-api.sudeepdon119.
// workers.dev) — a unified aggregator over ~11 anime source providers.
//
// Flow:
//   1. Resolve TMDB ID + name/year
//   2. Scraper resolves AniList ID via AniList GraphQL by title
//   3. Scraper queries all providers in parallel for episode lists
//   4. Scraper queries /watch for each provider × (sub, dub)
//   5. Scraper validates stream URLs and returns Stremio stream objects
//
// Stream types returned by the scraper:
//   - type: "hls"   → direct m3u8 URL (kryntal.top — needs Referer)
//   - type: "mp4"   → direct video file URL (animegg.org)
//   - type: "iframe"→ embed page URL (flixcloud.cc encrypted; Stremio can't
//                     decrypt server-side — skipped, same as CineJoy embeds)
//
// Subtitles: each stream carries a `subtitles` array (Stremio format:
//   { id, url, lang }). We pass them through meta.subtitles so StreamResolver
//   attaches them to the final stream output.
//
// Enriched metadata: title contains "SUB" or "DUB" + provider + server name
//   so StreamResolver.enrichMeta can parse quality/codec/sourceType.

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'nikastream.cjs');
const require_ = createRequire(import.meta.url);

// Cache the scraper module — nikastream.cjs has no initialization side
// effects but caching avoids re-reading the file on every request.
let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try {
    _scraperMod = require_(PROVIDER_PATH);
  } catch (e) {
    console.error(`[nikastream] failed to load scraper: ${e?.message || e}`);
    return null;
  }
  return _scraperMod;
}

// Parse a quality string into a height number for meta.height.
// Handles "1080p", "720p", "4k", "2160p", "unknown", etc.
function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
  const m = s.match(/(\d{3,4})p/);
  if (m) return parseInt(m[1], 10);
  // "1080" / "720" / "480" without "p"
  const bare = s.match(/^(\d{3,4})$/);
  return bare ? parseInt(bare[1], 10) : undefined;
}

// Normalize a subtitle object from the scraper format
//   { id, url, lang, name, srclang, language, label }
// to Stremio format:
//   { id, url, lang }
//
// The scraper already converts subtitles to {id, url, lang} format with
// `id` set to `srclang` (e.g. "ar" for Arabic). We prefer the existing
// `id` field, then fall back to srclang/language before the human-readable
// `lang`/`label` fields. This ensures each subtitle gets a unique,
// stable, language-code-style ID (e.g. "ar", "en", "fr") rather than
// collapsing all subtitles to "Arabic" / "English" / etc.
function normalizeSubtitle(sub) {
  if (!sub || !sub.url) return null;
  const id = sub.id || sub.srclang || sub.language || sub.lang || sub.label || 'en';
  const lang = sub.lang || sub.language || sub.srclang || sub.label || sub.id || 'en';
  return {
    id: typeof id === 'string' ? id.slice(0, 8) : 'en',
    url: sub.url,
    lang: typeof lang === 'string' ? lang : 'en',
  };
}

// Skip iframe streams — Stremio's runtime can't run JS inside iframes from
// external domains, so embed URLs (flixcloud.cc encrypted player) just hang.
// Only direct m3u8/mp4 streams play correctly.
function isPlayableStream(s) {
  if (!s || !s.url || typeof s.url !== 'string') return false;
  if (!s.url.startsWith('http')) return false;
  if (s.type === 'iframe') return false;
  if (s.behaviorHints?.notWebVideo) return false;
  return true;
}

// Extract the provider name from the scraper's stream name
//   "NikaStream - anikoto SUB kryntal"  →  "anikoto"
function extractProvider(s) {
  const m = (s.name || '').match(/- (\w+)\s/i);
  return m ? m[1] : '';
}

// Extract audio type (sub/dub) from the title
//   "Title [NikaStream anikoto SUB kryntal E1]" → "sub"
//   "Title [NikaStream reanime DUB flixcloud E1]" → "dub"
function extractAudio(s) {
  const t = (s.title || '').toUpperCase();
  if (/\bDUB\b/.test(t)) return 'dub';
  if (/\bSUB\b/.test(t)) return 'sub';
  return '';
}

// Extract server name from the scraper's stream name
//   "NikaStream - anikoto SUB kryntal"  →  "kryntal"
function extractServer(s) {
  const m = (s.name || '').match(/- \w+\s+(?:SUB|DUB)\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

export class NikaStream extends Source {
  constructor(fetcher) {
    super();
    this.id = 'nikastream';
    this.label = 'NikaStream';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = 'https://nikastream.blog';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // NikaStream is anime-only — bail early for non-TV anime content
    // (movies can still be anime films, so only skip non-TV series)
    const mediaType = tmdbId.season ? 'tv' : 'movie';

    // Load cached scraper module
    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

    let streams;
    try {
      streams = await Promise.race([
        mod.getStreams(String(tmdbId.id), mediaType, tmdbId.season || null, tmdbId.episode || null),
        new Promise(r => setTimeout(() => r(null), 70000)),
      ]);
    } catch (e) {
      console.error(`[nikastream] getStreams error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(streams) || streams.length === 0) return [];

    const results = [];
    const seenUrls = new Set(); // dedup by URL (some providers return same URL for sub+dub)

    for (const s of streams) {
      if (!isPlayableStream(s)) continue;

      const dedupeKey = s.url;
      if (seenUrls.has(dedupeKey)) continue;
      seenUrls.add(dedupeKey);

      let parsed;
      try { parsed = new URL(s.url); } catch { continue; }

      const provider = extractProvider(s);
      const audio = extractAudio(s);
      const server = extractServer(s);
      const height = parseHeight(s.quality) || 1080; // most anime HLS is 1080p

      // Build country codes based on audio (dub = English audio, sub = Japanese)
      const countryCodes = audio === 'dub'
        ? [CountryCode.multi, CountryCode.en]
        : [CountryCode.multi, CountryCode.ja];

      // Build enriched display title with metadata markers
      // Format: "{title} [NikaStream {provider} {audio} {server}] {height}p WEB-DL {codec}"
      // enrichMeta parses: height, sourceType (WebDL), codec (HEVC/x264)
      const audioLabel = audio === 'dub' ? 'DUB' : (audio === 'sub' ? 'SUB' : '');
      const serverTag = server ? ` ${server}` : '';
      const providerTag = provider ? `${provider} ${audioLabel}${serverTag}` : audioLabel;
      const codec = height >= 2160 ? 'HEVC' : 'x264';
      const enrichedTitle = `${title} [NikaStream ${providerTag}] ${height}p WEB-DL ${codec} ${audio === 'dub' ? 'English' : 'Japanese'}`;

      // Detect HLS vs MP4
      const urlPath = parsed.pathname.toLowerCase();
      const isHls = urlPath.includes('.m3u8') || urlPath.includes('/playlist') || s.type === 'application/vnd.apple.mpegurl';
      const isMp4 = urlPath.endsWith('.mp4') || s.type === 'video/mp4';

      // Extract Referer from proxyHeaders (set by scraper for kryntal.top etc.)
      const referer = s.behaviorHints?.proxyHeaders?.request?.Referer || '';

      // Normalize subtitles into Stremio format
      const subs = Array.isArray(s.subtitles)
        ? s.subtitles.map(normalizeSubtitle).filter(Boolean)
        : [];

      // Build meta — including subtitles for StreamResolver pass-through
      const meta = {
        countryCodes,
        title: enrichedTitle,
        sourceId: this.id,
        sourceLabel: this.label,
        ...(height && { height }),
        sourceType: 'WebDL',
        codec,
        // Nuvio extractor flags (so NuvioExtractor handles proxy routing)
        nuvioProvider: true,
        ...(referer && { nuvioReferer: referer }),
        ...(isHls && referer && { nuvioForceHls: true }),
        // Stremio subtitle tracks — StreamResolver attaches these to the
        // final stream object so Stremio shows them in the player.
        ...(subs.length > 0 && { subtitles: subs }),
        // Extra display info
        ...(provider && { serverName: provider }),
      };

      results.push({
        url: parsed,
        format: isHls ? Format.hls : (isMp4 ? Format.mp4 : Format.unknown),
        meta,
      });
    }

    // Log final stream count for debugging
    console.log(`[nikastream] ${results.length} playable stream(s) (skipped ${streams.length - results.length} iframe/duplicate)`);

    return results;
  }
}
