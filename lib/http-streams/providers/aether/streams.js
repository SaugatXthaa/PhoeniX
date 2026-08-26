/**
 * Aether Provider (aether.cx)
 * SPA using backend.aether.bar API (returns 404 for all endpoints — needs client-side auth)
 * Returns embed URL for Nuvio webview
 * Supports movies, series, anime, kdramas
 */

import Cinemeta from '../../../util/cinemeta.js';

const PROVIDER = 'Aether';
const BASE_URL = (process.env.AETHER_BASE_URL || 'https://aether.cx').replace(/\/+$/, '');

export async function getAetherStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];

        // Build aether.cx watch URL
        let watchUrl;
        if (type === 'series' && season && episode) {
            watchUrl = `${BASE_URL}/watch/${imdbId}/${season}/${episode}`;
        } else {
            watchUrl = `${BASE_URL}/watch/${imdbId}`;
        }

        console.log(`[${PROVIDER}] Returning embed: ${watchUrl}`);
        return [{
            name: `PhoeniX\nAether`,
            title: `${meta.name}${type === 'series' ? ` S${season}E${episode}` : ''}\n🔗 Aether (embed)`,
            externalUrl: watchUrl,
            behaviorHints: { bingeGroup: 'phoenix-aether' }
        }];
    } catch (error) { return []; }
}
