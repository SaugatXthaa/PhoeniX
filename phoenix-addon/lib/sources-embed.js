/**
 * lib/sources-embed.js — Direct embed source modules
 *
 * VixSrc: Ported from sootio-stremio-addon/lib/http-streams/providers/vixsrc/streams.js
 * VidSrc: Direct iframe embeds
 * HubCloud: Direct hubcloud.in|one page extractor (no DDL blog wrapper)
 *
 * These sources return stream objects directly (no need for extractors.js).
 */

const axios = require('axios');
const https = require('https');
const { extractHubcloud } = require('./extractors');
const { getTmdbFromImdb, getMeta } = require('./meta');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ============================================
// VIXSRC — vixsrc.to
// Pattern: /movie/<tmdbId> or /tv/<tmdbId>/<season>/<episode>
//          Page contains token/expires/url in JS → build m3u8 URL
// Source: sootio-stremio-addon/lib/http-streams/providers/vixsrc/streams.js
// ============================================
async function getVixSrcStreams(imdbId, type, season, episode) {
  const tmdbId = await getTmdbFromImdb(imdbId, type);
  if (!tmdbId) return [];

  try {
    const pageUrl = type === 'series'
      ? `https://vixsrc.to/tv/${tmdbId}/${season || 1}/${episode || 1}`
      : `https://vixsrc.to/movie/${tmdbId}`;

    const r = await axios.get(pageUrl, {
      httpsAgent,
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'User-Agent': DEFAULT_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (r.status !== 200) return [];

    // Look for token/expires/url in JS
    const tokenMatch = r.data.match(/['"]token['"]\s*:\s*['"](.*?)['"]/i);
    const expiresMatch = r.data.match(/['"]expires['"]\s*:\s*['"](.*?)['"]/i);
    const urlMatch = r.data.match(/url:\s*['"](.*?)['"]/i);

    if (!tokenMatch || !expiresMatch || !urlMatch) return [];

    const baseUrl = new URL(urlMatch[1]);
    const playlistUrl = new URL(`${baseUrl.origin}${baseUrl.pathname}.m3u8${baseUrl.search}`);
    playlistUrl.searchParams.set('token', tokenMatch[1]);
    playlistUrl.searchParams.set('expires', expiresMatch[1]);
    playlistUrl.searchParams.set('h', '1');

    // Parse height and languages from playlist (best-effort, optional)
    let height = null;
    try {
      const plR = await axios.get(playlistUrl.toString(), {
        httpsAgent, timeout: 8000, validateStatus: () => true,
        headers: { 'User-Agent': DEFAULT_UA, Referer: pageUrl }
      });
      if (plR.status === 200) {
        const hm = plR.data.match(/RESOLUTION=\d+x(\d+)/i);
        if (hm) height = parseInt(hm[1], 10);
      }
    } catch {}

    // Extract title from page
    const titleMatch = r.data.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/\s*\|\s*vixsrc[^|]*$/i, '').trim()
      : `VixSrc ${tmdbId}`;

    return [{
      name: `PhoeniX\n${height ? height + 'p' : 'HLS'}`,
      title: `${title}\n🔗 VixSrc${height ? ` ${height}p` : ''}`,
      url: playlistUrl.toString(),
      behaviorHints: {
        notWebReady: true,
        bingeGroup: 'phoenix-vixsrc',
        proxyHeaders: { request: { Referer: pageUrl } }
      }
    }];
  } catch (e) { return []; }
}

// ============================================
// VIDSRC — vidsrc.to / vidsrc.xyz / vidsrc.me
// Pattern: Direct iframe embed URLs (returned as externalUrl for Stremio to handle)
// Stremio/Nuvio's player will open the iframe in a webview to extract the stream
// ============================================
async function getVidSrcStreams(imdbId, type, season, episode) {
  const streams = [];
  const variants = [
    {
      label: 'VidSrc.to',
      url: type === 'series'
        ? `https://vidsrc.to/embed/tv/${imdbId}/${season}/${episode}`
        : `https://vidsrc.to/embed/movie/${imdbId}`
    },
    {
      label: 'VidSrc.xyz',
      url: type === 'series'
        ? `https://vidsrc.xyz/embed/tv/${imdbId}/${season}/${episode}`
        : `https://vidsrc.xyz/embed/movie/${imdbId}`
    },
    {
      label: 'VidSrc.me',
      url: type === 'series'
        ? `https://vidsrc.me/embed/tv?imdb=${imdbId}&season=${season}&episode=${episode}`
        : `https://vidsrc.me/embed/movie?imdb=${imdbId}`
    }
  ];
  for (const v of variants) {
    streams.push({
      name: 'PhoeniX\nEmbed',
      title: `${v.label} (iframe)`,
      externalUrl: v.url,
      behaviorHints: { bingeGroup: `phoenix-vidsrc-${v.label.toLowerCase().replace(/\W+/g, '-')}` }
    });
  }
  return streams;
}

// ============================================
// VIDSRC PROPER (CloudStream Pro server)
// Pattern: parse iframe + CloudStream Pro server data-hash → m3u8
// Source: webstreamr/src/extractor/VidSrc.ts (ported to extractors.js)
// ============================================
async function getVidSrcDirectStreams(imdbId, type, season, episode) {
  // Try vidsrc.me with the extractor
  const embedUrl = type === 'series'
    ? `https://vidsrc.me/embed/tv?imdb=${imdbId}&season=${season}&episode=${episode}`
    : `https://vidsrc.me/embed/movie?imdb=${imdbId}`;

  const { extractVidsrc } = require('./extractors');
  const extracted = await extractVidsrc(embedUrl, {});
  return extracted.map(ext => ({
    name: `PhoeniX\n${ext.height || 'HLS'}`,
    title: `${ext.title || 'VidSrc (CloudStream)'}\n🔗 VidSrc`,
    url: ext.url,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: 'phoenix-vidsrc-cloudstream',
      ...(ext.requestHeaders && { proxyHeaders: { request: ext.requestHeaders } })
    }
  }));
}

// ============================================
// HUBCLOUD DIRECT — given a direct hubcloud URL, extract streams
// (Used as fallback when sources return hubcloud URLs directly)
// ============================================
async function getHubcloudDirectStreams(hubcloudUrl, referer = null) {
  const extracted = await extractHubcloud(hubcloudUrl, referer);
  return extracted.map(ext => ({
    name: `PhoeniX\n${ext.height || 'auto'}`,
    title: `${ext.title || ''}\n🔗 ${ext.label}`.trim(),
    url: ext.url,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: `phoenix-hubcloud-${ext.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      ...(ext.sizeBytes && { videoSize: ext.sizeBytes }),
      ...(ext.requestHeaders && Object.keys(ext.requestHeaders).length > 0 && {
        proxyHeaders: { request: ext.requestHeaders }
      })
    }
  }));
}

// ============================================
// SOAP2NIGHT — soap2night.cc
// Pattern: Try direct URL patterns, look for mp4/m3u8 in page
// ============================================
async function getSoap2NightStreams(imdbId, type, season, episode) {
  const tmdbId = await getTmdbFromImdb(imdbId, type);
  if (!tmdbId) return [];
  try {
    const url = type === 'series'
      ? `https://soap2night.cc/tv/${tmdbId}-${season}-${episode}`
      : `https://soap2night.cc/movie/${tmdbId}`;
    const r = await axios.get(url, {
      httpsAgent, timeout: 8000, validateStatus: () => true,
      headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://soap2night.cc/' }
    });
    if (r.status !== 200) return [];

    const videoUrlMatches = r.data.match(/https:\/\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*/gi) || [];
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

// ============================================
// LOOKMOVIE2 — lookmovie2.to
// Pattern: API endpoint returns access_token, build HLS URL
// ============================================
async function getLookmovieStreams(imdbId, type, season, episode) {
  const tmdbId = await getTmdbFromImdb(imdbId, type);
  if (!tmdbId) return [];
  try {
    const url = type === 'series'
      ? `https://lookmovie2.to/api/v1/security/episode-access?id_tmdb=${tmdbId}&s=${season}&e=${episode}`
      : `https://lookmovie2.to/api/v1/security/movie-access?id_tmdb=${tmdbId}`;
    const r = await axios.get(url, {
      httpsAgent, timeout: 8000, validateStatus: () => true,
      headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://lookmovie2.to/' }
    });
    if (r.status !== 200) return [];
    const json = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    if (!json?.data?.access_token) return [];

    const accessToken = json.data.access_token;
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

// ============================================
// MIRURO — miruro.to (anime-only, series only)
// Pattern: Search API for anime by name, get episode stream URL
// ============================================
async function getMiruroStreams(imdbId, type, season, episode) {
  if (type !== 'series') return [];
  const meta = await getMeta(imdbId, type);
  if (!meta?.name) return [];
  try {
    const searchUrl = `https://miruro.to/api/anime/search?q=${encodeURIComponent(meta.name)}`;
    const r = await axios.get(searchUrl, {
      httpsAgent, timeout: 8000, validateStatus: () => true,
      headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://miruro.to/' }
    });
    if (r.status !== 200) return [];
    const json = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    if (!json?.results?.length) return [];
    const first = json.results[0];
    const streamUrl = `https://miruro.to/api/anime/episode?id=${first.id}&episode=${episode || 1}`;
    return [{
      name: 'PhoeniX\nHLS',
      title: `Miruro (anime) — ${first.title || meta.name}`,
      url: streamUrl,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: 'phoenix-miruro',
        proxyHeaders: { request: { Referer: 'https://miruro.to/' } }
      }
    }];
  } catch (e) { return []; }
}

// ============================================
// ANIWORLD — aniworld.to (German anime, series only)
// Pattern: /serie/stream/<slug>/staffel-N/episode-N → /redirect/<token> → direct URL
// ============================================
async function getAniworldStreams(imdbId, type, season, episode) {
  if (type !== 'series') return [];
  const meta = await getMeta(imdbId, type);
  if (!meta?.name) return [];
  try {
    const slug = meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const url = `https://aniworld.to/serie/stream/${slug}/staffel-${season || 1}/episode-${episode || 1}`;
    const r = await axios.get(url, {
      httpsAgent, timeout: 8000, validateStatus: () => true,
      headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://aniworld.to/' }
    });
    if (r.status !== 200) return [];

    const redirectMatches = r.data.match(/href="(\/redirect\/[^"]+)"/g) || [];
    const streams = [];
    for (const m of redirectMatches.slice(0, 4)) {
      const redirectPath = m.match(/href="([^"]+)"/)[1];
      const redirectUrl = `https://aniworld.to${redirectPath}`;
      try {
        const headR = await axios.head(redirectUrl, {
          httpsAgent, maxRedirects: 5, timeout: 5000,
          validateStatus: () => true,
          headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://aniworld.to/' }
        });
        const finalUrl = headR.request?.res?.responseUrl ||
                         headR.request?._redirectable?._currentUrl;
        if (finalUrl && !finalUrl.includes('aniworld.to')) {
          streams.push({
            name: 'PhoeniX\nauto',
            title: `Aniworld (German) — ${meta.name} S${season}E${episode}`,
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

// ============================================
// ANITAKU / GOGOANIME — anitaku.io / gogoanime3.co
// Pattern: Search by name → episode page → extract direct stream from iframe
// ============================================
async function getAnitakuStreams(imdbId, type, season, episode) {
  if (type !== 'series') return [];
  const meta = await getMeta(imdbId, type);
  if (!meta?.name) return [];
  try {
    // Search on gogoanime
    const searchUrl = `https://gogoanime3.co/search.html?keyword=${encodeURIComponent(meta.name)}`;
    const r = await axios.get(searchUrl, {
      httpsAgent, timeout: 8000, validateStatus: () => true,
      headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://gogoanime3.co/' }
    });
    if (r.status !== 200) return [];

    const cheerio = require('cheerio');
    const $ = cheerio.load(r.data);
    const firstLink = $('.last_episodes ul li a, .items li a, .name a').first().attr('href');
    if (!firstLink) return [];

    // Build episode URL: /category/<slug> → /<slug>-episode-N
    const categoryUrl = `https://gogoanime3.co${firstLink}`;
    const epUrl = categoryUrl.replace('/category/', '/') + `-episode-${episode || 1}`;
    const epR = await axios.get(epUrl, {
      httpsAgent, timeout: 8000, validateStatus: () => true,
      headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://gogoanime3.co/' }
    });
    if (epR.status !== 200) return [];

    // Look for iframe with streaming URL
    const $ep = cheerio.load(epR.data);
    const iframeSrc = $ep('iframe[data-video], iframe[src*="stream"], iframe[src*="play"]').first().attr('src') ||
                      $ep('iframe').first().attr('src');
    if (!iframeSrc) return [];

    const streamUrl = iframeSrc.startsWith('//') ? 'https:' + iframeSrc : iframeSrc;
    return [{
      name: 'PhoeniX\nEmbed',
      title: `Anitaku/Gogoanime — ${meta.name} S${season}E${episode}`,
      externalUrl: streamUrl,
      behaviorHints: { bingeGroup: 'phoenix-anitaku' }
    }];
  } catch (e) { return []; }
}

module.exports = {
  getVixSrcStreams, getVidSrcStreams, getVidSrcDirectStreams,
  getHubcloudDirectStreams, getSoap2NightStreams, getLookmovieStreams,
  getMiruroStreams, getAniworldStreams, getAnitakuStreams
};
