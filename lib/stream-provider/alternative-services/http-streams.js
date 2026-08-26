// lib/stream-provider/alternative-services/http-streams.js
// Orchestrates all HTTP streaming providers in parallel

import Cinemeta from '../../util/cinemeta.js';
import {
    get4KHDHubStreams, getHDHub4uStreams, getMKVCinemasStreams,
    getCineDozeStreams,
    getMoviesModStreams, getMoviesLeechStreams, getAnimeFlixStreams,
    get111477Streams, getXDMoviesStreams,
    getCineWaveStreams,
    getPaheStreams, getDDLBaseStreams, getMkvBaseStreams,
    getAnimePaheStreams,
    getAnikuraStreams,
    getZStreamStreams,
    getAnikotoStreams,
    getEnmaStreams,
    getSkyMoviesStreams,
    getKMMoviesStreams,
    getHDMoviesChannelStreams,
    getTeniesStreams,
    getAetherStreams,
    getNima4KStreams,
    getUHDMoviesStreams,
    getCineFreakStreams,
    getMoviesEQStreams,
    getMiruroStreams,
    getAniWavesStreams,
    getAniWaveStreams,
    getAcerMoviesStreams,
    getMkvDramaStreams,
    getStreamXTVStreams,
    getPrimeShowsStreams,
    getHiAnimeStreams,
    getFlixHQStreams
} from '../../http-streams/index.js';
import { getVixSrcStreams } from '../../http-streams/index.js';
import { wrapHttpStreamsWithResolver } from '../utils/url-validation.js';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.HTTP_STREAMING_TIMEOUT_MS || '15000', 10);

// Stream result cache — stores resolved streams for 30 min to make repeat
// requests instant (critical for Render free tier where providers are slow)
const streamResultCache = new Map();

// Hard limit: return whatever we have after this many ms, regardless of
// whether all providers have finished. This ensures the response is always
// fast enough for Nuvio/Stremio's stream request timeout.
// Timer starts at the BEGINNING of getHttpStreamingStreams (includes Cinemeta time).
const EARLY_RETURN_MS = parseInt(process.env.HTTP_STREAMING_EARLY_RETURN_MS || '20000', 10);

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms))
    ]).catch(err => {
        console.log(`[HTTP-STREAMS] ${label} failed: ${err.message}`);
        return [];
    });
}

