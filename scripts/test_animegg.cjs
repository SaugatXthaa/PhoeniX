/**
 * Anime Sources Module — Stremio Addon Ready
 * ===========================================
 * Multi-source anime stream provider with rich metadata.
 * Returns Stremio-compatible stream objects.
 *
 * WORKING SOURCES (verified Aug 2026):
 *   1. AnimeGG    — Direct MP4, sub+dub, 720p+1080p, needs Referer
 *   2. AniKoto    — HLS, sub+dub, via Anivexa proxy
 *   3. AniDB App  — HLS, sub+dub, via Anivexa proxy
 *   4. AniBD      — HLS, sub only, direct
 *
 * All sources use AniList ID as input (same as PenguPlay's Antova).
 * 100% pure Node.js — NO Playwright, NO browser, Render free-tier compatible.
 *
 * USAGE:
 *   const { getAnimeStreams } = require('./anime_sources');
 *   const streams = await getAnimeStreams({
 *     anilistId: 113415,    // Jujutsu Kaisen
 *     episode: 1,
 *     category: 'sub',      // 'sub' or 'dub'
 *     anivexaUrl: 'https://your-anivexa.onrender.com',  // optional
 *   });
 *
 * OUTPUT FORMAT (Stremio-compatible):
 *   [{
 *     name: "AnimeGG\n1080p",
 *     title: "Jujutsu Kaisen - Episode 1",
 *     url: "https://www.animegg.org/play/476769/video.mp4?for=...",
 *     quality: "1080p",
 *     behaviorHints: {
 *       notWebReady: true,
 *       headers: { "Referer": "https://www.animegg.org/" }
 *     },
 *     meta: {
 *       provider: "AnimeGG",
 *       audio: "english",       // 'japanese' | 'english' | 'spanish'
 *       subtitles: true,
 *       type: "mp4",            // 'mp4' | 'hls'
 *       server: "Animegg",
 *     }
 *   }]
 */

'use strict';

const axios = require('axios');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ANILIST_GQL = 'https://graphql.anilist.co';

// ==================== AniList Metadata ====================

async function getAniListMedia(anilistId) {
  const query = `query ($id: Int) { Media(id: $id, type: ANIME) { id idMal title { romaji english native } episodes seasonYear status format coverImage { large } } }`;
  try {
    const r = await axios.post(ANILIST_GQL, { query, variables: { id: Number(anilistId) } }, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 8000,
    });
    return r.data?.data?.Media || null;
  } catch (e) { return null; }
}

// ==================== Source 1: AnimeGG (Direct MP4) ====================

const ANIMEGG_BASE = 'https://www.animegg.org';

