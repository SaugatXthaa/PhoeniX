// rivestream.ru — Multi-Server Direct Stream Extractor (Movies + TV, up to 4K)
// ============================================================================
// Scrapes DIRECT PLAYABLE HLS streams from rivestream.ru by iterating ALL 11
// backend providers exposed by scrapper.rivestream.app/api/providers.
//
// CHAIN
//   rivestream.ru (Next.js front)  →  scrapper.rivestream.app  →  per-provider
//   scrapers (apex, pulse, solstice, quasar, horizon, primevids, flowcast,
//   asiacloud, citadel, hindicast, guru).
//
// API
//   GET https://scrapper.rivestream.app/api/providers
//     → ["apex","pulse","solstice","quasar","horizon","primevids","flowcast",
//        "asiacloud","citadel","hindicast","guru"]
//   GET https://scrapper.rivestream.app/api/provider?provider=<p>&id=<tmdbId>
//       [&season=<S>&episode=<E>]                    ← TV
//       [&cb=<Math.floor(Date.now()/3e6)>]           ← cache-bust for primevids/citadel
//     → { data: { sources: [{ quality, url, source, format }], captions: [] } }
//
// HEADERS / REFERER GATE
//   The proxy.garageband.rocks + cloudorchestranova.com chain (from IMDbPlay)
//   is replaced here by a `proxy.valhallastream.dpdns.org/m3u8-proxy?url=...`
//   wrapper for the Apex provider. The proxy REQUIRES `Referer: https://rivestream.ru/`
//   to authorize the request — same Referer is needed for PrimeVids (ngcorp.dad)
//   and Citadel (img1.< rotating domain>) direct media playlists.
//
// PLAYLIST TYPES
//   - Apex / PrimeVids TV:  master.m3u8 with multiple #EXT-X-STREAM-INF variants.
//   - Citadel:              media playlist (segments only) per language/quality.
//   - PrimeVids movies:     media playlist (single quality).
//   - Quasar:               master.m3u8 with 1 variant (uqload.vc).
//   Segment URLs may be .jpg (Citadel) or arbitrary paths (PrimeVids via
//   crimsomdream.site) — these are HLS-over-HTTPS disguise tricks and play fine
//   in hls.js / video.js / ExoPlayer / AVPlayer.
//
// USAGE
//   node rivestream_all_in_one.js <tmdbId> <movie|tv> [season] [episode]
//   node rivestream_all_in_one.js 693134 movie            # Dune Part Two → ~14 streams
//   node rivestream_all_in_one.js 1396 tv 1 1           # Breaking Bad S01E01

'use strict';

const https = require('https');
const http = require('http');

const PROVIDER_NAME = 'RiveStream';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const SCRAPPER_API = 'https://scrapper.rivestream.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// The proxy / CDN nodes that gate on Referer — we send this on every playlist request.
const REFERER = 'https://rivestream.ru/';

// All 11 providers — order = priority (most-reliable multi-quality first).
// Note: asiacloud, flowcast, hindicast, guru, pulse, horizon, solstice are
// intermittent upstreams — they often return null or time out. Keep them in
// the list (covered when they're up) but with a short per-call timeout so the
// whole resolve finishes in <30s.
const ALL_PROVIDERS = [
  'apex',       // proxied master.m3u8 with 3+ variants (360p/720p/1080p, sometimes 4K)
  'citadel',    // multi-language (English/Hindi/Tamil/Telugu/Kannada) × (720p/480p)
  'primevids',  // ngcorp.dad HLS — movies: media playlist; TV: master.m3u8
  'quasar',     // uqload.vc HLS — usually 720p
  'solstice',   // intermittent
  'horizon',
  'pulse',
  'flowcast',
  'asiacloud',
  'hindicast',
  'guru',
];

// Providers that are known to be slow / intermittent — use a shorter timeout
// so we don't block the whole resolve waiting on them.
const SLOW_PROVIDERS = new Set(['asiacloud', 'flowcast', 'hindicast', 'guru', 'pulse', 'horizon', 'solstice']);