function getHttpStreamingTimeoutMs(label) {
    const overrides = {
        '4KHDHub': parseInt(process.env.HTTP_4KHDHUB_TIMEOUT || '15000', 10),
        'HDHub4u': parseInt(process.env.HTTP_HDHUB4U_TIMEOUT || '15000', 10),
        'MKVCinemas': parseInt(process.env.HTTP_MKVCINEMAS_TIMEOUT || '15000', 10),
        'MoviesMod': parseInt(process.env.HTTP_MOVIESMOD_TIMEOUT || '15000', 10),
        'MoviesLeech': parseInt(process.env.HTTP_MOVIESLEECH_TIMEOUT || '15000', 10),
        'AnimeFlix': parseInt(process.env.HTTP_ANIMEFLIX_TIMEOUT || '15000', 10),
        'VixSrc': parseInt(process.env.HTTP_VIXSRC_TIMEOUT || '15000', 10),
        '111477': parseInt(process.env.HTTP_111477_TIMEOUT || '15000', 10),
        'XDMovies': parseInt(process.env.HTTP_XDMOVIES_TIMEOUT || '15000', 10),
        'CineWave': parseInt(process.env.HTTP_CINEWAVE_TIMEOUT || '15000', 10),
        'CineDoze': parseInt(process.env.HTTP_CINEDOZE_TIMEOUT || '15000', 10),
        'Pahe': parseInt(process.env.HTTP_PAHE_TIMEOUT || '15000', 10),
        'DDLBase': parseInt(process.env.HTTP_DDLBASE_TIMEOUT || '15000', 10),
        'MkvBase': parseInt(process.env.HTTP_MKVBASE_TIMEOUT || '15000', 10),
        'AnimePahe': parseInt(process.env.HTTP_ANIMEPAHE_TIMEOUT || '15000', 10),
        'Anikura': parseInt(process.env.HTTP_ANIKURA_TIMEOUT || '15000', 10),
        'ZStream': parseInt(process.env.HTTP_ZSTREAM_TIMEOUT || '15000', 10),
        'Anikoto': parseInt(process.env.HTTP_ANIKOTO_TIMEOUT || '15000', 10),
        'Enma': parseInt(process.env.HTTP_ENMA_TIMEOUT || '15000', 10),
        'SkyMoviesHD': parseInt(process.env.HTTP_SKYMOVIES_TIMEOUT || '15000', 10),
        'KMMovies': parseInt(process.env.HTTP_KMMOVIES_TIMEOUT || '15000', 10),
        'HDMoviesChannel': parseInt(process.env.HTTP_HDMOVIESCHANNEL_TIMEOUT || '15000', 10),
        'Tenies': parseInt(process.env.HTTP_TENIES_TIMEOUT || '15000', 10),
        'Aether': parseInt(process.env.HTTP_AETHER_TIMEOUT || '15000', 10),
        'Nima4K': parseInt(process.env.HTTP_NIMA4K_TIMEOUT || '15000', 10),
        'UHDMovies': parseInt(process.env.HTTP_UHDMOVIES_TIMEOUT || '15000', 10),
        'CineFreak': parseInt(process.env.HTTP_CINEFREAK_TIMEOUT || '15000', 10),
        'MoviesEQ': parseInt(process.env.HTTP_MOVIESEQ_TIMEOUT || '15000', 10),
        'Miruro': parseInt(process.env.HTTP_MIRURO_TIMEOUT || '15000', 10),
        'AniWaves': parseInt(process.env.HTTP_ANIWAVES_TIMEOUT || '15000', 10),
        'AniWave': parseInt(process.env.HTTP_ANIWAVE_TIMEOUT || '15000', 10),
        'AcerMovies': parseInt(process.env.HTTP_ACERMOVIES_TIMEOUT || '15000', 10),
        'MkvDrama': parseInt(process.env.HTTP_MKVDRAMA_TIMEOUT || '15000', 10),
        'StreamXTV': parseInt(process.env.HTTP_STREAMXTV_TIMEOUT || '15000', 10),
        'PrimeShows': parseInt(process.env.HTTP_PRIMESHOWS_TIMEOUT || '15000', 10),
        'HiAnime': parseInt(process.env.HTTP_HIANIME_TIMEOUT || '15000', 10),
        'FlixHQ': parseInt(process.env.HTTP_FLIXHQ_TIMEOUT || '15000', 10)
    };
    return overrides[label] || DEFAULT_TIMEOUT_MS;
}

