/**
 * ZStream Streams Provider
 *
 * ZStream (zstream.mov) is a p-stream fork that uses TMDB for metadata
 * and scrapes streams from multiple providers.
 *
 * API: https://api.balloonerismm.workers.dev (TMDB proxy)
 * TMDB key: 84259f99204eeb7d45c7e3d8e36c6123
 *
 * The actual stream scraping happens client-side in the browser (p-stream
 * requires a browser extension or CORS proxy). However, zstream.mov also
 * provides a FED API for trailers and some stream sources.
 *
 * This provider uses the TMDB proxy API to get metadata and returns
 * the zstream.mov watch URL as an externalUrl (iframe embed).
 * Nuvio/Stremio can open this in a webview for the user to play.
 */

import Cinemeta from '../../../util/cinemeta.js';
import { makeRequest } from '../../utils/http.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { getResolutionFromName } from '../../utils/parsing.js';

const PROVIDER = 'ZStream';
const TMDB_API_BASE = process.env.ZSTREAM_API_BASE || 'https://api.balloonerismm.workers.dev';
const TMDB_API_KEY = process.env.ZSTREAM_TMDB_KEY || '84259f99204eeb7d45c7e3d8e36c6123';
const ZSTREAM_URL = 'https://zstream.mov';
const API_TIMEOUT = parseInt(process.env.ZSTREAM_TIMEOUT || '12000', 10);

/**
 * Get TMDB ID from Cinemeta metadata
 */
function resolveTmdbId(meta) {
    if (!meta) return null;
    const candidates = [
        meta.moviedb_id, meta.moviedbId, meta.tmdb_id, meta.tmdbId
    ];
    if (meta.ids) {
        if (Array.isArray(meta.ids)) candidates.push(...meta.ids);
        else if (typeof meta.ids === 'object') candidates.push(...Object.values(meta.ids));
    }
    for (const c of candidates) {
        if (!c) continue;
        const str = String(c).trim();
        if (/^\d{3,}$/.test(str)) return str;
        const m = str.match(/tmdb[^0-9]*([0-9]{3,})/i) || str.match(/\/(?:movie|tv)\/([0-9]{3,})/i);
        if (m?.[1]) return m[1];
    }
    return null;
}

/**
 * Search TMDB via ZStream's proxy API
 */
async function searchTmdb(query, type) {
    try {
        const searchType = type === 'series' ? 'tv' : 'movie';
        const url = `${TMDB_API_BASE}/search/${searchType}?query=${encodeURIComponent(query)}&api_key=${TMDB_API_KEY}`;
        const response = await makeRequest(url, {
            timeout: API_TIMEOUT,
            maxRetries: 0,
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });

        if (response.statusCode !== 200) return [];
        const data = JSON.parse(response.body);
        return (data.results || []).map(r => ({
            id: r.id,
            title: r.title || r.name,
            year: r.release_date ? new Date(r.release_date).getFullYear() :
                  r.first_air_date ? new Date(r.first_air_date).getFullYear() : null,
            overview: r.overview
        }));
    } catch (e) {
        return [];
    }
}

/**
 * Main entry: get ZStream streams
 * Returns externalUrl (iframe embed) for Nuvio to open in webview
 */
export async function getZStreamStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        let meta = prefetchedMeta;
        if (!meta) {
            meta = await Cinemeta.getMeta(type, imdbId);
        }
        if (!meta?.name) return [];

        const tmdbId = resolveTmdbId(meta);
        if (!tmdbId) {
            // Search TMDB
            const results = await searchTmdb(meta.name, type);
            if (results.length === 0) return [];
            tmdbId = results[0].id;
        }

        // Build zstream.mov watch URL
        // zstream.mov uses /movie/<tmdbId> or /tv/<tmdbId>/<season>/<episode>
        let watchUrl;
        if (type === 'series' && season && episode) {
            watchUrl = `${ZSTREAM_URL}/tv/${tmdbId}/${season}/${episode}`;
        } else {
            watchUrl = `${ZSTREAM_URL}/movie/${tmdbId}`;
        }

        console.log(`[${PROVIDER}] Returning embed URL: ${watchUrl}`);

        // Return as externalUrl — Nuvio opens it in a webview
        // The zstream.mov webview has its own player with source picking
        return [{
            name: `PhoeniX\nZStream`,
            title: `${meta.name}${type === 'series' ? ` S${season}E${episode}` : ''}\n🔗 ZStream (embed)`,
            externalUrl: watchUrl,
            behaviorHints: {
                bingeGroup: 'phoenix-zstream'
            }
        }];
    } catch (error) {
        console.log(`[${PROVIDER}] Error: ${error.message}`);
        return [];
    }
}