// ─── HTTP helpers ───────────────────────────────────────────────────────────
function fetchBuf(url, { headers = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': UA, 'Referer': REFERER, 'Accept': '*/*', ...headers },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function fetchJson(url, opts = {}) {
  const r = await fetchBuf(url, { ...opts, headers: { Accept: 'application/json, */*', ...(opts.headers || {}) } });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${url}`);
  return JSON.parse(r.body.toString('utf8'));
}

async function fetchText(url, opts = {}) {
  const r = await fetchBuf(url, opts);
  if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.body.toString('utf8');
}

// ─── TMDB info ──────────────────────────────────────────────────────────────
async function getTMDBInfo(tmdbId, type) {
  const isTV = type === 'tv' || type === 'series';
  const url = `https://api.themoviedb.org/3/${isTV ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
  try {
    const j = await fetchJson(url, { headers: { Referer: '' } });
    return {
      title: (isTV ? j.name : j.title) || 'Unknown',
      year: ((isTV ? j.first_air_date : j.release_date) || '').slice(0, 4),
      tmdbId: String(tmdbId),
      type,
    };
  } catch (e) { console.log(`[RiveStream] TMDB fetch failed: ${e.message}`); return null; }
}

// ─── Per-provider fetch ─────────────────────────────────────────────────────
async function fetchProviderSources(provider, tmdbId, isTV, season, episode) {
  let url = `${SCRAPPER_API}/api/provider?provider=${provider}&id=${tmdbId}`;
  if (isTV && season != null && episode != null) url += `&season=${season}&episode=${episode}`;
  // Cache-bust for primevids/citadel (matches the front-end behaviour).
  if (provider === 'primevids' || provider === 'citadel') {
    url += `&cb=${Math.floor(Date.now() / 3e6)}`;
  }
  const timeout = SLOW_PROVIDERS.has(provider) ? 8000 : 20000;
  try {
    const j = await fetchJson(url, { timeout });
    if (!j || !j.data || !Array.isArray(j.data.sources)) return [];
    return j.data.sources.filter(s => s && s.url);
  } catch (e) {
    console.log(`[RiveStream]   ${provider}: error ${e.message.slice(0, 80)}`);
    return [];
  }
}

// ─── Parse master.m3u8 ──────────────────────────────────────────────────────
function parseMasterM3u8(text, streamUrl) {
  if (!text || !text.startsWith('#EXTM3U')) return [];
  const variants = [];
  let currentRes = null, currentBw = null, currentCodecs = null, currentFps = null, currentHdr = null;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const resMatch = l.match(/RESOLUTION=(\d+)x(\d+)/);
      currentRes = resMatch ? { w: parseInt(resMatch[1]), h: parseInt(resMatch[2]) } : null;
      const bwMatch = l.match(/BANDWIDTH=(\d+)/);
      currentBw = bwMatch ? parseInt(bwMatch[1]) : null;
      const codecsMatch = l.match(/CODECS="([^"]+)"/);
      currentCodecs = codecsMatch ? codecsMatch[1] : null;
      const fpsMatch = l.match(/FRAME-RATE=([\d.]+)/);
      currentFps = fpsMatch ? parseFloat(fpsMatch[1]) : null;
      currentHdr = /VIDEO-RANGE=PQ/.test(l) ? 'HDR/DV' : null;
    } else if (l && !l.startsWith('#') && currentRes) {
      let v;
      if (l.startsWith('http')) v = l;
      else if (l.startsWith('/')) {
        // The Apex proxy serves relative paths under proxy.valhallastream.dpdns.org
        const base = streamUrl.startsWith('https://proxy.valhallastream.dpdns.org')
          ? 'https://proxy.valhallastream.dpdns.org'
          : new URL(streamUrl).origin;
        v = base + l;
      } else { const base = streamUrl.replace(/\/[^/]*$/, ''); v = `${base}/${l}`; }
      // Carry the upstream token if present in the master URL.
      const tm = streamUrl.match(/[?&]token=([^&]+)/);
      if (tm && !v.includes('token=')) v += (v.includes('?') ? '&' : '?') + 'token=' + tm[1];
      const h = currentRes.h, w = currentRes.w;
      const primaryH = h >= 2160 || w >= 3840 ? 2160
                    : h >= 1440 || w >= 2560 ? 1440
                    : h >= 1080 || w >= 1920 ? 1080
                    : h >= 720  || w >= 1280 ? 720
                    : h >= 480  || w >= 852  ? 480
                    : 360;
      const quality = primaryH >= 2160 ? '4K' : primaryH >= 1440 ? '1440p' : primaryH >= 1080 ? '1080p' : primaryH >= 720 ? '720p' : primaryH >= 480 ? '480p' : '360p';
      variants.push({
        resolution: currentRes, bandwidth: currentBw, codecs: currentCodecs,
        fps: currentFps, hdr: currentHdr, quality, url: v,
      });
      currentRes = null; currentBw = null; currentCodecs = null; currentFps = null; currentHdr = null;
    }
  }
  return variants;
}

// Parse the quality label from the API for non-master playlists (e.g. Citadel
// returns "720p | English" or "480p | Hindi" — we use that verbatim).
function qualityFromLabel(label) {
  if (!label) return 'HLS';
  const m = label.match(/(\d{3,4})p|(\d{3,4})P|(4K|2160p|1440p|1080p|720p|480p|360p)/i);
  if (m) {
    const q = (m[1] || m[2] || m[3]).toLowerCase();
    if (q === '4k' || q === '2160') return '4K';
    return q.endsWith('p') ? q : q + 'p';
  }
  return label;   // pass through ("HLS", "dcloud", "ipcloud", …)
}

function languageFromLabel(label) {
  if (!label) return 'multi';
  const m = label.match(/\|\s*([A-Za-z]+)\s*$/);
  return m ? m[1] : 'multi';
}

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

// ─── Build Nuvio stream object ──────────────────────────────────────────────
function buildStream(variant, info, providerName, sourceName, language, qualityLabel) {
  const q = variant.quality || qualityFromLabel(qualityLabel) || 'HLS';
  const lang = language || languageFromLabel(qualityLabel) || 'multi';
  const sizeHint = variant.bandwidth ? `~${Math.round(variant.bandwidth / 1000)}kbps` : '';
  const hdrTag = variant.hdr ? ` ${variant.hdr}` : '';
  const fpsTag = variant.fps && variant.fps !== 24 ? ` ${variant.fps}fps` : '';
  const res = variant.resolution ? `${variant.resolution.w}x${variant.resolution.h}` : q;
  // Direct MP4 streams get video/mp4, everything else is HLS.
  const isMp4 = /^https?:.*\.mp4(\?|$)/i.test(variant.url);
  return {
    name: `${PROVIDER_NAME} [${providerName}/${sourceName}] | ${q}${hdrTag}${fpsTag} | ${lang}`,
    title: `${info.title}${info.year ? ` (${info.year})` : ''}${info.epLabel ? ` ${info.epLabel}` : ''} [Rive ${providerName} ${res} ${q}${hdrTag}${fpsTag} ${sizeHint} ${lang}]`,
    url: variant.url,
    quality: q,
    type: isMp4 ? 'video/mp4' : 'application/vnd.apple.mpegurl',
    behaviorHints: {
      bingeGroup: `rivestream-${providerName}-${q}-${lang}`,
      notWebReady: false,
      // Pass required Referer/Origin so any HLS client (Stremio, hls.js, Clappr,
      // ExoPlayer, AVPlayer) can request the playlist + segments successfully.
      proxyHeaders: {
        request: {
          'User-Agent': UA,
          'Referer': REFERER,
          'Origin': 'https://rivestream.ru',
        },
      },
    },
  };
}

// ─── Resolve one source URL into 1..N playable variants ─────────────────────
async function resolveSource(src, providerName, info) {
  const out = [];
  const url = src.url;
  const qualityLabel = String(src.quality || '');
  const sourceName = src.source || providerName;
  const fmt = (src.format || '').toLowerCase();
  const size = src.size ? ` ${formatBytes(parseInt(src.size))}` : '';

  // MP4 streams (FlowCast) — directly playable, no parsing needed.
  // Quality field is numeric (720/480/360).
  if (fmt === 'mp4' || /^https?:.*\.mp4(\?|$)/i.test(url)) {
    const q = /^\d+$/.test(qualityLabel) ? `${qualityLabel}p` : (qualityLabel || 'MP4');
    console.log(`[RiveStream]   ${providerName}/${sourceName} [${q}]${size}: direct MP4`);
    out.push(buildStream({
      url, quality: q, resolution: null, bandwidth: null,
      codecs: null, fps: null, hdr: null,
    }, info, providerName, sourceName, 'multi', q));
    return out;
  }

  // Try fetching the URL — it's either a master.m3u8 (returns variants) or a
  // media playlist (returns segment list — use as-is).
  let text;
  try {
    text = await fetchText(url, {
      headers: { Accept: 'application/vnd.apple.mpegurl, */*' },
      timeout: SLOW_PROVIDERS.has(providerName) ? 6000 : 12000,
    });
  } catch (e) {
    console.log(`[RiveStream]   ${providerName}/${sourceName} [${qualityLabel}]: ${e.message.slice(0, 80)}`);
    return out;
  }

  if (!text.startsWith('#EXTM3U')) {
    console.log(`[RiveStream]   ${providerName}/${sourceName} [${qualityLabel}]: not HLS, got ${text.slice(0, 80)}`);
    return out;
  }

  const variants = parseMasterM3u8(text, url);
  if (variants.length > 0) {
    console.log(`[RiveStream]   ${providerName}/${sourceName} [${qualityLabel}]: master with ${variants.length} variants`);
    for (const v of variants) {
      out.push(buildStream(v, info, providerName, sourceName, languageFromLabel(qualityLabel), qualityLabel));
    }
  } else {
    // Media playlist (segments only) — use the playlist URL directly.
    // Parse quality + language from the API's label (e.g. "720p | Hindi").
    const q = qualityFromLabel(qualityLabel);
    const lang = languageFromLabel(qualityLabel);
    console.log(`[RiveStream]   ${providerName}/${sourceName} [${qualityLabel}]: media playlist (${q} ${lang})`);
    out.push(buildStream({
      url, quality: q, resolution: null, bandwidth: null,
      codecs: null, fps: null, hdr: null,
    }, info, providerName, sourceName, lang, qualityLabel));
  }
  return out;
}

// ─── Public entry ────────────────────────────────────────────────────────────
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isTV = type === 'tv' || type === 'series';
  console.log(`[RiveStream] Request: tmdb=${tmdbId} type=${type}` + (isTV ? ` S${season || '?'}E${episode || '?'}` : ''));

  const info0 = await getTMDBInfo(tmdbId, type);
  if (!info0) return [];
  const info = {
    ...info0,
    epLabel: isTV && season && episode ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : '',
  };
  console.log(`[RiveStream] TMDB: ${info.title} (${info.year})`);

  const allStreams = [];
  const seenUrls = new Set();
  for (const provider of ALL_PROVIDERS) {
    console.log(`[RiveStream] >>> ${provider.toUpperCase()} <<<`);
    const sources = await fetchProviderSources(provider, tmdbId, isTV, season, episode);
    if (sources.length === 0) {
      console.log(`[RiveStream]   no sources`);
      continue;
    }
    console.log(`[RiveStream]   got ${sources.length} source(s)`);
    for (const src of sources) {
      const resolved = await resolveSource(src, provider, info);
      for (const s of resolved) {
        if (!seenUrls.has(s.url)) { seenUrls.add(s.url); allStreams.push(s); }
      }
    }
  }

  const qOrder = { '4K': 0, '2160p': 0, '1440p': 1, '1080p': 2, '720p': 3, '480p': 4, '360p': 5, 'HLS': 6 };
  allStreams.sort((a, b) => (qOrder[a.quality] || 99) - (qOrder[b.quality] || 99));
  console.log(`[RiveStream] ${allStreams.length} stream(s) total`);
  return allStreams;
}

// ─── Module exports ─────────────────────────────────────────────────────────
module.exports = {
  getStreams, getTMDBInfo, fetchProviderSources, resolveSource,
  parseMasterM3u8, qualityFromLabel, languageFromLabel,
  SCRAPPER_API, ALL_PROVIDERS, PROVIDER_NAME,
};

// ─── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('RiveStream.ru Multi-Server Direct Stream Extractor');
    console.log('  Movies + TV — direct playable HLS, all 11 backend servers');
    console.log('');
    console.log('Usage: node rivestream_all_in_one.js <tmdbId> <movie|tv> [season] [episode]');
    console.log('Examples:');
    console.log('  node rivestream_all_in_one.js 693134 movie            # Dune Part Two');
    console.log('  node rivestream_all_in_one.js 1396 tv 1 1           # Breaking Bad S01E01');
    process.exit(1);
  }
  getStreams(args[0], args[1], args[2], args[3])
    .then(s => {
      console.log('\n=== Final playable streams ===');
      if (s.length === 0) { console.log('No streams found.'); return; }
      s.forEach((x, i) => {
        console.log(`${i + 1}. ${x.name}`);
        console.log(`   ${x.url.slice(0, 180)}${x.url.length > 180 ? '...' : ''}`);
      });
      console.log(`\nTotal: ${s.length}`);
    })
    .catch(e => { console.error('FATAL: ' + e.stack); process.exit(1); });
}