export async function getHttpStreamingStreams(config, type, id, options = {}) {
    const { season = null, episode = null } = options;
    const host = config.host || '';

    // Start the early-return timer IMMEDIATELY — it includes Cinemeta time.
    // This ensures the total response is always under EARLY_RETURN_MS.
    const startTime = Date.now();

    const cleanImdbId = type === 'series' ? String(id).split(':')[0] : id;

    // ===== STREAM RESULT CACHE =====
    // Cache stream results for 30 minutes. This makes repeated requests for
    // the same movie instant (e.g. when user clicks play, then goes back
    // and clicks play again). Critical for Render free tier where providers
    // are slow.
    const STREAM_CACHE_TTL = parseInt(process.env.STREAM_CACHE_TTL_MS || '1800000', 10); // 30 min
    const streamCacheKey = `${type}:${id}`;
    const cached = streamResultCache.get(streamCacheKey);
    if (cached && Date.now() - cached.ts < STREAM_CACHE_TTL) {
        // Return cached streams but update URLs with current host
        console.log(`[HTTP-STREAMS] Cache HIT for ${streamCacheKey} (${cached.streams.length} streams, age=${Math.round((Date.now()-cached.ts)/1000)}s)`);
        const updatedHost = host;
        return cached.streams.map(s => {
            if (s.url && s.url.includes('/resolve/httpstreaming/')) {
                // Re-wrap with current host
                const encodedUrl = s.url.split('/resolve/httpstreaming/')[1];
                return { ...s, url: `${updatedHost}/resolve/httpstreaming/${encodedUrl}` };
            }
            return s;
        });
    }

    // Fetch Cinemeta metadata with a short timeout so it doesn't eat into
    // the providers' time budget
    let cinemetaDetails = null;
    try {
        cinemetaDetails = await Promise.race([
            Cinemeta.getMeta(type, cleanImdbId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Cinemeta timeout')), 3000))
        ]);
        if (cinemetaDetails) console.log(`[HTTP-STREAMS] Cinemeta: "${cinemetaDetails.name}" (${Date.now() - startTime}ms)`);
    } catch (err) {
        console.error(`[HTTP-STREAMS] Cinemeta failed:`, err.message);
    }

    if (!cinemetaDetails || !cinemetaDetails.name) {
        console.log(`[HTTP-STREAMS] No metadata for ${cleanImdbId}`);
        return [];
    }

    const resolverWrapper = streams => {
        const tagged = (streams || []).map(stream => ({ provider: 'httpstreaming', ...stream }));
        return wrapHttpStreamsWithResolver(tagged, host);
    };

    const tasks = [];
    const addTask = (label, searchFn) => {
        tasks.push(
            withTimeout(
                Promise.resolve(searchFn()).then(resolverWrapper),
                getHttpStreamingTimeoutMs(label),
                label
            )
        );
    };

    // All 19 providers
    addTask('4KHDHub', () => get4KHDHubStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('HDHub4u', () => getHDHub4uStreams(cleanImdbId, type, season, episode, cinemetaDetails));
    addTask('MKVCinemas', () => getMKVCinemasStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('CineDoze', () => getCineDozeStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('MoviesMod', () => getMoviesModStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('MoviesLeech', () => getMoviesLeechStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('AnimeFlix', () => getAnimeFlixStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('VixSrc', () => getVixSrcStreams(cleanImdbId, type, season, episode));
    addTask('111477', () => get111477Streams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('XDMovies', () => getXDMoviesStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('CineWave', () => getCineWaveStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('Pahe', () => getPaheStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('DDLBase', () => getDDLBaseStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('MkvBase', () => getMkvBaseStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('AnimePahe', () => getAnimePaheStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('Anikura', () => getAnikuraStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('ZStream', () => getZStreamStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('Anikoto', () => getAnikotoStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('Enma', () => getEnmaStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('SkyMoviesHD', () => getSkyMoviesStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('KMMovies', () => getKMMoviesStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('HDMoviesChannel', () => getHDMoviesChannelStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('Tenies', () => getTeniesStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('Aether', () => getAetherStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('Nima4K', () => getNima4KStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('UHDMovies', () => getUHDMoviesStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('CineFreak', () => getCineFreakStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('MoviesEQ', () => getMoviesEQStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('Miruro', () => getMiruroStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('AniWaves', () => getAniWavesStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('AniWave', () => getAniWaveStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('AcerMovies', () => getAcerMoviesStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('MkvDrama', () => getMkvDramaStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('StreamXTV', () => getStreamXTVStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('PrimeShows', () => getPrimeShowsStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('HiAnime', () => getHiAnimeStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));
    addTask('FlixHQ', () => getFlixHQStreams(cleanImdbId, type, season, episode, config, cinemetaDetails));

    if (tasks.length === 0) return [];

    // Calculate remaining time for early return (account for Cinemeta time already spent)
    const elapsed = Date.now() - startTime;
    const remainingMs = Math.max(2000, EARLY_RETURN_MS - elapsed);
    console.log(`[HTTP-STREAMS] Provider budget: ${remainingMs}ms remaining (Cinemeta took ${elapsed}ms)`);

    // Start all tasks in parallel. Each task is wrapped with withTimeout.
    // We race against an early-return timer: after remainingMs, we collect
    // results from tasks that have already resolved (using a shared array).
    const results = new Array(tasks.length).fill(null);

    // Wrap each task to store its result in the shared array as soon as it finishes
    const trackedPromises = tasks.map((task, i) =>
        task.then(result => { results[i] = result; return result; })
    );

    // Wait for all OR early-return timer, whichever comes first
    await Promise.race([
        Promise.allSettled(trackedPromises),
        new Promise(resolve => setTimeout(resolve, remainingMs))
    ]);

    // Collect whatever results we have so far
    const rawStreams = results
        .filter(r => r !== null && Array.isArray(r))
        .flatMap(r => r)
        .filter(Boolean);

    const settledCount = results.filter(r => r !== null).length;
    console.log(`[HTTP-STREAMS] Collected ${settledCount}/${tasks.length} provider results, ${rawStreams.length} streams in ${Date.now() - startTime}ms total`);

    const finalStreams = postProcessStreams(rawStreams);

    // Cache the result for future requests — only if we got meaningful results
    // (at least 3 streams with playable URLs, not just externalUrl browser links)
    const playableCount = finalStreams.filter(s => s.url).length;
    if (playableCount >= 3) {
        streamResultCache.set(streamCacheKey, { streams: finalStreams, ts: Date.now() });
        console.log(`[HTTP-STREAMS] Cached ${finalStreams.length} streams (${playableCount} playable) for ${streamCacheKey}`);
    } else {
        console.log(`[HTTP-STREAMS] NOT caching — only ${playableCount} playable streams (need ≥3)`);
    }

    return finalStreams;
}

function postProcessStreams(streams) {
    const seen = new Set();
    const result = [];
    // URLs that are known to be broken (return 500 or expired)
    const BROKEN_URL_PATTERNS = [
        'gpdl.hubcloud.cx',    // Redirects to broken rohitkiskk workers.dev (500)
        'pixel.hubcloud.cx',   // Same broken chain
    ];
    for (const s of streams) {
        if (!s) continue;
        const nameTitle = `${s.name || ''} ${s.title || ''}`.toLowerCase();
        if (/donation|donate|sponsor|support us|click here to/i.test(nameTitle)) continue;
        if (!s.url && !s.externalUrl) continue;
        if (s.url) {
            if (!s.url.startsWith('http://') && !s.url.startsWith('https://') && !s.url.startsWith('/resolve/')) continue;
            if (/\/login\.php|\/logout|\/wp-admin/i.test(s.url)) continue;
            // Filter out known-broken URLs (even if wrapped with resolver)
            const urlCheck = decodeURIComponent(s.url);
            if (BROKEN_URL_PATTERNS.some(p => urlCheck.includes(p))) {
                console.log(`[HTTP-STREAMS] Filtering broken URL: ${urlCheck.substring(0, 60)}...`);
                continue;
            }
        }
        if (s.externalUrl) {
            if (BROKEN_URL_PATTERNS.some(p => s.externalUrl.includes(p))) continue;
        }
        // Dedup key: include name so that streams with the same externalUrl but
        // different qualities (e.g., Pahe 480p/720p/1080p all pointing to the
        // same post page) are NOT deduplicated away.
        const dedupKey = `${s.name || ''}::${s.url || s.externalUrl}`;
        if (dedupKey && seen.has(dedupKey)) continue;
        if (dedupKey) seen.add(dedupKey);
        if (!s.behaviorHints) s.behaviorHints = {};
        if (s.url && !s.externalUrl) s.behaviorHints.notWebReady = true;
        result.push(s);
    }
    return result;
}
