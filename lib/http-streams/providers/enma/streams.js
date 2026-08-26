/**
 * Enma Streams Provider (enma.lol)
 * The API encrypts all responses — can't decrypt server-side.
 * Returns externalUrl (embed) for Nuvio webview.
 * Anime-only (series).
 */

import Cinemeta from '../../../util/cinemeta.js';

const PROVIDER = 'Enma';
const BASE_URL = (process.env.ENMA_BASE_URL || 'https://www.enma.lol').replace(/\/+$/, '');

export async function getEnmaStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        if (type !== 'series' && type !== 'tv') return [];
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];

        const requestedEpisode = episode ? parseInt(episode) : 1;
        // Return search URL — Nuvio opens it in webview, user picks anime and episode
        const searchUrl = `${BASE_URL}/anime?query=${encodeURIComponent(meta.name)}`;
        console.log(`[${PROVIDER}] Returning embed URL: ${searchUrl}`);

        return [{
            name: `PhoeniX\nEnma`,
            title: `${meta.name} - Episode ${requestedEpisode}\n🔗 Enma (embed)`,
            externalUrl: searchUrl,
            behaviorHints: { bingeGroup: 'phoenix-enma' }
        }];
    } catch (error) { return []; }
}
