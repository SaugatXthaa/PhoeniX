/**
 * AcerMovies Provider (acermovies.fun)
 * Reverse-engineered API: POST /api/search, POST /api/sourceUrl, POST /api/sourceQuality
 * API returns 405 for direct POST — needs specific headers or session
 * Returns embed URL for Nuvio webview
 * Supports movies, series, anime, kdramas
 */

import Cinemeta from '../../../util/cinemeta.js';

const PROVIDER = 'AcerMovies';
const BASE_URL = (process.env.ACERMOVIES_BASE_URL || 'https://acermovies.fun').replace(/\/+$/, '');

export async function getAcerMoviesStreams(imdbId, type, season, episode, config, prefetchedMeta) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];

        // Acer Movies API requires session auth — return embed URL
        const searchUrl = `${BASE_URL}/?q=${encodeURIComponent(meta.name)}`;
        console.log(`[${PROVIDER}] Returning embed: ${searchUrl}`);
        return [{
            name: `PhoeniX\nAcerMovies`,
            title: `${meta.name}${type === 'series' ? ` S${season}E${episode}` : ''}\n🔗 AcerMovies (embed)`,
            externalUrl: searchUrl,
            behaviorHints: { bingeGroup: 'phoenix-acermovies' }
        }];
    } catch { return []; }
}
