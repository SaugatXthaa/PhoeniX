// src/source/StellarRip.js
// stellar.rip — movies/TV/anime with direct HLS streams (up to 4K)
//
// Uses the all-in-one scraper (src/nuvio/stellarrip.cjs) which:
//   1. Fetches embed page → __REQUEST_TOKEN__ (JWT)
//   2. POST /api/playback-init → PoW challenge (18 bits)
//   3. Solve PoW: SHA-256(challenge + nonce) with 18 leading zero bits
//   4. POST /api/playback-init with PoW → streamToken
//   5. POST /api/encrypt per source → signed URL
//   6. GET stream-encrypted → direct HLS URL on proxy2.heistotron.uk
//
// 6 sources: s2 (4K!), s0 (1080p), s3 (1080p scope), s1 (720p), s4/s5 (SD)
// Stream needs Referer: embed URL + Origin: https://stellar.rip via proxyHeaders

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { withRetryOnEmpty } from './nuvioHelpers.js';
import { TMDB_PRIMARY } from '../utils/site-secrets.cjs'; // central site-secret registry (env-overridable)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER_PATH = path.join(__dirname, '..', 'nuvio', 'stellarrip.cjs');
const require_ = createRequire(import.meta.url);

let _scraperMod = null;
function getScraperModule() {
  if (_scraperMod) return _scraperMod;
  try { _scraperMod = require_(PROVIDER_PATH); }
  catch (e) { console.error(`[stellarrip] failed to load scraper: ${e?.message || e}`); }
  return _scraperMod;
}

function parseHeight(q) {
  if (!q) return undefined;
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 2160;
  if (s.includes('1080')) return 1080;
  if (s.includes('720')) return 720;
  if (s.includes('480')) return 480;
  if (s.includes('sd')) return 360;
  const m = s.match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : undefined;
}

// Source ID → friendly name mapping — Task 64: imported from the provider,
// which mirrors the site's CURRENT 18-server catalog (Spica, Vega, Sirius,
// Rigel, Capella, Betelgeuse, Arcturus, Procyon, Aldebaran, Deneb, Altair,
// Antares, Regulus, Castor, Polaris, Fomalhaut, Bellatrix, Pollux).
const FALLBACK_SERVER_NAMES = {
  s0: 'Sirius', s1: 'Polaris', s2: 'Rigel', s3: 'Pollux', s4: 'Procyon',
  s5: 'Aldebaran', s6: 'Deneb', s7: 'Antares', s8: 'Regulus', s10: 'Bellatrix',
  s12: 'Fomalhaut', s13: 'Arcturus', s15: 'Altair', s16: 'Castor',
  s19: 'Betelgeuse', s24: 'Spica', s25: 'Vega', s26: 'Capella',
};

