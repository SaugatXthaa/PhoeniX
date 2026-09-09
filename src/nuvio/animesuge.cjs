/**
 * AnimeSuge Scraper — animesuge.at
 * ==================================
 * Flow:
 *   1. Search: GET /api/animesuge/anime/search?keyword={query}
 *   2. Get anime page: GET /anime/{slug} → extract data-id (anime ID)
 *   3. Get episodes: GET /api/animesuge/episode/list?id={animeId}
 *   4. Get servers: GET /api/animesuge/server/list?id={animeId}&episode={n}
 *      → parse HTML for data-type (sub/dub), data-link (base64-encoded megaplay.buzz URL)
 *   5. Fetch megaplay.buzz stream page → extract data-id
 *   6. Call megaplay.buzz/stream/getSources?id={dataId} → get HLS m3u8 URL
 *   7. Return HLS stream (seekable, with sub + dub support)
 *
 * Uses TMDB → title search (like AniKotoTV)
 * Supports: Movies, TV, Anime with sub and dub streams
 * Pure Node.js fetch() — no Playwright, no curl, no browser
 */
'use strict';

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const AS_BASE = 'https://animesuge.at';
const AS_API = 'https://animesuge.at/api/animesuge';
const MEGAPLAY = 'https://megaplay.buzz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─── HTTP Helpers ────────────────────────────────────────────────────────────
async function fetchText(url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
    if (!res.ok) return '';
    return await res.text();
  } catch (e) { return ''; }
}

async function fetchJson(url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

// ─── TMDB ────────────────────────────────────────────────────────────────────
async function getTmdbInfo(tmdbId, mediaType) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE}/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
  return await fetchJson(url);
}

// ─── Search AnimeSuge ────────────────────────────────────────────────────────
// The search API sometimes doesn't return the most relevant results (e.g.
// searching "Naruto" returns "road-of-naruto" and "boruto" but NOT "naruto"
// itself). We work around this by ALSO trying a direct slug guess based on
// the title, and including it in the candidate list.
async function searchAnimeSuge(query) {
  const url = `${AS_API}/anime/search?keyword=${encodeURIComponent(query)}`;
  console.log(`[AnimeSuge] Search: ${url}`);
  const data = await fetchJson(url, { 'X-Requested-With': 'XMLHttpRequest' });
  if (!data || !data.result) return [];

  const html = data.result.html || '';
  const matches = [...html.matchAll(/href="(https:\/\/animesuge\.at\/anime\/([^"]+))"/g)];
  const seen = new Set();
  const results = [];
  for (const m of matches) {
    if (!seen.has(m[2])) {
      seen.add(m[2]);
      results.push({ url: m[1], slug: m[2] });
    }
  }

  // Workaround: the search API often doesn't return the main series. Add a
  // direct slug guess based on the title (e.g. "Naruto" → "naruto", "Jujutsu
  // Kaisen" → "jujutsu-kaisen", "Demon Slayer" → "demon-slayer").
  // We try multiple common slug patterns:
  //   1. title-as-slug (lowercase, hyphens)
  //   2. title-tv (for series)
  //   3. title-shippuden / title-2nd-season (for sequels — heuristic)
  const slugBase = query.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const slugGuesses = [
    slugBase,                    // e.g. "naruto", "jujutsu-kaisen"
    `${slugBase}-tv`,            // e.g. "jujutsu-kaisen-tv"
  ];

  for (const guess of slugGuesses) {
    if (!seen.has(guess)) {
      seen.add(guess);
      results.push({ url: `${AS_BASE}/anime/${guess}`, slug: guess, isGuess: true });
    }
  }

  console.log(`[AnimeSuge] Found ${results.length} results (${results.filter(r => r.isGuess).length} guesses)`);
  return results;
}

// ─── Get Anime ID from Page ──────────────────────────────────────────────────
// Also returns the full title from the page, which is more accurate than the
// slug for matching purposes.
async function getAnimeIdAndTitle(slug) {
  const html = await fetchText(`${AS_BASE}/anime/${slug}`);
  if (!html) return null;

  const idMatch = html.match(/data-id="(\d+)"/);
  const id = idMatch ? idMatch[1] : null;

  // Extract the og:title or <title> tag for accurate matching.
  // Strip "Watch " prefix and " - AnimeSuge" suffix.
  let title = slug;
  const ogTitleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
  if (ogTitleMatch) {
    title = ogTitleMatch[1];
  } else {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    if (titleMatch) title = titleMatch[1];
  }
  // Clean up HTML entities and prefix/suffix
  title = title
    .replace(/&amp;amp;#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/\s*-\s*Watch on AnimeSuge.*$/i, '')
    .replace(/\s*-\s*AnimeSuge.*$/i, '')
    .replace(/^Watch\s+/i, '')
    .trim();

  // Find poster
  let poster = null;
  const posterMatch = html.match(/src="([^"]+\.webp)"/);
  if (posterMatch) poster = posterMatch[1];

  return { id, slug, title, poster };
}

