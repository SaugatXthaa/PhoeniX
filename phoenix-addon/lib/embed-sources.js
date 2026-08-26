/**
 * lib/embed-sources.js — Direct-embed HTTPS sources
 *
 * Sources that return playable streams via simple API/embed scraping:
 *   - zstream.mov       — embeds via TMDB ID
 *   - zxcstream.icu     — multi-embed aggregator
 *   - vixsrc.to         — HLS playlists (used by webstreamr)
 *   - vidsrc            — direct mp4 embeds
 *   - soap2night.cc     — soaper-style (movies/series)
 *   - lookmovie2.to     — lookmovie (in @movie-web/providers)
 *   - showbox.media     — showbox (in @movie-web/providers)
 *   - miruro.to         — anime
 *   - anitaku.io        — anime (gogoanime-like)
 *   - aniworld.to       — German anime
 *
 * For sources already in @movie-web/providers (showbox, lookmovie, gogoanime),
 * the providers.js wrapper handles them. Here we add custom ones.
 */

const axios = require('axios');
const https = require('https');
const { fetchHtml, fetchJson } = require('./fetcher');
const { getTmdbFromImdb } = require('./meta');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ---- ZSTREAM.MOV ----
// Reverse-engineered from webstreamr sources: uses TMDB key 84259f99204eeb7d45c7e3d8e36c6123
async function getZStreamStreams(imdbId, type, season, episode) {
  const tmdbId = await getTmdbFromImdb(imdbId, type);
  if (!tmdbId) return [];

  try {
    const url = type === 'series'
      ? `https://zstream.mov/api/stream?tmdb=${tmdbId}&s=${season}&e=${episode}`
      : `https://zstream.mov/api/stream?tmdb=${tmdbId}`;
    const data = await fetchJson(url, { timeout: 8000 });
    if (!data?.streams) return [];
    return data.streams.map(s => ({
      name: `PhoeniX\n${s.quality || 'auto'}`,
      title: `ZStream ${s.quality || ''} (${s.server || 'main'})`,
      url: s.url,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: `phoenix-zstream-${s.quality || 'auto'}`,
        ...(s.headers && { proxyHeaders: { request: s.headers } })
      }
    }));
  } catch (e) { return []; }
}

// ---- ZXCSTREAM.ICU ----
// Aggregator with multiple embed providers
async function getZXcStreamStreams(imdbId, type, season, episode) {
  const tmdbId = await getTmdbFromImdb(imdbId, type);
  if (!tmdbId) return [];

  const providers = ['vidsrc', 'vidsrcto', 'embedsu', 'multiembed', '2embed'];
  const streams = [];

  for (const p of providers) {
    try {
      let url;
      if (type === 'series') {
        url = `https://zxcstream.icu/api/embed?provider=${p}&tmdb=${tmdbId}&s=${season}&e=${episode}`;
      } else {
        url = `https://zxcstream.icu/api/embed?provider=${p}&tmdb=${tmdbId}`;
      }
      const data = await fetchJson(url, { timeout: 6000 });
      if (data?.url) {
        // Many of these return HLS or mp4 directly
        streams.push({
          name: `PhoeniX\n${data.quality || 'auto'}`,
          title: `ZXCStream (${p})`,
          url: data.url,
          behaviorHints: {
            notWebReady: true,
            bingeGroup: `phoenix-zxcstream-${p}`,
            ...(data.headers && { proxyHeaders: { request: data.headers } })
          }
        });
      }
    } catch (e) { /* skip */ }
  }

  return streams;
}

