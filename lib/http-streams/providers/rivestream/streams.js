/**
 * RiveStream Provider (rivestream.ru)
 * Next.js SPA with scrapper API at scrapper.rivestream.app
 * API returns null for embed/stream queries — only torrent search works
 * Returns embed URL for Nuvio webview
 * Supports movies, series, anime, kdramas
 */

import Cinemeta from '../../../util/cinemeta.js';
import { makeRequest } from '../../utils/http.js';

const PROVIDER = 'RiveStream';
const BASE_URL = (process.env.RIVESTREAM_BASE_URL || 'https://rivestream.ru').replace(/\/+$/, '');

export async function getRiveStreamStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];

        // Build rivestream watch URL
        // rivestream.ru uses /watch?type=movie&id=<imdb> or /watch?type=tv&id=<imdb>&s=<season>&e=<episode>
        const contentType = type === 'series' ? 'tv' : 'movie';
        let watchUrl;
        if (type === 'series' && season && episode) {
            watchUrl = `${BASE_URL}/watch?type=${contentType}&id=${imdbId}&s=${season}&e=${episode}`;
        } else {
            watchUrl = `${BASE_URL}/watch?type=${contentType}&id=${imdbId}`;
        }

        console.log(`[${PROVIDER}] Returning embed: ${watchUrl}`);
        return [{
            name: `PhoeniX\nRiveStream`,
            title: `${meta.name}${type === 'series' ? ` S${season}E${episode}` : ''}\n🔗 RiveStream (embed)`,
            externalUrl: watchUrl,
            behaviorHints: { bingeGroup: 'phoenix-rivestream' }
        }];
    } catch (error) { return []; }
}