// ─── Get Anime ID from Page (backward-compatible wrapper) ────────────────────
async function getAnimeId(slug) {
  return getAnimeIdAndTitle(slug);
}

// ─── Get Server List ─────────────────────────────────────────────────────────
async function getServerList(animeId, episode) {
  const url = `${AS_API}/server/list?id=${animeId}&episode=${episode}`;
  console.log(`[AnimeSuge] Servers: ${url}`);
  const data = await fetchJson(url, { 'X-Requested-With': 'XMLHttpRequest' });
  if (!data || !data.result) return [];

  const html = data.result;
  const servers = [];
  const matches = [...html.matchAll(/data-type="([^"]+)"[\s\S]*?data-link="([^"]+)"[\s\S]*?data-sv-id="([^"]+)"/g)];
  for (const m of matches) {
    const type = m[1]; // 'sub' or 'dub'
    const link = Buffer.from(m[2], 'base64').toString('utf-8');
    const svId = m[3];
    servers.push({ type, link, svId });
  }
  console.log(`[AnimeSuge] Found ${servers.length} servers (sub: ${servers.filter(s => s.type === 'sub').length}, dub: ${servers.filter(s => s.type === 'dub').length})`);
  return servers;
}

// ─── Resolve megaplay.buzz Stream ────────────────────────────────────────────
async function resolveMegaPlay(streamUrl) {
  const html = await fetchText(streamUrl, { 'Referer': AS_BASE + '/' });
  if (!html) return null;

  const idMatch = html.match(/data-id="(\d+)"/);
  if (!idMatch) return null;

  // Use getSourcesNew (not getSources) — the old API was deprecated and
  // now returns encrypted data without a sources.file field.
  // getSourcesNew returns { sources: { file: "https://...m3u8" }, tracks: [...] }
  const apiUrl = `${MEGAPLAY}/stream/getSourcesNew?id=${idMatch[1]}`;
  const data = await fetchJson(apiUrl, { 'Referer': streamUrl, 'X-Requested-With': 'XMLHttpRequest' });
  if (!data || !data.sources) return null;

  return {
    url: data.sources.file || data.sources,
    subtitles: data.tracks || [],
    intro: data.intro || null,
    outro: data.outro || null,
  };
}

// ─── Build Stream Object ─────────────────────────────────────────────────────
function buildStream(streamData, type, quality, animeTitle, episode) {
  const isHls = streamData.url.includes('.m3u8');
  const subs = (streamData.subtitles || []).map(s => ({
    url: s.file,
    lang: s.label || s.kind || 'en',
    name: s.label || 'English',
  }));

  return {
    name: `AnimeSuge\n${type.toUpperCase()} ${quality}`,
    title: `${animeTitle} - Episode ${episode} (${type.toUpperCase()})`,
    url: streamData.url,
    quality,
    behaviorHints: {
      notWebReady: false,
      headers: { 'Referer': 'https://megaplay.buzz/' },
    },
    subtitles: subs,
    meta: {
      provider: 'AnimeSuge',
      source: 'megaplay.buzz',
      server: 'megaplay.buzz',
      type: 'hls',
      quality,
      audio: type === 'dub' ? 'english' : 'japanese',
      language: [type === 'dub' ? 'en' : 'ja'],
      category: type,
      title: animeTitle,
      episode,
      directStream: true,
      mediaType: 'movie',
      intro: streamData.intro,
      outro: streamData.outro,
    },
  };
}

