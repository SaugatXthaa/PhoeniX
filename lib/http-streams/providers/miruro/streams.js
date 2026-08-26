/**
 * Miruro Provider (miruro.to) — Anime streaming
 * Cloudflare-protected (403) — returns embed URL
 * Anime-only (series)
 */

import Cinemeta from '../../../util/cinemeta.js';

const PROVIDER = 'Miruro';
const BASE_URL = (process.env.MIRURO_BASE_URL || 'https://miruro.to').replace(/\/+$/, '');

export async function getMiruroStreams(imdbId, type, season, episode, config, prefetchedMeta) {
    try {
        if (type !== 'series' && type !== 'tv') return [];
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];

        const requestedEpisode = episode ? parseInt(episode) : 1;
        // Return search URL — miruro.to is CF-protected
        const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(meta.name)}`;
        console.log(`[${PROVIDER}] Returning embed: ${searchUrl}`);
        return [{
            name: `PhoeniX\nMiruro`,
            title: `${meta.name} - Episode ${requestedEpisode}\n🔗 Miruro (anime embed)`,
            externalUrl: searchUrl,
            behaviorHints: { bingeGroup: 'phoenix-miruro' }
        }];
    } catch { return []; }
}
