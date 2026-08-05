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
    getMkvDramaStreams
} from '../../http-streams/index.js';
import { getVixSrcStreams } from '../../http-streams/index.js';
import { wrapHttpStreamsWithResolver } from '../utils/url-validation.js';

const DEFAULT_TIMEOUT_MS = parseInt(process.env.HTTP_STREAMING_TIMEOUT_MS || '12000', 10);

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
        'HDHub4u': parseInt(process.env.HTTP_HDHUB4U_TIMEOUT || '30000', 10),
        'MKVCinemas': parseInt(process.env.HTTP_MKVCINEMAS_TIMEOUT || '20000', 10),
        'MoviesMod': parseInt(process.env.HTTP_MOVIESMOD_TIMEOUT || '30000', 10),
        'MoviesLeech': parseInt(process.env.HTTP_MOVIESLEECH_TIMEOUT || '30000', 10),
        'AnimeFlix': parseInt(process.env.HTTP_ANIMEFLIX_TIMEOUT || '20000', 10),
        'VixSrc': parseInt(process.env.HTTP_VIXSRC_TIMEOUT || '8000', 10),
        '111477': parseInt(process.env.HTTP_111477_TIMEOUT || '10000', 10),
        'XDMovies': parseInt(process.env.HTTP_XDMOVIES_TIMEOUT || '15000', 10),
        'CineWave': parseInt(process.env.HTTP_CINEWAVE_TIMEOUT || '30000', 10),
        'CineDoze': parseInt(process.env.HTTP_CINEDOZE_TIMEOUT || '30000', 10),
        'Pahe': parseInt(process.env.HTTP_PAHE_TIMEOUT || '15000', 10),
        'DDLBase': parseInt(process.env.HTTP_DDLBASE_TIMEOUT || '30000', 10),
        'MkvBase': parseInt(process.env.HTTP_MKVBASE_TIMEOUT || '30000', 10),
        'AnimePahe': parseInt(process.env.HTTP_ANIMEPAHE_TIMEOUT || '30000', 10),
        'Anikura': parseInt(process.env.HTTP_ANIKURA_TIMEOUT || '15000', 10),
        'ZStream': parseInt(process.env.HTTP_ZSTREAM_TIMEOUT || '12000', 10),
        'Anikoto': parseInt(process.env.HTTP_ANIKOTO_TIMEOUT || '12000', 10),
        'Enma': parseInt(process.env.HTTP_ENMA_TIMEOUT || '10000', 10),
        'SkyMoviesHD': parseInt(process.env.HTTP_SKYMOVIES_TIMEOUT || '15000', 10),
        'KMMovies': parseInt(process.env.HTTP_KMMOVIES_TIMEOUT || '30000', 10),
        'HDMoviesChannel': parseInt(process.env.HTTP_HDMOVIESCHANNEL_TIMEOUT || '15000', 10),
        'Tenies': parseInt(process.env.HTTP_TENIES_TIMEOUT || '8000', 10),
        'Aether': parseInt(process.env.HTTP_AETHER_TIMEOUT || '8000', 10),
        'Nima4K': parseInt(process.env.HTTP_NIMA4K_TIMEOUT || '15000', 10),
        'UHDMovies': parseInt(process.env.HTTP_UHDMOVIES_TIMEOUT || '15000', 10),
        'CineFreak': parseInt(process.env.HTTP_CINEFREAK_TIMEOUT || '15000', 10),
        'MoviesEQ': parseInt(process.env.HTTP_MOVIESEQ_TIMEOUT || '12000', 10),
        'Miruro': parseInt(process.env.HTTP_MIRURO_TIMEOUT || '8000', 10),
        'AniWaves': parseInt(process.env.HTTP_ANIWAVES_TIMEOUT || '12000', 10),
        'AniWave': parseInt(process.env.HTTP_ANIWAVE_TIMEOUT || '12000', 10),
        'AcerMovies': parseInt(process.env.HTTP_ACERMOVIES_TIMEOUT || '8000', 10),
        'MkvDrama': parseInt(process.env.HTTP_MKVDRAMA_TIMEOUT || '30000', 10)
    };
    return overrides[label] || DEFAULT_TIMEOUT_MS;
}

export async function getHttpStreamingStreams(config, type, id, options = {}) {
    const { season = null, episode = null } = options;
    const host = config.host || '';

    const cleanImdbId = type === 'series' ? String(id).split(':')[0] : id;
    let cinemetaDetails = null;
    try {
        cinemetaDetails = await Cinemeta.getMeta(type, cleanImdbId);
        if (cinemetaDetails) console.log(`[HTTP-STREAMS] Cinemeta: "${cinemetaDetails.name}"`);
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

    if (tasks.length === 0) return [];

    const settled = await Promise.allSettled(tasks);

    const rawStreams = settled
        .filter(result => result.status === 'fulfilled')
        .flatMap(result => (Array.isArray(result.value) ? result.value : []))
        .filter(Boolean);

    return postProcessStreams(rawStreams);
}

function postProcessStreams(streams) {
    const seen = new Set();
    const result = [];
    for (const s of streams) {
        if (!s) continue;
        const nameTitle = `${s.name || ''} ${s.title || ''}`.toLowerCase();
        if (/donation|donate|sponsor|support us|click here to/i.test(nameTitle)) continue;
        if (!s.url && !s.externalUrl) continue;
        if (s.url) {
            if (!s.url.startsWith('http://') && !s.url.startsWith('https://') && !s.url.startsWith('/resolve/')) continue;
            if (/\/login\.php|\/logout|\/wp-admin/i.test(s.url)) continue;
        }
        const dedupKey = s.url || s.externalUrl;
        if (dedupKey && seen.has(dedupKey)) continue;
        if (dedupKey) seen.add(dedupKey);
        if (!s.behaviorHints) s.behaviorHints = {};
        if (s.url && !s.externalUrl) s.behaviorHints.notWebReady = true;
        result.push(s);
    }
    return result;
}
