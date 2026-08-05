/**
 * Tenies Provider (tenies.site)
 * Movie + TV + Anime site using TMDB for metadata and vidsrc.in for embedding
 * Returns embed URL (vidsrc.in) for Nuvio webview
 * Supports movies, series, anime, kdramas
 *
 * Pattern from script.js:
 *   Movie: https://vidsrc.in/embed/movie/<tmdb_id>
 *   TV:    https://vidsrc.in/embed/tv/<tmdb_id>/<season>-<episode>
 */

import Cinemeta from '../../../util/cinemeta.js';

const PROVIDER = 'Tenies';
const VIDSRC_BASE = 'https://vidsrc.in/embed';

export async function getTeniesStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];

        // Get TMDB ID from meta
        const tmdbId = meta.moviedb_id || meta.tmdb_id || meta.moviedbId || meta.tmdbId;
        if (!tmdbId) {
            console.log(`[${PROVIDER}] No TMDB ID for ${imdbId}`);
            return [];
        }

        // Build vidsrc embed URL
        let embedUrl;
        if (type === 'series' && season && episode) {
            embedUrl = `${VIDSRC_BASE}/tv/${tmdbId}/${season}-${episode}`;
        } else {
            embedUrl = `${VIDSRC_BASE}/movie/${tmdbId}`;
        }

        console.log(`[${PROVIDER}] Returning embed: ${embedUrl}`);
        return [{
            name: `PhoeniX\nTenies`,
            title: `${meta.name}${type === 'series' ? ` S${season}E${episode}` : ''}\n🔗 Tenies (vidsrc embed)`,
            externalUrl: embedUrl,
            behaviorHints: { bingeGroup: 'phoenix-tenies' }
        }];
    } catch (error) {
        console.log(`[${PROVIDER}] Error: ${error.message}`);
        return [];
    }
}
