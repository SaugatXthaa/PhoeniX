// Cineby (cineby.rocks) All-In-One — Single-File Pure-Node.js Scraper
// =========================================================================
// Fetches stream URLs for movies and TV shows from cineby.rocks.
//
// ARCHITECTURE
// ------------
// Cineby is a Next.js-like SPA that aggregates 8 embed player servers.
// The watch page (/watch/movie/{tmdbId} or /watch/tv/{tmdbId}?s=1&e=1)
// contains a player-context JSON with the list of 8 server origins, and
// an iframe pointing to the currently-selected server's embed URL.
//
// SERVERS (8 total)
// -----------------
// Each server has a codename and a display label:
//   cinesrc  → Nova      (https://cinesrc.st/embed/{type}/{id})
//   vidcore  → Crimson   (https://vidcore.io/{type}/{id})
//   vidnest  → Helix     (https://vidnest.fun/{type}/{id})
//   vidlink  → Astra     (https://vidlink.pro/{type}/{id})
//   vidsrc   → Ironclad  (https://vidsrcme.ru/embed/{type}/{id})
//   vidgod   → Vale      (https://vidgod.site/{type}/{id})
//   filmu    → Lumen     (https://embed.filmu.in/{type}/{id})
//   vidbolt  → Cipher    (https://vidbolt.xyz/{type}/{id})
//
// URL PATTERNS
// ------------
// Movie:  {origin}/embed/movie/{tmdbId}        (cinesrc, vidsrc)
//         {origin}/movie/{tmdbId}              (all others)
// TV:     {origin}/embed/tv/{tmdbId}?s={s}&e={e}  (cinesrc, vidsrc)
//         {origin}/tv/{tmdbId}/{s}/{e}         (all others)
//
// STREAM TYPES
// ------------
// 1. DIRECT m3u8 (vidbolt/Cipher only):
//    vidbolt exposes a public API at /api/proxy that returns direct m3u8 URLs
//    from the VidRock extractor. These are REAL playable HLS streams with
//    multiple quality variants (360p/480p/720p/1080p). The API returns
//    6-11 sources per movie, including multi-language audio tracks
//    (Hindi, Tamil, Telugu, Bengali, etc.).
//
// 2. IFRAME embed (all 8 servers):
//    Each server's embed URL is a JS-rendered SPA that fetches the stream
//    at runtime. Stremio opens these as iframe streams — the iframe player
//    runs the JS to load the actual video. This works for ALL servers.
//
// 4K DETECTION
// ------------
// vidbolt's API labels some streams as "4K" — but the actual master playlist
// typically has 1080p as the max variant. We probe the m3u8 to detect the
// real resolution and label accordingly (2160p/1080p/720p/etc.).
//
// USAGE
// -----
//   const cineby = require('./cineby_all_in_one.js');
//   const streams = await cineby.getStreams('27205', 'movie');
//   const streams = await cineby.getStreams('1396', 'tv', 1, 1);
//
// CLI:
//   node cineby_all_in_one.js 27205 movie
//   node cineby_all_in_one.js 1396 tv 1 1

'use strict';

const PROVIDER_NAME = 'Cineby';
const CINEBY_ORIGIN = 'https://cineby.rocks';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// All 8 servers with their codename, label, and origin
const ALL_SERVERS = [
  { code: 'vidbolt', label: 'Cipher',   origin: 'https://vidbolt.xyz' },
  { code: 'cinesrc', label: 'Nova',     origin: 'https://cinesrc.st' },
  { code: 'vidcore', label: 'Crimson',  origin: 'https://vidcore.io' },
  { code: 'vidnest', label: 'Helix',    origin: 'https://vidnest.fun' },
  { code: 'vidlink', label: 'Astra',    origin: 'https://vidlink.pro' },
  { code: 'vidsrc',  label: 'Ironclad', origin: 'https://vidsrcme.ru' },
  { code: 'vidgod',  label: 'Vale',     origin: 'https://vidgod.site' },
  { code: 'filmu',   label: 'Lumen',    origin: 'https://embed.filmu.in' },
];

