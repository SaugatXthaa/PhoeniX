/**
 * lib/providers.js — Wrapper around @movie-web/providers
 *
 * Stremify-style approach: use the movie-web/providers library as a generic
 * scraper engine for 80+ sources. Convert outputs to Stremio stream objects.
 *
 * The library returns streams like:
 *   { type: 'hls', playlist: 'https://.../master.m3u8', headers: { Referer, 'User-Agent' } }
 *   { type: 'file', qualities: { '1080': { url }, '720': { url } }, headers: {...} }
 *
 * We wrap as:
 *   { url, behaviorHints: { notWebReady: true, proxyHeaders: { request: headers } } }
 *
 * Nuvio app's player respects proxyHeaders to send Referer/UA, and ignores
 * CORS (so notWebReady:true is honored).
 */

let providersLib = null;
let scraper = null;

async function loadProviders() {
  if (scraper) return scraper;
  try {
    providersLib = require('@movie-web/providers');
    const { makeProviders, makeStandardFetcher, targets } = providersLib;
    scraper = makeProviders({
      fetcher: makeStandardFetcher(globalThis.fetch),
      target: targets.NATIVE
    });
    return scraper;
  } catch (err) {
    console.error('[providers] Failed to load @movie-web/providers:', err.message);
    return null;
  }
}

// Provider IDs to enable (from the library's actual built-in list)
// 14 sources + 43 embeds — sources return embeds, embeds return streams
const ENABLED_PROVIDER_IDS = [
  // Sources (return embeds or direct streams)
  '8stream', 'm4ufree', 'hdrezka', 'primewire', 'nites', 'soapertv',
  'tugaflix', 'streambox', 'ee3', 'catflix', 'hindiscraper',
  '2embed', 'whvxMirrors', 'mp4hydra'
];

async function getProviderStreams(imdbId, type, season, episode) {
  const s = await loadProviders();
  if (!s) return [];

  // Build media object for movie-web/providers
  const media = {
    type: type === 'series' ? 'show' : 'movie',
    title: '',
    imdbId,
    tmdbId: null,
    releaseYear: 0,
    episode: undefined,
    season: undefined
  };

  // Get meta to fill title/year
  const { getMeta } = require('./meta');
  const meta = await getMeta(imdbId, type);
  if (meta) {
    media.title = meta.name;
    media.releaseYear = meta.year || 0;
    if (meta.tmdbId) media.tmdbId = String(meta.tmdbId);
  }
  if (type === 'series' && season) {
    media.season = { number: Number(season), type: 'show', title: meta?.name || '' };
    if (episode) {
      media.episode = { number: Number(episode), season: Number(season), type: 'show', title: '' };
    }
  }

  const streams = [];
  const timeoutMs = parseInt(process.env.PROVIDER_TIMEOUT || '8000', 10);

  // Run all sources in parallel with timeout
  const tasks = ENABLED_PROVIDER_IDS.map(async (sourceId) => {
    try {
      const out = await Promise.race([
        s.runSourceScraper({ id: sourceId, media }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
      ]);

      if (out?.stream) {
        const converted = convertStream(out.stream, sourceId);
        if (converted) streams.push(converted);
      }

      if (out?.embeds?.length) {
        for (const embed of out.embeds.slice(0, 3)) {
          try {
            const eo = await Promise.race([
              s.runEmbedScraper({ id: embed.embedId, url: embed.url }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
            ]);
            if (eo?.stream) {
              const c = convertStream(eo.stream, sourceId, embed.embedId);
              if (c) streams.push(c);
            }
          } catch (e) { /* skip */ }
        }
      }
    } catch (e) { /* skip */ }
  });

  await Promise.all(tasks);
  return streams;
}

function convertStream(stream, sourceId, embedId = null) {
  const tag = embedId ? `${sourceId}/${embedId}` : sourceId;
  const bingeGroup = `phoenix-${sourceId}${embedId ? '-' + embedId : ''}`;

  if (stream[0]?.type === 'hls') {
    const headers = stream[0].headers || {};
    return {
      name: `PhoeniX\nHLS`,
      title: `Auto (${tag})`,
      url: stream[0].playlist,
      behaviorHints: {
        notWebReady: true,
        bingeGroup,
        ...(Object.keys(headers).length > 0 && {
          proxyHeaders: { request: headers }
        })
      }
    };
  }

  if (stream[0]?.type === 'file') {
    const headers = stream[0].headers || {};
    const qualities = stream[0].qualities || {};
    const results = [];
    for (const [quality, info] of Object.entries(qualities)) {
      if (!info?.url) continue;
      results.push({
        name: `PhoeniX\n${quality}p`,
        title: `${quality}p (${tag})`,
        url: info.url,
        behaviorHints: {
          notWebReady: true,
          bingeGroup: `${bingeGroup}-${quality}`,
          ...(Object.keys(headers).length > 0 && {
            proxyHeaders: { request: headers }
          })
        }
      });
    }
    return results[0] || null;
  }

  return null;
}

module.exports = { getProviderStreams, loadProviders, ENABLED_PROVIDER_IDS };