export class StellarRip extends Source {
  constructor(fetcher) {
    super();
    this.id = 'stellarrip';
    this.label = 'StellarRip';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.en];
    this.baseUrl = 'https://stellar.rip';
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Detect anime
    let isAnime = false;
    try {
      const type = tmdbId.season ? 'tv' : 'movie';
      const url = `https://api.themoviedb.org/3/${type}/${tmdbId.id}?api_key=${TMDB_PRIMARY}`;
      const { gotScraping } = await import('got-scraping');
      const r = await gotScraping.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeout: { request: 8000 }, throwHttpErrors: false, http2: false,
      });
      if (r.statusCode === 200) {
        const data = JSON.parse(r.body);
        isAnime = data.original_language === 'ja' &&
          (data.genres || []).some(g => g.id === 16);
      }
    } catch { /* best effort */ }

    const baseCountryCodes = isAnime
      ? [CountryCode.multi, CountryCode.ja]
      : [CountryCode.multi, CountryCode.en];

    const mod = getScraperModule();
    if (!mod || typeof mod.getStreams !== 'function') return [];

    // Task 52 CONTRACT FIX: stellarrip.cjs's getStreams gates TV on
    // `type !== 'tv'` (its own doc: getStreams('1396', 'tv', 1, 1)). Passing
    // 'series' silently routed EVERY series resolve down the movie path —
    // wrong TMDB lookup (AoT 1429 → "25th Hour (2002)") AND the movie embed
    // URL /en/watch/embed/movie/<id> instead of /en/watch/embed/tv/<id>-<s>-<e>
    // → 0 streams for all series since the source landed.
    const stellarType = tmdbId.season ? 'tv' : 'movie';
    let rawStreams;
    try {
      rawStreams = await Promise.race([
        // Task 38: bounded retry-on-empty — stellar.rip availability flickers
        // (all servers "unavailable" windows) returned [] and the 60s negative
        // cache then hid the recovery from users.
        // Task 82 retune: the provider's chain now converges inside ~29s
        // (deadline sweep), so the old 25s race killed batch 1 mid-flight
        // even when streams existed (site degraded to 8-12s/round-trip on
        // 09-23; Dune2 encrypt returned a REAL stream-OK URL that the old
        // budget never lived to collect). Race 32s keeps everything inside
        // the resolver's 35s cutoff; retry only fires when attempt 1 was
        // FAST (finished by 26s = healthy site), so a slow-window attempt 2
        // can never start and get discarded by the race.
        withRetryOnEmpty(() => mod.getStreams(String(tmdbId.id), stellarType, tmdbId.season || null, tmdbId.episode || null), { attempts: 2, maxTotalMs: 26000, tag: 'stellarrip' }),
        new Promise(r => setTimeout(() => r(null), 32000)),
      ]);
    } catch (e) {
      console.error(`[stellarrip] error: ${e?.message || e}`);
      return [];
    }

    if (!Array.isArray(rawStreams) || rawStreams.length === 0) return [];

    // Build results directly — StellarRip streams need proxyHeaders (Referer + UA)
    const results = [];
    for (const s of rawStreams) {
      if (!s || !s.url || typeof s.url !== 'string') continue;
      if (!s.url.startsWith('http')) continue;

      let url;
      try { url = new URL(s.url); } catch { continue; }

      const sourceId = (s.name || '').replace(/^Stellar\s*-\s*/, '').trim();
      const serverName = (mod.SERVER_NAMES && mod.SERVER_NAMES[sourceId]) || FALLBACK_SERVER_NAMES[sourceId] || sourceId || 'Stellar';
      const height = parseHeight(s.quality) || 1080;
      const codec = height >= 2160 ? 'HEVC' : 'x264';
      const audioLabel = isAnime ? 'Japanese' : 'English';
      const is4K = height >= 2160;

      // Get proxyHeaders from scraper (Referer + Origin + User-Agent)
      const proxyHeaders = s.behaviorHints?.proxyHeaders?.request || {};
      const userAgent = proxyHeaders['User-Agent'] ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      const referer = proxyHeaders['Referer'] || 'https://stellar.rip/';

      // Build enriched title with movie name + metadata markers
      const displayTitle = `${title} — [StellarRip ${serverName}] ${height}p WEB-DL ${codec}${is4K ? ' HDR' : ''} ${audioLabel}`;

      results.push({
        url,
        format: Format.hls,
        // requestHeaders triggers proxyHeaders routing in StreamResolver
        requestHeaders: { 'User-Agent': userAgent, 'Referer': referer, 'Origin': 'https://stellar.rip' },
        meta: {
          countryCodes: baseCountryCodes,
          title: displayTitle,
          sourceId: this.id,
          sourceLabel: this.label,
          height,
          sourceType: 'WebDL',
          codec,
          serverName,
          ...(is4K && { hdr: 'HDR' }),
          // stellar.rip CDN is Origin-gated (same hotlink gate as Stellar):
          // NuvioExtractor reads these to route HLS through /proxy with
          // Referer+Origin attached (whole-tree auth on rewritten m3u8s).
          // Task 25: without them the results matched no extractor and were
          // silently dropped at the extraction stage (0 cards in /stream).
          nuvioReferer: referer,
          nuvioOrigin: 'https://stellar.rip',
        },
      });
    }

    // Dedupe by URL
    const seen = new Set();
    const deduped = results.filter(r => {
      const key = r.url.href;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`[stellarrip] ${deduped.length} playable stream(s)`);
    return deduped;
  }
}