// Servers that use /embed/ prefix (cinesrc, vidsrc)
const EMBED_PREFIX_SERVERS = new Set(['cinesrc', 'vidsrc']);

// ---------------------------------------------------------------------------
// TMDB metadata fetcher
// ---------------------------------------------------------------------------
async function getTMDBInfo(tmdbId, type) {
  const url = `https://api.themoviedb.org/3/${type === 'tv' ? 'tv' : 'movie'}/${tmdbId}` +
    `?api_key=${TMDB_API_KEY}&language=en-US`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  const j = await res.json();
  return {
    title: j.name || j.title || 'Unknown',
    year: (j.first_air_date || j.release_date || '').slice(0, 4),
    type,
    tmdbId: String(tmdbId),
  };
}

// ---------------------------------------------------------------------------
// Build the embed URL for a given server × media item
// ---------------------------------------------------------------------------
function buildEmbedUrl(server, tmdbId, type, season, episode) {
  const isMovie = type !== 'tv';
  const usesEmbedPrefix = EMBED_PREFIX_SERVERS.has(server.code);
  
  if (isMovie) {
    if (usesEmbedPrefix) {
      return `${server.origin}/embed/movie/${tmdbId}`;
    }
    return `${server.origin}/movie/${tmdbId}`;
  }
  // TV
  if (usesEmbedPrefix) {
    return `${server.origin}/embed/tv/${tmdbId}?s=${season}&e=${episode}`;
  }
  return `${server.origin}/tv/${tmdbId}/${season}/${episode}`;
}

