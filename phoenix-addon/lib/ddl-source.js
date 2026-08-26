/**
 * lib/ddl-source.js — Generic DDL blog source template
 *
 * Many of the user's listed sources (4KHDHub, HDHub4u, MKVBase, MKVDrama,
 * Nima4K, UHDMovies, etc.) follow the same pattern:
 *   1. Search site for movie/series title
 *   2. Open matching post page
 *   3. Find "Download" links pointing to gadgetsweb.xyz / hubcloud.in / GDToot
 *   4. Resolve through HubCloud extractor to get direct video URLs
 *
 * This generic module accepts a config and produces streams.
 */

const cheerio = require('cheerio');
const { fetchHtml, fetch } = require('./fetcher');
const { extractHubCloud, hubCloudToStreams, resolveGadgetsweb } = require('./hubcloud');
const { getMeta } = require('./meta');

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|webm|ts|m2vt|m4v)$/i;

/**
 * Source config:
 *   { id, label, baseUrl, searchPath, searchQueryParam, searchResultsSelector,
 *     linkSelector, episodePattern, cfProtected }
 *
 * `searchPath` is appended to baseUrl; uses {query} placeholder.
 * `searchResultsSelector` is a cheerio selector for result links.
 * `linkSelector` finds download/redirector links on the post page.
 */
async function getDDLStreams(config, imdbId, type, season = null, episode = null) {
  const meta = await getMeta(imdbId, type);
  if (!meta?.name) return [];

  // Build search queries — title with year, original title
  const queries = Array.from(new Set([
    `${meta.name} ${meta.year || ''}`.trim(),
    meta.name,
    meta.originalName,
    meta.originalName ? `${meta.originalName} ${meta.year || ''}`.trim() : null
  ].filter(Boolean)));

  // Try each query
  let postUrl = null;
  for (const q of queries) {
    const searchUrl = config.searchPath
      ? config.searchPath.replace('{query}', encodeURIComponent(q))
      : `${config.baseUrl}/?s=${encodeURIComponent(q)}`;
    try {
      const html = await fetchHtml(searchUrl, {
        headers: { Referer: config.baseUrl },
        timeout: 10000
      });
      const $ = cheerio.load(html);
      const results = [];
      $(config.searchResultsSelector || 'h2 a, h3 a, .post-title a, .entry-title a, article a').each((_, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        if (!href || !text) return;
        if (!href.startsWith('http')) return;
        if (!href.includes(new URL(config.baseUrl).host)) return;
        // Match title roughly
        const tLower = text.toLowerCase();
        const qLower = q.toLowerCase();
        if (tLower.includes(qLower.split(' ')[0]) ||
            qLower.includes(tLower.split(' ')[0])) {
          results.push({ url: href, text });
        }
      });
      if (results.length > 0) {
        // Pick best match (highest word overlap)
        const qWords = q.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const scored = results.map(r => {
          const words = r.text.toLowerCase();
          const score = qWords.reduce((s, w) => s + (words.includes(w) ? 1 : 0), 0);
          // Episode filter for series
          if (type === 'series' && episode != null) {
            const epPat = new RegExp(`\\b(?:EP?\\.?|Episode)\\s*0*${episode}\\b`, 'i');
            const sPat = new RegExp(`\\bS0*${season}\\b`, 'i');
            if (epPat.test(r.text) && (season == null || sPat.test(r.text))) {
              return { ...r, score: score + 10 };
            }
            return { ...r, score: 0 };
          }
          return { ...r, score };
        }).filter(r => r.score > 0)
         .sort((a, b) => b.score - a.score);
        if (scored.length > 0) {
          postUrl = scored[0].url;
          break;
        }
      }
    } catch (e) { /* try next query */ }
  }

  if (!postUrl) return [];

  // Fetch post page, find gadgetsweb/hubcloud links
  let postHtml;
  try {
    postHtml = await fetchHtml(postUrl, {
      headers: { Referer: config.baseUrl },
      timeout: 12000
    });
  } catch (e) { return []; }

  const $ = cheerio.load(postHtml);
  const redirectLinks = [];

  // Find all links to known redirector/locker hosts
  $('a').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (!href) return;
    if (/gadgetsweb\.xyz|hblinks\.dad|hubcloud\.|hubdrive|driveseed|driveleech|gdtoot|gdtot|fastream/i.test(href)) {
      // Filter by episode for series
      if (type === 'series' && episode != null) {
        // Look at parent text to filter by episode
        const parent = $(el).closest('p, div, li, h4, h3, h2').text() || text;
        const epPat = new RegExp(`\\b(?:EP?\\.?|Episode)\\s*0*${episode}\\b`, 'i');
        const sPat = new RegExp(`\\bS0*${season}\\b`, 'i');
        if (parent && !epPat.test(parent)) return;
        if (parent && season != null && !sPat.test(parent)) return;
      }
      redirectLinks.push({ href, text });
    }
  });

  if (redirectLinks.length === 0) return [];

  // Limit to top 5 redirect links to avoid too many requests
  const limited = redirectLinks.slice(0, 5);
  const allStreams = [];

  for (const link of limited) {
    try {
      // Resolve gadgetsweb redirect → hubcloud URL
      let hubcloudUrl = link.href;
      if (/gadgetsweb\.xyz/.test(link.href)) {
        const resolved = await resolveGadgetsweb(link.href);
        if (resolved) hubcloudUrl = resolved;
      }
      // Extract direct video URLs from hubcloud page
      if (/hubcloud|hubdrive/i.test(hubcloudUrl)) {
        const extracted = await extractHubCloud(hubcloudUrl, postUrl);
        const streams = hubCloudToStreams(extracted);
        // Tag with source ID
        for (const s of streams) {
          s.behaviorHints.bingeGroup = `phoenix-${config.id}-${s.behaviorHints.bingeGroup}`;
          s.title = s.title.replace(/HubCloud/, `${config.label}`);
          allStreams.push(s);
        }
      }
      // Direct video URL — use as-is
      else if (VIDEO_EXT.test(hubcloudUrl)) {
        allStreams.push({
          name: `PhoeniX\nauto`,
          title: `${meta.name} | ${config.label}`,
          url: hubcloudUrl,
          behaviorHints: {
            notWebReady: true,
            bingeGroup: `phoenix-${config.id}`,
            proxyHeaders: { request: { Referer: postUrl } }
          }
        });
      }
    } catch (e) { /* skip */ }
  }

  return allStreams;
}