// ─── Normalize title for matching ───────────────────────────────────────────
// Strips punctuation, articles, and case for fuzzy title comparison.
function normalizeTitle(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(the|a|an|tv|season|part|specials?|movie|ova|ona|oad)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Main: getStreams ────────────────────────────────────────────────────────
async function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[AnimeSuge] getStreams: ${tmdbId} ${mediaType} S${season || '?'}E${episode || '?'}`);
  try {
    // 1. Get title from TMDB
    const meta = await getTmdbInfo(tmdbId, mediaType);
    if (!meta) return [];
    const title = mediaType === 'tv' ? meta.name : meta.title;
    const year = (mediaType === 'tv' ? meta.first_air_date : meta.release_date || '').substring(0, 4);
    console.log(`[AnimeSuge] Title: ${title} (${year})`);

    // 2. Search AnimeSuge
    const results = await searchAnimeSuge(title);
    if (!results.length) return [];

    // 3. Fetch the actual title from each search result page and pick the best
    // match. AnimeSuge's search API doesn't return titles (only slugs), and
    // the slug order doesn't match relevance. We fetch each page's og:title
    // to get the real anime title, then match against the TMDB title.
    //
    // Limit to first 8 results to avoid too many HTTP requests.
    const candidates = await Promise.all(
      results.slice(0, 8).map(async (r) => {
        const info = await getAnimeIdAndTitle(r.slug);
        return info ? { ...info, slug: r.slug } : null;
      })
    );
    const validCandidates = candidates.filter(Boolean);

    const queryNorm = normalizeTitle(title);
    let bestMatch = null;
    let bestScore = 0;

    for (const c of validCandidates) {
      const candidateTitleNorm = normalizeTitle(c.title || c.slug);
      let score = 0;

      // Exact normalized title match
      if (candidateTitleNorm === queryNorm) {
        score = 100;
        // For S1, prefer "-tv" slugs and penalize non-TV slugs
        if (!season || season === 1) {
          if (c.slug.endsWith('-tv') || c.slug.includes('-tv-')) score += 20;
          if (/specials?$|-special-|-ova-|-oad-|-movie-|0-movie/.test(c.slug)) score -= 25;
        } else {
          // For later seasons, prefer season-specific entries
          if (c.slug.includes(`${season}nd-season`) || c.slug.includes(`${season}rd-season`)) score += 20;
        }
      }
      // Query is substring of candidate title
      else if (candidateTitleNorm.includes(queryNorm)) {
        score = 80;
        if (!season || season === 1) {
          if (/2nd season|3rd season|culling|0 movie|specials|ova|oad/.test(c.slug)) score -= 30;
          if (c.slug.endsWith('-tv') || c.slug.includes('-tv-')) score += 10;
        }
      }
      // Candidate title is substring of query
      else if (queryNorm.includes(candidateTitleNorm)) {
        score = 70;
      }
      // Word overlap
      else {
        const queryWords = queryNorm.split(' ').filter(w => w.length > 2);
        const candidateWords = candidateTitleNorm.split(' ').filter(w => w.length > 2);
        const overlap = queryWords.filter(w => candidateWords.includes(w)).length;
        score = (overlap / Math.max(queryWords.length, 1)) * 60;
      }

      console.log(`[AnimeSuge] Candidate: "${c.title}" slug=${c.slug} score=${score}`);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = c;
      }
    }

    if (!bestMatch || bestScore < 40) {
      console.log(`[AnimeSuge] No confident match found for "${title}" (best score: ${bestScore})`);
      return [];
    }

    console.log(`[AnimeSuge] Best match: ${bestMatch.slug} (score: ${bestScore})`);

    if (!bestMatch.id) return [];

    // 4. Get servers for the episode
    const ep = parseInt(episode) || 1;
    const servers = await getServerList(bestMatch.id, ep);
    if (!servers.length) return [];

    // 5. Resolve each server to HLS stream
    const streams = [];
    const seenUrls = new Set();

    for (const server of servers) {
      const streamData = await resolveMegaPlay(server.link);
      if (streamData && streamData.url && !seenUrls.has(streamData.url)) {
        seenUrls.add(streamData.url);
        const quality = '1080p';
        streams.push(buildStream(streamData, server.type, quality, bestMatch.title, ep));
      }
    }

    // Sort: sub first, then dub
    streams.sort((a, b) => {
      if (a.meta.category === 'sub' && b.meta.category === 'dub') return -1;
      if (a.meta.category === 'dub' && b.meta.category === 'sub') return 1;
      return 0;
    });

    console.log(`[AnimeSuge] Returning ${streams.length} stream(s)`);
    return streams;
  } catch (e) {
    console.error(`[AnimeSuge] Error: ${e.message}`);
    return [];
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────
module.exports = { getStreams, searchAnimeSuge, getAnimeId, getServerList, resolveMegaPlay, PROVIDER_NAME: 'AnimeSuge' };