// ---- VIXSRC.TO ----
// Pattern from webstreamr's VixSrc extractor
async function getVixSrcStreams(imdbId, type, season, episode) {
  const tmdbId = await getTmdbFromImdb(imdbId, type);
  if (!tmdbId) return [];

  try {
    let url;
    if (type === 'series') {
      url = `https://vixsrc.to/tv/${tmdbId}/${season}/${episode}`;
    } else {
      url = `https://vixsrc.to/movie/${tmdbId}`;
    }
    const html = await fetchHtml(url, { timeout: 8000 });
    const tokenMatch = html.match(/['"]token['"]:\s*['"]([^'"]+)['"]/);
    const expiresMatch = html.match(/['"]expires['"]:\s*['"]([^'"]+)['"]/);
    const urlMatch = html.match(/url:\s*['"]([^'"]+)['"]/);
    if (!tokenMatch || !expiresMatch || !urlMatch) return [];

    const baseUrl = new URL(urlMatch[1]);
    const playlistUrl = new URL(`${baseUrl.origin}${baseUrl.pathname}.m3u8?${baseUrl.searchParams}`);
    playlistUrl.searchParams.append('token', tokenMatch[1]);
    playlistUrl.searchParams.append('expires', expiresMatch[1]);
    playlistUrl.searchParams.append('h', '1');

    return [{
      name: 'PhoeniX\nHLS',
      title: `VixSrc (HLS)`,
      url: playlistUrl.toString(),
      behaviorHints: {
        notWebReady: true,
        bingeGroup: 'phoenix-vixsrc',
        proxyHeaders: { request: { Referer: url } }
      }
    }];
  } catch (e) { return []; }
}

// ---- VIDSRC ----
// Simple embed URL — vidsrc streams directly without extraction
async function getVidSrcStreams(imdbId, type, season, episode) {
  const streams = [];
  const variants = [
    { label: 'VidSrc', url: type === 'series'
        ? `https://vidsrc.to/embed/tv/${imdbId}/${season}/${episode}`
        : `https://vidsrc.to/embed/movie/${imdbId}` },
    { label: 'VidSrc.xyz', url: type === 'series'
        ? `https://vidsrc.xyz/embed/tv/${imdbId}/${season}/${episode}`
        : `https://vidsrc.xyz/embed/movie/${imdbId}` },
    { label: 'VidSrc.me', url: type === 'series'
        ? `https://vidsrc.me/embed/tv?imdb=${imdbId}&season=${season}&episode=${episode}`
        : `https://vidsrc.me/embed/movie?imdb=${imdbId}` }
  ];
  // These are iframe embeds — return as externalUrl
  for (const v of variants) {
    streams.push({
      name: `PhoeniX\nEmbed`,
      title: `${v.label} (embed)`,
      externalUrl: v.url,
      behaviorHints: { bingeGroup: `phoenix-vidsrc-${v.label}` }
    });
  }
  return streams;
}

// ---- SOAP2NIGHT.CC (soapertv-style) ----
async function getSoap2NightStreams(imdbId, type, season, episode) {
  const tmdbId = await getTmdbFromImdb(imdbId, type);
  if (!tmdbId) return [];
  try {
    // soap2night typically has /movie/<id>-title or /tv/<id>-title/season-N/episode-N
    // Try common URL patterns
    const url = type === 'series'
      ? `https://soap2night.cc/tv/${tmdbId}-${season}-${episode}`
      : `https://soap2night.cc/movie/${tmdbId}`;
    const html = await fetchHtml(url, { timeout: 8000 });
    // Extract direct video URLs from the player JS
    const videoUrlMatches = html.match(/https:\/\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*/gi) || [];
    const seen = new Set();
    return videoUrlMatches.filter(u => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    }).slice(0, 5).map(u => ({
      name: `PhoeniX\n${u.endsWith('.m3u8') ? 'HLS' : 'auto'}`,
      title: `Soap2Night`,
      url: u,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: 'phoenix-soap2night',
        proxyHeaders: { request: { Referer: 'https://soap2night.cc/' } }
      }
    }));
  } catch (e) { return []; }
}

// ---- LOOKMOVIE2.TO ----
async function getLookmovieStreams(imdbId, type, season, episode) {
  const tmdbId = await getTmdbFromImdb(imdbId, type);
  if (!tmdbId) return [];
  try {
    // lookmovie2 has an API endpoint that returns m3u8 streams
    const url = type === 'series'
      ? `https://lookmovie2.to/api/v1/security/episode-access?id_tmdb=${tmdbId}&s=${season}&e=${episode}`
      : `https://lookmovie2.to/api/v1/security/movie-access?id_tmdb=${tmdbId}`;
    const data = await fetchJson(url, { timeout: 8000 });
    if (!data?.data?.access_token) return [];
    // Construct HLS URL
    const accessToken = data.data.access_token;
    const streamUrl = type === 'series'
      ? `https://lookmovie2.to/manifests/episodes/${accessToken}/master.m3u8`
      : `https://lookmovie2.to/manifests/movies/${accessToken}/master.m3u8`;
    return [{
      name: 'PhoeniX\nHLS',
      title: `Lookmovie2`,
      url: streamUrl,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: 'phoenix-lookmovie2',
        proxyHeaders: { request: { Referer: 'https://lookmovie2.to/' } }
      }
    }];
  } catch (e) { return []; }
}

// ---- MIRURO.TO (anime) ----
async function getMiruroStreams(imdbId, type, season, episode) {
  // miruro is anime-only — skip if not series
  if (type !== 'series') return [];
  try {
    const { getMeta } = require('./meta');
    const meta = await getMeta(imdbId, type);
    if (!meta?.name) return [];
    const searchUrl = `https://miruro.to/api/anime/search?q=${encodeURIComponent(meta.name)}`;
    const data = await fetchJson(searchUrl, { timeout: 8000 });
    if (!data?.results?.length) return [];
    const first = data.results[0];
    const streamUrl = `https://miruro.to/api/anime/episode?id=${first.id}&episode=${episode || 1}`;
    return [{
      name: 'PhoeniX\nHLS',
      title: `Miruro (anime)`,
      url: streamUrl,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: 'phoenix-miruro',
        proxyHeaders: { request: { Referer: 'https://miruro.to/' } }
      }
    }];
  } catch (e) { return []; }
}

// ---- ANIWORLD.TO (German anime) ----
async function getAniworldStreams(imdbId, type, season, episode) {
  if (type !== 'series') return [];
  try {
    const { getMeta } = require('./meta');
    const meta = await getMeta(imdbId, type);
    if (!meta?.name) return [];
    // Aniworld URL pattern: /serie/stream/<slug>/staffel-N/episode-N
    const slug = meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const url = `https://aniworld.to/serie/stream/${slug}/staffel-${season || 1}/episode-${episode || 1}`;
    const html = await fetchHtml(url, { timeout: 8000 });
    // Aniworld uses redirect links via /redirect/<token>
    const redirectMatches = html.match(/href="(\/redirect\/[^"]+)"/g) || [];
    const streams = [];
    for (const m of redirectMatches.slice(0, 4)) {
      const redirectPath = m.match(/href="([^"]+)"/)[1];
      const redirectUrl = `https://aniworld.to${redirectPath}`;
      // Follow redirect to get direct stream URL
      try {
        const r = await axios.head(redirectUrl, {
          httpsAgent, maxRedirects: 5, timeout: 5000,
          validateStatus: () => true
        });
        const finalUrl = r.request?.res?.responseUrl || r.request?._redirectable?._currentUrl;
        if (finalUrl) {
          streams.push({
            name: 'PhoeniX\nauto',
            title: `Aniworld (German)`,
            url: finalUrl,
            behaviorHints: {
              notWebReady: true,
              bingeGroup: 'phoenix-aniworld',
              proxyHeaders: { request: { Referer: 'https://aniworld.to/' } }
            }
          });
        }
      } catch (e) { /* skip */ }
    }
    return streams;
  } catch (e) { return []; }
}

module.exports = {
  getZStreamStreams,
  getZXcStreamStreams,
  getVixSrcStreams,
  getVidSrcStreams,
  getSoap2NightStreams,
  getLookmovieStreams,
  getMiruroStreams,
  getAniworldStreams
};
