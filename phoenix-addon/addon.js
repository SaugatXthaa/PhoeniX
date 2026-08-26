// addon.js
// Stremio addon interface — defines stream handler that delegates to stream-provider
// Faithful port of sootio-stremio-addon/addon.js (simplified — no debrid, no catalogs)

import { addonBuilder } from 'stremio-addon-sdk';
import { getHttpStreamingStreams } from './lib/stream-provider/alternative-services/http-streams.js';

const builder = new addonBuilder({
    id: 'community.phoenix.addon',
    version: '3.0.0',
    name: process.env.ADDON_NAME || 'PhoeniX',
    description: 'PhoeniX — Nuvio/Stremio streaming addon, faithful port of sootio HTTPS sources',
    logo: 'https://i.imgur.com/mDU8KgH.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
});

function enrichCacheParams(hasResults = true) {
    if (!hasResults) {
        return { cacheMaxAge: 0, staleRevalidate: 0, staleError: 0 };
    }
    return {
        cacheMaxAge: 60 * 60,           // 1 hour
        staleRevalidate: 4 * 60 * 60,   // 4 hours
        staleError: 7 * 24 * 60 * 60    // 7 days
    };
}

builder.defineStreamHandler(args => {
    return new Promise((resolve) => {
        if (!args.id || !args.id.match(/tt\d+/i)) {
            resolve({ streams: [], ...enrichCacheParams(false) });
            return;
        }

        const config = args.config || {};
        config.host = args.config?.host || '';

        const type = args.type;
        const id = args.id;

        if (type !== 'movie' && type !== 'series') {
            resolve({ streams: [], ...enrichCacheParams(false) });
            return;
        }

        const season = type === 'series' ? (id.split(':')[1] || null) : null;
        const episode = type === 'series' ? (id.split(':')[2] || null) : null;

        getHttpStreamingStreams(config, type, id, { season, episode })
            .then(streams => {
                resolve({
                    streams: streams || [],
                    ...enrichCacheParams((streams || []).length > 0)
                });
            })
            .catch(err => {
                console.error('[PhoeniX] Stream handler error:', err.message);
                resolve({ streams: [], ...enrichCacheParams(false) });
            });
    });
});

export default builder;