async function animeggSearch(query) {
  const r = await axios.get(`${ANIMEGG_BASE}/search/`, {
    params: { q: query },
    headers: { 'User-Agent': UA },
    timeout: 10000,
  });
  // Find all /series/<slug> links
  const slugs = new Set();
  const matches = r.data.match(/\/series\/([^"'/?#]+)/g) || [];
  for (const m of matches) {
    const slug = m.replace('/series/', '');
    if (slug.length > 2) slugs.add(slug);
  }
  return [...slugs].map(slug => ({
    slug,
    title: slug.replace(/-/g, ' '),
  }));
}

async function animeggGetEpisodes(slug) {
  const r = await axios.get(`${ANIMEGG_BASE}/series/${slug}`, {
    headers: { 'User-Agent': UA },
    timeout: 10000,
  });
  const episodes = [];
  const matches = r.data.match(/href=["']\/([^"'?]*-episode-(\d+))["']/gi) || [];
  const seen = new Set();
  for (const m of matches) {
    const pm = m.match(/\/([^"'?]*-episode-(\d+))/);
    if (!pm || seen.has(pm[2])) continue;
    seen.add(pm[2]);
    episodes.push({ number: parseInt(pm[2]), slug: pm[1] });
  }
  return episodes.sort((a, b) => a.number - b.number);
}

async function animeggGetStreams(epSlug, category) {
  // Fetch video page to get ALL embed IDs
  const pageR = await axios.get(`${ANIMEGG_BASE}/${epSlug}`, {
    headers: { 'User-Agent': UA, Referer: ANIMEGG_BASE + '/' },
    timeout: 10000,
    validateStatus: () => true,
  });
  if (pageR.status !== 200) return [];

  // Find all iframes and their nearby sub/dub labels
  const html = pageR.data;
  const iframeMatches = [...html.matchAll(/<iframe[^>]+src=["']\/embed\/(\d+)["']/gi)];
  if (!iframeMatches.length) return [];

  // Find which embed is sub vs dub by looking at nearby labels
  let subEmbedId = null;
  let dubEmbedId = null;
  for (const m of iframeMatches) {
    const embedId = m[1];
    const idx = m.index;
    // Look at surrounding HTML for "subbed" or "dubbed" labels
    const before = html.slice(Math.max(0, idx - 500), idx);
    const after = html.slice(idx, idx + 500);
    const context = (before + after).toLowerCase();
    if (context.includes('dubb') && !dubEmbedId) {
      dubEmbedId = embedId;
    } else if (context.includes('subb') && !subEmbedId) {
      subEmbedId = embedId;
    }
  }
  // Fallback: first embed = sub, second = dub
  if (!subEmbedId) subEmbedId = iframeMatches[0][1];
  if (!dubEmbedId && iframeMatches[1]) dubEmbedId = iframeMatches[1][1];
  // Also check third embed (sometimes dub is third)
  if (!dubEmbedId && iframeMatches[2]) dubEmbedId = iframeMatches[2][1];

  // Fetch ALL embeds of the correct category
  const targetEmbedIds = category === 'dub'
    ? [dubEmbedId, iframeMatches[2]?.[1]].filter(Boolean)
    : [subEmbedId].filter(Boolean);
  if (!targetEmbedIds.length) return [];

  const allStreams = [];
  for (const embedId of [...new Set(targetEmbedIds)]) {
    try {
      const embedR = await axios.get(`${ANIMEGG_BASE}/embed/${embedId}`, {
        headers: { 'User-Agent': UA, Referer: `${ANIMEGG_BASE}/${epSlug}` },
        timeout: 10000,
      });
      const m = embedR.data.match(/var\s+videoSources\s*=\s*(\[[\s\S]*?\]);/);
      if (!m) continue;
      const asJson = m[1]
        .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
        .replace(/:\s*'([^']*)'/g, ': "$1"');
      const parsed = JSON.parse(asJson);
      for (const s of parsed) {
        let backup = null;
        if (s.bk) {
          try { backup = decodeURIComponent(Buffer.from(s.bk, 'base64').toString()); } catch (e) {}
        }
        const url = s.file ? (s.file.startsWith('http') ? s.file : ANIMEGG_BASE + s.file) : (backup || '');
        if (url) {
          allStreams.push({
            url, backup,
            quality: s.label || 'unknown',
            type: (s.file || '').includes('.m3u8') ? 'hls' : 'mp4',
          });
        }
      }
    } catch (e) {}
  }
  return allStreams;
}

// ==================== Source 2-4: Anivexa Proxy ====================

async function anivexaGetStreams(anivexaUrl, anilistId, episode, category) {
  const streams = [];
  const providers = ['animegg', 'anikoto', 'anidbapp', 'anibd'];

  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      const url = `${anivexaUrl}/watch/${provider}/${anilistId}/${category}/${provider}-${episode}`;
      const r = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': UA } });
      const data = r.data;
      if (!data.streams) return { provider, streams: [] };

      const filtered = data.streams
        .filter(s => s.url && s.url.startsWith('http') && s.type !== 'embed')
        .map(s => ({
          provider,
          url: s.url,
          quality: s.quality || 'unknown',
          type: s.type || 'hls',
          audio: s.audio || category,
          server: s.server || provider,
          referer: s.referer || null,
          backup: s.backup || null,
        }));
      return { provider, streams: filtered };
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.streams.length) {
      streams.push(...r.value.streams);
    }
  }
  return streams;
}

// ==================== Main: Get All Streams ====================

/**
 * Get anime streams from all available sources.
 *
 * @param {Object} opts
 * @param {number} opts.anilistId - AniList anime ID (e.g., 113415 for JJK)
 * @param {number} opts.episode - Episode number
 * @param {string} [opts.category='sub'] - 'sub' or 'dub'
 * @param {string} [opts.anivexaUrl] - URL of self-hosted Anivexa-API (optional)
 * @returns {Promise<Array>} Stremio-compatible stream objects
 */
async function getAnimeStreams(opts) {
  const { anilistId, episode, category = 'sub', anivexaUrl } = opts;

  // Get anime metadata
  const media = await getAniListMedia(anilistId);
  const title = media?.title?.english || media?.title?.romaji || `AniList ${anilistId}`;
  const year = media?.seasonYear || '';

  const allStreams = [];

  // --- Source 1: AnimeGG (direct, always works) ---
  try {
    const searchResults = await animeggSearch(title);
    if (searchResults.length) {
      // Pick best match
      let best = searchResults[0];
      for (const r of searchResults) {
        if (r.title.toLowerCase() === title.toLowerCase()) { best = r; break; }
      }
      const episodes = await animeggGetEpisodes(best.slug);
      const ep = episodes.find(e => e.number === episode);
      if (ep) {
        // For dub, append #dubbed to slug
        const epSlug = category === 'dub' ? `${ep.slug}#dubbed` : ep.slug;
        const rawStreams = await animeggGetStreams(ep.slug, category);
        for (const s of rawStreams) {
          allStreams.push({
            name: `AnimeGG\n${s.quality}`,
            title: `${title} - Episode ${episode}`,
            url: s.url,
            quality: s.quality,
            behaviorHints: {
              notWebReady: true,
              headers: { 'Referer': 'https://www.animegg.org/' },
            },
            meta: {
              provider: 'AnimeGG',
              audio: category === 'dub' ? 'english' : 'japanese',
              subtitles: category === 'sub',
              type: s.type,
              server: 'AnimeGG',
              backup: s.backup,
            },
          });
        }
      }
    }
  } catch (e) {
    console.error(`[anime] AnimeGG error: ${e.message}`);
  }

  // --- Sources 2-4: Anivexa proxy (if URL provided) ---
  if (anivexaUrl) {
    try {
      const anivexaStreams = await anivexaGetStreams(anivexaUrl, anilistId, episode, category);
      for (const s of anivexaStreams) {
        const providerName = s.provider.charAt(0).toUpperCase() + s.provider.slice(1);
        allStreams.push({
          name: `${providerName}\n${s.quality}`,
          title: `${title} - Episode ${episode}`,
          url: s.url,
          quality: s.quality,
          behaviorHints: {
            notWebReady: true,
            ...(s.referer && { headers: { 'Referer': s.referer } }),
          },
          meta: {
            provider: providerName,
            audio: s.audio === 'dub' ? 'english' : (s.audio === 'sub' ? 'japanese' : s.audio),
            subtitles: s.audio === 'sub' || category === 'sub',
            type: s.type,
            server: s.server,
            backup: s.backup,
            needsProxy: s.provider !== 'animegg',  // AniKoto/AniDB may need proxy for CF
          },
        });
      }
    } catch (e) {
      console.error(`[anime] Anivexa error: ${e.message}`);
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = allStreams.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  // Sort by quality (1080p first, then 720p, etc.)
  const qualityOrder = { '1080p': 0, '720p': 1, '480p': 2, '360p': 3, 'unknown': 4 };
  deduped.sort((a, b) => (qualityOrder[a.quality] ?? 5) - (qualityOrder[b.quality] ?? 5));

  return deduped;
}

// ==================== Stremio Stream Handler ====================

/**
 * Stremio addon stream handler.
 * Usage:
 *   builder.defineStreamHandler(async ({ type, id }) => {
 *     if (type !== 'series') return { streams: [] };
 *     // id format: "anilist:113415:1:1" (anilist:ID:season:episode)
 *     const parts = id.split(':');
 *     const anilistId = parseInt(parts[1]);
 *     const episode = parseInt(parts[3]);
 *     const streams = await getAnimeStreams({
 *       anilistId, episode,
 *       category: 'sub',  // or 'dub'
 *       anivexaUrl: process.env.ANIVEXA_URL,
 *     });
 *     return { streams };
 *   });
 */

// ==================== CLI Test ====================

if (require.main === module) (async () => {
  const anilistId = parseInt(process.argv[2]) || 113415;
  const episode = parseInt(process.argv[3]) || 1;
  const category = process.argv[4] || 'sub';
  const anivexaUrl = process.env.ANIVEXA_URL || null;

  console.log(`=== Anime Streams for AniList ${anilistId} ep ${episode} (${category}) ===\n`);

  const streams = await getAnimeStreams({ anilistId, episode, category, anivexaUrl });

  console.log(`Found ${streams.length} stream(s):\n`);
  for (const s of streams) {
    console.log(`  [${s.meta.provider}] ${s.quality} ${s.meta.type} audio=${s.meta.audio}`);
    console.log(`    URL: ${s.url.slice(0, 100)}...`);
    if (s.behaviorHints?.headers) console.log(`    Headers: ${JSON.stringify(s.behaviorHints.headers)}`);
    if (s.meta.backup) console.log(`    Backup: ${s.meta.backup.slice(0, 80)}...`);
    console.log();
  }

  // Verify playability
  console.log('=== Verifying playability ===');
  for (const s of streams.slice(0, 3)) {
    try {
      const r = await axios.head(s.url, {
        headers: { 'User-Agent': UA, ...(s.behaviorHints?.headers || {}) },
        timeout: 8000,
        validateStatus: () => true,
      });
      console.log(`  [${s.meta.provider}] ${s.quality}: HTTP ${r.status} ${r.headers['content-type'] || ''} ${r.headers['content-length'] || ''}`);
    } catch (e) {
      console.log(`  [${s.meta.provider}] ${s.quality}: ERROR - ${e.message}`);
    }
  }
})();

module.exports = { getAnimeStreams, getAniListMedia, animeggSearch, animeggGetEpisodes, animeggGetStreams };
