/**
 * lib/sources-webstreamr.js — Direct ports of webstreamr source classes
 *
 * Each source returns embed/locker URLs (e.g. VOE, Streamtape, HubCloud).
 * Those URLs are then passed to extractors.js to extract the actual stream URL.
 *
 * Returns: [{ url, meta: { countryCodes, referer, title } }]
 */

const cheerio = require('cheerio');
const axios = require('axios');
const https = require('https');
const { getTmdbFromImdb, getMeta } = require('./meta');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HTTP_TIMEOUT = 10000;

async function httpGet(url, referer = null) {
  return axios.get(url, {
    httpsAgent,
    timeout: HTTP_TIMEOUT,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { 'User-Agent': DEFAULT_UA, ...(referer && { Referer: referer }) }
  });
}

async function httpPost(url, body, referer = null) {
  return axios.post(url, body, {
    httpsAgent,
    timeout: HTTP_TIMEOUT,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      'User-Agent': DEFAULT_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(referer && { Referer: referer })
    }
  });
}

// Helper: get TMDB ID + name + year + original name
async function getTmdbMeta(imdbId, type, language = null) {
  const tmdbId = await getTmdbFromImdb(imdbId, type);
  const meta = await getMeta(imdbId, type);
  if (!tmdbId || !meta) return { tmdbId: null, meta };
  return { tmdbId, meta };
}

