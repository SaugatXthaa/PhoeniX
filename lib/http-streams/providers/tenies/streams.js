/**
 * Tenies Provider (tenies.site)
 * Uses streamfree.top API for live sports streams
 * Also has movies/series via TMDB API
 * Returns embed URL for Nuvio webview
 */

import Cinemeta from '../../../util/cinemeta.js';

const PROVIDER = 'Tenies';
const BASE_URL = (process.env.TENIES_BASE_URL || 'https://www.tenies.site').replace(/\/+$/, '');

export async function getTeniesStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];

        // tenies.site is a movie/series site — return embed URL
        let watchUrl;
        if (type === 'series' && season && episode) {
            watchUrl = `${BASE_URL}/watch?q=${encodeURIComponent(meta.name)}&s=${season}&e=${episode}`;
        } else {
            watchUrl = `${BASE_URL}/watch?q=${encodeURIComponent(meta.name)}`;
        }

        console.log(`[${PROVIDER}] Returning embed: ${watchUrl}`);
        return [{
            name: `PhoeniX\nTenies`,
            title: `${meta.name}${type === 'series' ? ` S${season}E${episode}` : ''}\n🔗 Tenies (embed)`,
            externalUrl: watchUrl,
            behaviorHints: { bingeGroup: 'phoenix-tenies' }
        }];
    } catch (error) { return []; }
}