// Source configurations for user's listed DDL blogs
const SOURCES = [
  {
    id: '4khdhub',
    label: '4KHDHub',
    baseUrl: 'https://4khdhub.dad',
    searchPath: 'https://4khdhub.dad/?s={query}',
    searchResultsSelector: 'h3 a, h2 a, .post-title a',
    cfProtected: true
  },
  {
    id: 'hdhub4u',
    label: 'HDHub4u',
    baseUrl: 'https://new5.hdhub4u.fo',
    searchPath: 'https://new5.hdhub4u.fo/?s={query}',
    searchResultsSelector: 'h3 a, h2 a, .post-title a'
  },
  {
    id: 'mkvbase',
    label: 'MkvBase',
    baseUrl: 'https://mkvbase.site',
    searchPath: 'https://mkvbase.site/?s={query}',
    searchResultsSelector: 'h2 a, h3 a, .entry-title a'
  },
  {
    id: 'uhdmovies',
    label: 'UHDMovies',
    baseUrl: 'https://uhdmovies.casa',
    searchPath: 'https://uhdmovies.casa/?s={query}',
    searchResultsSelector: 'h2 a, h3 a, .entry-title a'
  },
  {
    id: 'nima4k',
    label: 'Nima4K',
    baseUrl: 'https://nima4k.org',
    searchPath: 'https://nima4k.org/?s={query}',
    searchResultsSelector: 'h2 a, h3 a, .entry-title a'
  },
  {
    id: 'mkvdrama',
    label: 'MkvDrama',
    baseUrl: 'https://mkvdrama.net',
    searchPath: 'https://mkvdrama.net/?s={query}',
    searchResultsSelector: 'h2 a, h3 a, .entry-title a'
  },
  {
    id: 'ddlbase',
    label: 'DDLBase',
    baseUrl: 'https://ddlbase.com',
    searchPath: 'https://ddlbase.com/?s={query}',
    searchResultsSelector: 'h2 a, h3 a, .entry-title a'
  },
  {
    id: 'kmmovies',
    label: 'KMMovies',
    baseUrl: 'https://kmmovies.online',
    searchPath: 'https://kmmovies.online/?s={query}',
    searchResultsSelector: 'h2 a, h3 a, .entry-title a',
    cfProtected: true
  },
  {
    id: 'ernax',
    label: 'Ernax',
    baseUrl: 'https://ernax.pro',
    searchPath: 'https://ernax.pro/?s={query}',
    searchResultsSelector: 'h2 a, h3 a, .entry-title a'
  },
  {
    id: 'aether',
    label: 'Aether',
    baseUrl: 'https://aether.cx',
    searchPath: 'https://aether.cx/?s={query}',
    searchResultsSelector: 'h2 a, h3 a, .entry-title a'
  },
  {
    id: 'streamex',
    label: 'StreamEx',
    baseUrl: 'https://streamex.sh',
    searchPath: 'https://streamex.sh/?s={query}',
    searchResultsSelector: 'h2 a, h3 a, .entry-title a'
  },
  {
    id: 'fluxtv',
    label: 'FluxTV',
    baseUrl: 'https://fluxtv.cc',
    searchPath: 'https://fluxtv.cc/?s={query}',
    searchResultsSelector: 'h2 a, h3 a, .entry-title a'
  },
  {
    id: 'tenies',
    label: 'Tenies',
    baseUrl: 'https://tenies.site',
    searchPath: 'https://tenies.site/?s={query}',
    searchResultsSelector: 'h2 a, h3 a, .entry-title a'
  }
];

module.exports = { getDDLStreams, SOURCES };