// ============================================
// FRENCHCLOUD — frenchcloud.cam
// Pattern: /movie/<imdbId> page contains [data-link="..."] attributes
// Source: webstreamr/src/source/FrenchCloud.ts
// Returns raw embed URLs (VOE, Streamtape, etc.) — extract via extractors
// ============================================
async function getFrenchCloudStreams(imdbId, type, season, episode) {
  if (type !== 'movie') return [];  // FrenchCloud is movies-only per webstreamr
  try {
    const pageUrl = `https://frenchcloud.cam/movie/${imdbId}`;
    const r = await httpGet(pageUrl);
    if (r.status !== 200) return [];

    const $ = cheerio.load(r.data);
    const embedUrls = [];
    $('[data-link!=""]').each((_, el) => {
      const link = $(el).attr('data-link');
      if (!link) return;
      const url = link.replace(/^(https:)?\/\//, 'https://');
      try {
        const u = new URL(url);
        if (u.host.match(/frenchcloud/)) return;
        embedUrls.push(u.toString());
      } catch {}
    });

    // Extract direct streams from each embed URL
    const { extractAny } = require('./extractors');
    const allStreams = [];
    for (const url of embedUrls.slice(0, 5)) {
      try {
        const extracted = await extractAny(url, { referer: pageUrl });
        for (const ext of extracted) {
          allStreams.push({
            name: `PhoeniX\n${ext.height || 'auto'}`,
            title: `FrenchCloud (${ext.label})`,
            url: ext.url,
            behaviorHints: {
              notWebReady: true,
              bingeGroup: `phoenix-frenchcloud-${ext.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              ...(ext.sizeBytes && { videoSize: ext.sizeBytes }),
              ...(ext.requestHeaders && Object.keys(ext.requestHeaders).length > 0 && {
                proxyHeaders: { request: ext.requestHeaders }
              })
            }
          });
        }
      } catch (e) { /* skip */ }
    }
    return allStreams;
  } catch (e) { return []; }
}

// ============================================
// MOSTRAGUARDA — mostraguarda.stream
// Pattern: /movie/<imdbId> page contains [data-link] attributes
// Source: webstreamr/src/source/MostraGuarda.ts
// Returns raw embed URLs — extract via extractors
// ============================================
async function getMostraGuardaStreams(imdbId, type, season, episode) {
  if (type !== 'movie') return [];
  try {
    const pageUrl = `https://mostraguarda.stream/movie/${imdbId}`;
    const r = await httpGet(pageUrl);
    if (r.status !== 200) return [];

    const $ = cheerio.load(r.data);
    const embedUrls = [];
    $('[data-link!=""]').each((_, el) => {
      const link = $(el).attr('data-link');
      if (!link) return;
      const url = link.replace(/^(https:)?\/\//, 'https://');
      try {
        const u = new URL(url);
        if (u.host.match(/mostraguarda/)) return;
        embedUrls.push(u.toString());
      } catch {}
    });

    const { extractAny } = require('./extractors');
    const allStreams = [];
    for (const url of embedUrls.slice(0, 5)) {
      try {
        const extracted = await extractAny(url, { referer: pageUrl });
        for (const ext of extracted) {
          allStreams.push({
            name: `PhoeniX\n${ext.height || 'auto'}`,
            title: `MostraGuarda (${ext.label})`,
            url: ext.url,
            behaviorHints: {
              notWebReady: true,
              bingeGroup: `phoenix-mostraguarda-${ext.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              ...(ext.sizeBytes && { videoSize: ext.sizeBytes }),
              ...(ext.requestHeaders && Object.keys(ext.requestHeaders).length > 0 && {
                proxyHeaders: { request: ext.requestHeaders }
              })
            }
          });
        }
      } catch (e) { /* skip */ }
    }
    return allStreams;
  } catch (e) { return []; }
}

// ============================================
// MEINECLOUD — meinecloud.click
// Pattern: /movie/<imdbId> page contains [data-link] attributes
// Source: webstreamr/src/source/MeineCloud.ts
// Returns raw embed URLs — extract via extractors
// ============================================
async function getMeineCloudStreams(imdbId, type, season, episode) {
  if (type !== 'movie') return [];
  try {
    const pageUrl = `https://meinecloud.click/movie/${imdbId}`;
    const r = await httpGet(pageUrl);
    if (r.status !== 200) return [];

    const $ = cheerio.load(r.data);
    const embedUrls = [];
    $('[data-link!=""]').each((_, el) => {
      const link = $(el).attr('data-link');
      if (!link) return;
      const url = link.replace(/^(https:)?\/\//, 'https://');
      try {
        const u = new URL(url);
        if (u.host.match(/meinecloud/)) return;
        embedUrls.push(u.toString());
      } catch {}
    });

    const { extractAny } = require('./extractors');
    const allStreams = [];
    for (const url of embedUrls.slice(0, 5)) {
      try {
        const extracted = await extractAny(url, { referer: pageUrl });
        for (const ext of extracted) {
          allStreams.push({
            name: `PhoeniX\n${ext.height || 'auto'}`,
            title: `MeineCloud (${ext.label})`,
            url: ext.url,
            behaviorHints: {
              notWebReady: true,
              bingeGroup: `phoenix-meinecloud-${ext.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              ...(ext.sizeBytes && { videoSize: ext.sizeBytes }),
              ...(ext.requestHeaders && Object.keys(ext.requestHeaders).length > 0 && {
                proxyHeaders: { request: ext.requestHeaders }
              })
            }
          });
        }
      } catch (e) { /* skip */ }
    }
    return allStreams;
  } catch (e) { return []; }
}

// ============================================
// MOVIX — api.movix.site
// Pattern: TMDB-based API returning player_links[].decoded_url
// Source: webstreamr/src/source/Movix.ts
// Returns raw embed URLs — extract via extractors
// ============================================
async function getMovixStreams(imdbId, type, season, episode) {
  const { tmdbId, meta } = await getTmdbMeta(imdbId, type);
  if (!tmdbId) return [];
  try {
    const apiUrl = type === 'series'
      ? `https://api.movix.site/api/tmdb/tv/${tmdbId}?season=${season}&episode=${episode}`
      : `https://api.movix.site/api/tmdb/movie/${tmdbId}`;

    const r = await httpGet(apiUrl);
    if (r.status !== 200) return [];

    const json = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const data = type === 'series' ? json.current_episode : json;
    if (!data?.player_links) return [];

    const title = type === 'series'
      ? `${json.tmdb_details?.title || meta?.name || ''} S${season}E${episode}`
      : `${json.tmdb_details?.title || meta?.name || ''} (${meta?.year || ''})`.trim();

    const embedUrls = data.player_links
      .filter(p => p.decoded_url)
      .map(p => p.decoded_url);

    const { extractAny } = require('./extractors');
    const allStreams = [];
    for (const url of embedUrls.slice(0, 5)) {
      try {
        const extracted = await extractAny(url, { referer: data.iframe_src || apiUrl });
        for (const ext of extracted) {
          allStreams.push({
            name: `PhoeniX\n${ext.height || 'auto'}`,
            title: `${title}\n🔗 Movix (${ext.label})`,
            url: ext.url,
            behaviorHints: {
              notWebReady: true,
              bingeGroup: `phoenix-movix-${ext.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              ...(ext.sizeBytes && { videoSize: ext.sizeBytes }),
              ...(ext.requestHeaders && Object.keys(ext.requestHeaders).length > 0 && {
                proxyHeaders: { request: ext.requestHeaders }
              })
            }
          });
        }
      } catch (e) { /* skip */ }
    }
    return allStreams;
  } catch (e) { return []; }
}

// ============================================
// FREMBED — frembed.work
// Pattern: TMDB-based API returning linkN keys with redirect URLs
// Source: webstreamr/src/source/Frembed.ts
// Returns raw embed URLs (VOE, Streamtape, etc.) — needs extraction
// ============================================
async function getFrembedStreams(imdbId, type, season, episode) {
  const { tmdbId, meta } = await getTmdbMeta(imdbId, type);
  if (!tmdbId) return [];
  try {
    // frembed might redirect from frembed.work → another base URL
    const baseResp = await httpGet('https://frembed.work');
    const baseUrl = baseResp.request?.res?.responseUrl || baseResp.request?._redirectable?._currentUrl || 'https://frembed.work';
    const baseOrigin = new URL(baseUrl).origin;

    const apiUrl = type === 'series'
      ? `${baseOrigin}/api/series?id=${tmdbId}&sa=${season}&epi=${episode}&idType=tmdb`
      : `${baseOrigin}/api/films?id=${tmdbId}&idType=tmdb`;

    const r = await httpGet(apiUrl, baseOrigin);
    if (r.status !== 200) return [];

    const json = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const urls = [];
    for (const key in json) {
      if (key.startsWith('link') && json[key] && !String(json[key]).includes(',https')) {
        try {
          const link = json[key].trim();
          const fullUrl = link.startsWith('http') ? link : new URL(link, baseOrigin).toString();
          // Follow redirect to get final URL
          const headR = await axios.head(fullUrl, {
            httpsAgent,
            maxRedirects: 5,
            timeout: 8000,
            validateStatus: () => true,
            headers: { 'User-Agent': DEFAULT_UA, Referer: baseOrigin + '/' }
          });
          const finalUrl = headR.request?.res?.responseUrl || headR.request?._redirectable?._currentUrl || fullUrl;
          urls.push(finalUrl);
        } catch {}
      }
    }

    const title = type === 'series'
      ? `${json.title || meta?.name || ''} S${season}E${episode}`
      : `${json.title || meta?.name || ''} (${meta?.year || ''})`.trim();

    // Each URL is a raw embed URL (VOE, Streamtape, etc.) — extract via extractors
    const { extractAny } = require('./extractors');
    const allStreams = [];
    for (const url of urls.slice(0, 5)) {  // limit to 5 embeds
      try {
        const extracted = await extractAny(url, { referer: baseOrigin });
        for (const ext of extracted) {
          allStreams.push({
            name: `PhoeniX\n${ext.height || 'auto'}`,
            title: `${title}\n🔗 Frembed (${ext.label})`,
            url: ext.url,
            behaviorHints: {
              notWebReady: true,
              bingeGroup: `phoenix-frembed-${ext.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
              ...(ext.sizeBytes && { videoSize: ext.sizeBytes }),
              ...(ext.requestHeaders && Object.keys(ext.requestHeaders).length > 0 && {
                proxyHeaders: { request: ext.requestHeaders }
              })
            }
          });
        }
      } catch (e) { /* skip */ }
    }
    return allStreams;
  } catch (e) { return []; }
}

// ============================================
// KINOGER — kinoger.com
// Pattern: Search by title, parse .show() JS calls to find episode URLs
// Source: webstreamr/src/source/KinoGer.ts
// ============================================
async function getKinoGerStreams(imdbId, type, season, episode) {
  const { meta } = await getTmdbMeta(imdbId, type, 'de');
  if (!meta?.name) return [];
  try {
    const searchUrl = `https://kinoger.com/?do=search&subaction=search&titleonly=3&story=${encodeURIComponent(meta.name)}&x=0&y=0&submit=submit`;
    const r = await httpGet(searchUrl);
    if (r.status !== 200) return [];

    const $ = cheerio.load(r.data);
    const pageLink = $(`.title a:contains("${meta.year || ''}")`).first().attr('href');
    if (!pageLink) return [];

    const pageR = await httpGet(pageLink);
    if (pageR.status !== 200) return [];

    const title = type === 'series'
      ? `${meta.name} ${season}x${episode}`
      : `${meta.name} (${meta.year})`;

    const seasonIndex = (season || 1) - 1;
    const episodeIndex = (episode || 1) - 1;

    // Find .show(...) calls and extract episode URL
    const results = [];
    const showJsMatches = pageR.data.matchAll(/\.show\(.*/g);
    for (const m of showJsMatches) {
      const showJs = m[0];
      let episodeUrl = null;
      const bracketMatches = [...showJs.matchAll(/\[(.*?)\]/g)];
      bracketMatches.forEach((urlsMatch, idx) => {
        if (idx !== seasonIndex || !urlsMatch[1]) return;
        const urlMatch = (urlsMatch[1].split(',')[episodeIndex] || '').match(/https?:\/\/[^\s'"<>]+/);
        if (urlMatch) episodeUrl = urlMatch[0];
      });
      if (episodeUrl) {
        results.push({
          url: episodeUrl,
          meta: { countryCodes: ['de'], referer: pageLink, title }
        });
      }
    }
    return results;
  } catch (e) { return []; }
}

// ============================================
// STREAMKISTE — streamkiste.taxi (series only in webstreamr)
// Pattern: Search by TMDB ID, parse data-link attributes for episode mirrors
// Source: webstreamr/src/source/StreamKiste.ts
// ============================================
async function getStreamKisteStreams(imdbId, type, season, episode) {
  if (type !== 'series') return [];
  const { tmdbId } = await getTmdbMeta(imdbId, type);
  if (!tmdbId) return [];
  try {
    const searchUrl = `https://streamkiste.taxi/?story=${tmdbId}&do=search&subaction=search`;
    const r = await httpGet(searchUrl);
    if (r.status !== 200) return [];

    const $ = cheerio.load(r.data);
    const seriesLink = $('.res_item a[href]:first').first().attr('href');
    if (!seriesLink) return [];

    const pageR = await httpGet(seriesLink);
    if (pageR.status !== 200) return [];

    const $page = cheerio.load(pageR.data);
    const title = `${$page('meta[property="og:title"]').attr('content') || ''} S${season}E${episode}`.trim();

    const results = [];
    $page(`[data-num="${season}x${episode}"]`).siblings('.mirrors').children('[data-link]').each((_, el) => {
      const link = $page(el).attr('data-link');
      if (!link) return;
      const url = link.replace(/^(https:)?\/\//, 'https://');
      try {
        const u = new URL(url);
        if (u.host.match(/streamkiste/)) return;
        results.push({
          url: u.toString(),
          meta: { countryCodes: ['de'], referer: seriesLink, title }
        });
      } catch {}
    });
    return results;
  } catch (e) { return []; }
}

// ============================================
// EUROSTREAMING — eurostreaming.luxe (series only)
// Pattern: POST search form, parse data-num + data-link attributes
// Source: webstreamr/src/source/Eurostreaming.ts
// ============================================
async function getEurostreamingStreams(imdbId, type, season, episode) {
  if (type !== 'series') return [];
  const { meta } = await getTmdbMeta(imdbId, type, 'it');
  if (!meta?.name) return [];
  try {
    const keyword = meta.name.replace(/[:\-]/g, '');
    const postUrl = 'https://eurostreaming.luxe/index.php?do=search';
    const form = new URLSearchParams();
    form.append('subaction', 'search');
    form.append('story', keyword);

    const r = await httpPost(postUrl, form.toString(), 'https://eurostreaming.luxe');
    if (r.status !== 200) return [];

    const $ = cheerio.load(r.data);
    let seriesPageUrl = $(`.post-thumb a[href][title="${keyword}"]:first`).first().attr('href');
    if (!seriesPageUrl) {
      // Try partial match
      seriesPageUrl = $(`.post-thumb a[href][title*="${keyword}"]:first`).first().attr('href');
    }
    if (!seriesPageUrl) return [];

    const pageR = await httpGet(seriesPageUrl, 'https://eurostreaming.luxe');
    if (pageR.status !== 200) return [];

    const $page = cheerio.load(pageR.data);
    const title = `${meta.name} S${season}E${episode}`;

    const results = [];
    $page(`[data-num="${season}x${episode}"]`).siblings('.mirrors').children('[data-link!="#"]').each((_, el) => {
      const link = $page(el).attr('data-link');
      if (!link || link === '#') return;
      try {
        const u = new URL(link);
        if (u.host.match(/eurostreaming/)) return;
        results.push({
          url: u.toString(),
          meta: { countryCodes: ['it'], referer: seriesPageUrl, title }
        });
      } catch {}
    });
    return results;
  } catch (e) { return []; }
}

// ============================================
// HOMECINE — www3.homecine.to (Spanish)
// Pattern: Search by name, parse .les-content a links with iframe src
// Source: webstreamr/src/source/HomeCine.ts
// ============================================
async function getHomeCineStreams(imdbId, type, season, episode) {
  const { meta } = await getTmdbMeta(imdbId, type, 'es');
  if (!meta?.name) return [];
  try {
    const searchUrl = `https://www3.homecine.to/?s=${encodeURIComponent(meta.name)}`;
    const r = await httpGet(searchUrl);
    if (r.status !== 200) return [];

    const $ = cheerio.load(r.data);
    // Try exact match by oldtitle attribute
    let pageUrl = $(`a[oldtitle="${meta.name}"]`).first().attr('href');
    if (!pageUrl) {
      // Try original name
      if (meta.originalName) {
        pageUrl = $(`a[oldtitle="${meta.originalName}"]`).first().attr('href');
      }
    }
    if (!pageUrl) return [];

    // Filter: movies vs series URL pattern
    if (type === 'series' && !pageUrl.includes('/series/')) return [];
    if (type === 'movie' && pageUrl.includes('/series/')) return [];

    let pageHtml = (await httpGet(pageUrl)).data;

    // For series, find episode page
    if (type === 'series') {
      const $p = cheerio.load(pageHtml);
      const epLink = $p('#seasons a').filter((_, el) => {
        const href = $p(el).attr('href') || '';
        return href.endsWith(`-temporada-${season}-capitulo-${episode}`);
      }).first().attr('href');
      if (!epLink) return [];
      pageHtml = (await httpGet(epLink, pageUrl)).data;
    }

    const title = type === 'series'
      ? `${meta.name} S${season}E${episode}`
      : `${meta.name} (${meta.year})`;

    const $page = cheerio.load(pageHtml);
    const results = [];
    $page('.les-content a').each((_, el) => {
      const text = $page(el).text().toLowerCase();
      const href = $page(el).attr('href');
      if (!href) return;
      let countryCodes = null;
      if (text.includes('latino')) countryCodes = ['mx'];
      else if (text.includes('castellano')) countryCodes = ['es'];
      if (!countryCodes) return;

      const iframeSrc = $page('iframe', el).attr('src');
      if (!iframeSrc) return;
      try {
        const u = new URL(iframeSrc);
        results.push({
          url: u.toString(),
          meta: { countryCodes, referer: pageUrl, title }
        });
      } catch {}
    });
    return results;
  } catch (e) { return []; }
}

// ============================================
// CUEVANA — ww1.cuevana3.is (Spanish)
// Pattern: Search by name, parse .open_submenu elements with data-tr/data-video
// Source: webstreamr/src/source/Cuevana.ts
// ============================================
async function getCuevanaStreams(imdbId, type, season, episode) {
  const { meta } = await getTmdbMeta(imdbId, type, 'es');
  if (!meta?.name) return [];
  try {
    const searchUrl = `https://ww1.cuevana3.is/search/${encodeURIComponent(meta.name)}/`;
    const r = await httpGet(searchUrl, 'https://ww1.cuevana3.is');
    if (r.status !== 200) return [];

    const $ = cheerio.load(r.data);
    let pageUrl = $('.TPost .Title').filter((_, el) => $(el).text().trim() === meta.name)
      .closest('a').attr('href');
    if (!pageUrl) return [];
    pageUrl = new URL(pageUrl, 'https://ww1.cuevana3.is').toString();

    let title = meta.name;
    if (type === 'series') {
      // Find episode page
      const pageR = await httpGet(pageUrl);
      const $p = cheerio.load(pageR.data);
      const epLink = $p('.TPost .Year').filter((_, el) => $p(el).text().trim() === `${season}x${episode}`)
        .closest('a').attr('href');
      if (!epLink) return [];
      pageUrl = new URL(epLink, 'https://ww1.cuevana3.is').toString();
      title += ` S${season}E${episode}`;
    } else {
      title += ` (${meta.year})`;
    }

    const pageR = await httpGet(pageUrl);
    const $page = cheerio.load(pageR.data);
    const results = [];
    $page('.open_submenu').each((_, el) => {
      const elText = $page(el).text();
      if (!elText.includes('Español')) return;
      let countryCodes = null;
      if (elText.includes('Latino')) countryCodes = ['mx'];
      else countryCodes = ['es'];

      $page('[data-tr], [data-video]', el).each((_, sub) => {
        const link = $page(sub).attr('data-tr') || $page(sub).attr('data-video');
        if (!link) return;
        try {
          const u = new URL(link);
          results.push({ url: u.toString(), meta: { countryCodes, referer: pageUrl, title } });
        } catch {}
      });
    });

    // Cuevana uses internal redirect pages with url='...' pattern
    const finalResults = [];
    for (const r of results) {
      if (r.url.includes('cuevana3')) {
        try {
          const rr = await httpGet(r.url, pageUrl);
          const m = rr.data.match(/url ?= ?'(.*)'/);
          if (m?.[1]) {
            finalResults.push({ url: m[1], meta: r.meta });
            continue;
          }
        } catch {}
        finalResults.push(r);
      } else {
        finalResults.push(r);
      }
    }
    return finalResults;
  } catch (e) { return []; }
}

module.exports = {
  getFrenchCloudStreams, getMostraGuardaStreams, getMeineCloudStreams,
  getMovixStreams, getFrembedStreams, getKinoGerStreams,
  getStreamKisteStreams, getEurostreamingStreams,
  getHomeCineStreams, getCuevanaStreams
};