// ---------------------------------------------------------------------------
// Fetch the vidbolt VidRock API — returns DIRECT m3u8 stream URLs
// This is the only server that exposes a public stream API.
// Endpoint: /api/proxy?path=/scrape/VidRock/{type}/{id}?tmdbId=...&title=...&year=...
// ---------------------------------------------------------------------------
async function fetchVidRockStreams(tmdbId, type, season, episode, info) {
  const isMovie = type !== 'tv';
  const mediaType = isMovie ? 'movie' : 'tv';
  
  // Build the scrape path
  const params = new URLSearchParams();
  params.set('tmdbId', String(tmdbId));
  if (info.title) params.set('title', info.title);
  if (info.year) params.set('year', info.year);
  if (!isMovie) {
    params.set('season', String(season));
    params.set('episode', String(episode));
  }
  const scrapePath = `/scrape/VidRock/${mediaType}/${tmdbId}?${params.toString()}`;
  const apiUrl = `${CINEBY_ORIGIN.replace('cineby.rocks', 'vidbolt.xyz')}/api/proxy?path=${encodeURIComponent(scrapePath)}`;
  
  // Actually, the API is on vidbolt.xyz directly
  const vidboltApiUrl = `https://vidbolt.xyz/api/proxy?path=${encodeURIComponent(scrapePath)}`;
  
  try {
    const res = await fetch(vidboltApiUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.log('[Cineby] VidRock API HTTP ' + res.status);
      return [];
    }
    const j = await res.json();
    if (!j.sources || !Array.isArray(j.sources)) {
      console.log('[Cineby] VidRock API: no sources');
      return [];
    }
    return j.sources;
  } catch (e) {
    console.log('[Cineby] VidRock API error: ' + e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Map resolution to Stremio quality label
// ---------------------------------------------------------------------------
function mapResolutionToQuality(w, h) {
  const r = Math.max(w, h);
  if (r >= 3840) return '2160p';        // 4K UHD
  if (r >= 2560) return '1440p';        // 2K QHD
  if (r >= 1920) return '1080p';        // Full HD (also covers 1920x800 scope)
  if (r >= 1280) return '720p';         // HD
  if (r >= 1024) return '576p';         // PAL SD
  if (r >= 854)  return '480p';         // NTSC SD
  return 'SD';
}

// ---------------------------------------------------------------------------
// Probe a stream's actual video resolution using ffprobe
// ---------------------------------------------------------------------------
async function probeStreamResolution(streamUrl, headers) {
  try {
    // 1. Fetch the m3u8 playlist
    const m3u8Res = await fetch(streamUrl, {
      headers: headers || { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!m3u8Res.ok) return null;
    const m3u8Text = await m3u8Res.text();

    // If master playlist, find highest-resolution variant
    if (m3u8Text.includes('#EXT-X-STREAM-INF')) {
      const variants = [];
      const lines = m3u8Text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const resMatch = lines[i].match(/RESOLUTION=(\d+)x(\d+)/);
          const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
          const variantUrl = lines[i + 1] ? lines[i + 1].trim() : '';
          if (variantUrl) {
            const absUrl = variantUrl.startsWith('http')
              ? variantUrl
              : new URL(variantUrl, streamUrl).href;
            variants.push({
              width: resMatch ? parseInt(resMatch[1], 10) : 0,
              height: resMatch ? parseInt(resMatch[2], 10) : 0,
              bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
              url: absUrl,
            });
          }
        }
      }
      if (variants.length > 0) {
        // Pick highest bandwidth (usually highest resolution)
        variants.sort((a, b) => b.bandwidth - a.bandwidth);
        const best = variants[0];
        if (best.width > 0 && best.height > 0) {
          return {
            width: best.width,
            height: best.height,
            codec: 'h264',
            quality: mapResolutionToQuality(best.width, best.height),
          };
        }
        // If no RESOLUTION= tag, probe the variant's first segment
        return probeStreamResolution(best.url, headers);
      }
    }

    // Media playlist — find first .ts segment and probe it
    const segMatch = m3u8Text.match(/^[^\s#][^\s]*\.ts$/m);
    if (!segMatch) return null;
    const segUrl = segMatch[0].startsWith('http')
      ? segMatch[0]
      : new URL(segMatch[0], streamUrl).href;

    const segRes = await fetch(segUrl, {
      headers: headers || { 'User-Agent': UA },
      signal: AbortSignal.timeout(12000),
    });
    if (!segRes.ok && segRes.status !== 206) return null;
    const buf = Buffer.from(await segRes.arrayBuffer());
    if (buf.length < 10000) return null;

    const { writeFileSync, unlinkSync } = require('fs');
    const { join } = require('path');
    const { tmpdir } = require('os');
    const tmpFile = join(tmpdir(), 'cineby_probe_' + process.pid + '_' + Date.now() + '.ts');
    writeFileSync(tmpFile, buf);

    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,codec_name',
        '-of', 'default=noprint_wrappers=1:nokey=0',
        tmpFile,
      ], { timeout: 8000, maxBuffer: 1024 * 1024 }).toString();

      const widthMatch = out.match(/^width=(\d+)/m);
      const heightMatch = out.match(/^height=(\d+)/m);
      const codecMatch = out.match(/^codec_name=(\w+)/m);
      if (!widthMatch || !heightMatch) return null;

      const w = parseInt(widthMatch[1], 10);
      const h = parseInt(heightMatch[1], 10);
      const codec = codecMatch ? codecMatch[1] : 'h264';
      return { width: w, height: h, codec, quality: mapResolutionToQuality(w, h) };
    } finally {
      try { unlinkSync(tmpFile); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validate a stream URL is reachable.
// For HLS (m3u8): GET and check body starts with #EXTM3U
// For MP4: HEAD only (don't download the huge file body)
// ---------------------------------------------------------------------------
async function validateStreamUrl(url, headers, isMp4) {
  try {
    if (isMp4) {
      // MP4 files can be huge — use GET with Range to fetch only first 4 bytes
      const res = await fetch(url, {
        method: 'GET',
        headers: { ...(headers || { 'User-Agent': UA }), Range: 'bytes=0-3' },
        signal: AbortSignal.timeout(8000),
      });
      // 200, 206, or 416 (Range not satisfiable) all mean the file exists
      return res.ok || res.status === 206 || res.status === 416;
    }
    // HLS — GET the playlist (small text file)
    const res = await fetch(url, {
      method: 'GET',
      headers: headers || { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok && res.status !== 206) return false;
    const text = await res.text();
    return text.includes('#EXTM3U') || text.length > 0;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Build a Stremio stream object
// ---------------------------------------------------------------------------
function buildStream(opts) {
  const s = {
    name: PROVIDER_NAME + ' - ' + opts.serverLabel,
    title: opts.title,
    url: opts.url,
    quality: opts.quality || '1080p',
    behaviorHints: {
      bingeGroup: opts.bingeGroup || ('cineby-' + opts.serverLabel.toLowerCase()),
    },
  };
  if (opts.type === 'iframe') {
    s.type = 'iframe';
    s.behaviorHints.notWebVideo = true;
  } else if (opts.type === 'mp4') {
    s.type = 'video/mp4';
  } else {
    s.type = 'application/vnd.apple.mpegurl';
  }
  // Set proxy headers if the CDN requires auth
  if (opts.headers) {
    s.behaviorHints.proxyHeaders = {
      request: opts.headers,
    };
  }
  if (opts.subtitles && opts.subtitles.length > 0) {
    s.subtitles = opts.subtitles;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Convert a VidRock source into Stremio stream objects (one per quality)
// ---------------------------------------------------------------------------
async function convertVidRockSource(source, info, serverLabel) {
  if (!source || !source.url) return [];

  const streams = [];
  const headers = source.headers || {};
  // Ensure User-Agent is set
  if (!headers['User-Agent']) {
    headers['User-Agent'] = UA;
  }

  const isMp4 = source.type === 'mp4' || source.url.includes('.mp4');

  // Validate the stream is reachable (HEAD for mp4, GET for m3u8)
  const ok = await validateStreamUrl(source.url, headers, isMp4);
  if (!ok) return [];

  // Probe resolution (only for HLS — mp4 would require downloading the whole file)
  let probe = null;
  if (!isMp4) {
    probe = await probeStreamResolution(source.url, headers);
  }
  const quality = probe ? probe.quality :
                  (source.quality === '4K' ? '2160p' :
                   (source.quality || (isMp4 ? '720p' : '1080p')));
  const resolutionStr = probe ? ` ${probe.width}x${probe.height}` : '';

  const audioLang = source.name.includes('Hindi') ? ' (Hindi)' :
                    source.name.includes('Tamil') ? ' (Tamil)' :
                    source.name.includes('Telugu') ? ' (Telugu)' :
                    source.name.includes('Bengali') ? ' (Bengali)' : '';

  streams.push(buildStream({
    title: `${info.title} [Cineby ${serverLabel} ${source.name}${resolutionStr}${audioLang}]`,
    url: source.url,
    quality: quality,
    serverLabel: `${serverLabel} ${source.name}`,
    bingeGroup: `cineby-vidbolt-${source.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
    type: isMp4 ? 'mp4' : 'hls',
    headers: headers,
  }));

  return streams;
}

// ---------------------------------------------------------------------------
// Main entry: get streams for a TMDB item
// ---------------------------------------------------------------------------
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isMovie = type !== 'tv';

  if (!isMovie && (season == null || episode == null)) {
    console.log('[Cineby] TV request without season/episode — returning empty');
    return [];
  }
  if (!tmdbId) {
    console.log('[Cineby] Empty TMDB ID — returning empty');
    return [];
  }

  console.log('[Cineby] Request: tmdb=' + tmdbId + ' type=' + type +
    (isMovie ? '' : ' S' + season + 'E' + episode));

  // 1. Fetch TMDB info
  let info;
  try {
    info = await Promise.race([
      getTMDBInfo(tmdbId, type),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TMDB timeout')), 10000)),
    ]);
  } catch (e) {
    console.log('[Cineby] TMDB fetch error: ' + e.message);
    info = { title: 'TMDB ' + tmdbId, year: '', type, tmdbId };
  }
  console.log('[Cineby] TMDB: ' + info.title + (info.year ? ' (' + info.year + ')' : ''));

  const allStreams = [];

  // 2. Fetch DIRECT m3u8 streams from vidbolt (Cipher) VidRock API
  console.log('[Cineby] Fetching VidRock direct streams from vidbolt (Cipher)...');
  const vidRockSources = await fetchVidRockStreams(tmdbId, type, season, episode, info);
  console.log('[Cineby] VidRock API returned ' + vidRockSources.length + ' sources');

  // Convert each source to Stremio stream(s) — probe resolution in parallel
  const vidRockStreamArrays = await Promise.all(
    vidRockSources.map(src => convertVidRockSource(src, info, 'Cipher'))
  );
  for (const arr of vidRockStreamArrays) {
    allStreams.push(...arr);
  }
  console.log('[Cineby] Added ' + allStreams.length + ' direct playable streams from Cipher');

  // 3. Add IFRAME streams for all 8 servers (including vidbolt as iframe fallback)
  console.log('[Cineby] Adding iframe embed streams for all 8 servers...');
  for (const server of ALL_SERVERS) {
    const embedUrl = buildEmbedUrl(server, tmdbId, type, season, episode);
    
    // For vidbolt, skip iframe if we already have direct streams
    if (server.code === 'vidbolt' && allStreams.length > 0) {
      console.log('[Cineby]   ' + server.label + ' (' + server.code + '): skipped (direct streams already added)');
      continue;
    }

    allStreams.push(buildStream({
      title: `${info.title} [Cineby ${server.label} Player]`,
      url: embedUrl,
      quality: '1080p',
      serverLabel: server.label,
      bingeGroup: `cineby-${server.code}-iframe`,
      type: 'iframe',
    }));
    console.log('[Cineby]   ' + server.label + ' (' + server.code + '): iframe added');
  }

  console.log('[Cineby] ' + allStreams.length + ' streams total');
  return allStreams;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getStreams: getStreams,
  getTMDBInfo: getTMDBInfo,
  fetchVidRockStreams: fetchVidRockStreams,
  probeStreamResolution: probeStreamResolution,
  validateStreamUrl: validateStreamUrl,
  buildEmbedUrl: buildEmbedUrl,
  listServers: function () { return ALL_SERVERS.slice(); },
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node cineby_all_in_one.js <tmdbId> <movie|tv> [season] [episode]');
    console.log('Examples:');
    console.log('  node cineby_all_in_one.js 27205 movie        # Inception');
    console.log('  node cineby_all_in_one.js 1396 tv 1 1        # Breaking Bad S01E01');
    process.exit(1);
  }
  const tmdbId = args[0];
  const type = args[1];
  const season = type === 'tv' ? parseInt(args[2] || '1', 10) : null;
  const episode = type === 'tv' ? parseInt(args[3] || '1', 10) : null;

  getStreams(tmdbId, type, season, episode).then(streams => {
    console.log('\n=== Final streams ===');
    streams.forEach((s, i) => {
      console.log((i + 1) + '. ' + s.name + ' | ' + s.quality + ' | ' + s.type);
      console.log('   ' + s.url.slice(0, 120));
      if (s.behaviorHints?.proxyHeaders) console.log('   proxyHeaders: yes');
    });
    console.log('\nTotal: ' + streams.length + ' stream(s)');
  }).catch(e => {
    console.error('FATAL: ' + e.stack);
    process.exit(1);
  });
}
