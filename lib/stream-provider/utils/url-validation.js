// lib/stream-provider/utils/url-validation.js
// Wraps HTTP streaming URLs with the resolver endpoint for lazy resolution
// Faithful port of sootio-stremio-addon/lib/stream-provider/utils/url-validation.js

import { isEmbedResolvable } from '../../http-streams/resolvers/embed-resolver.js';

// URLs that need to go through the resolver (redirectors, not direct video)
const RESOLVER_REQUIRED_HOSTS = [
    'gpdl.hubcloud.cx',    // HubCloud redirector → workers.dev → Google UserContent
    'pixel.hubcloud.cx',   // HubCloud redirector → workers.dev → Google UserContent
    'hubcloud.ist',        // HubCloud page → gamerxyt → workers.dev
    'hubcloud.cx',         // HubCloud page
    'hubdrive.tips',       // HubDrive page → HubCloud
    'gadgetsweb.xyz',      // Encrypted redirect → HubCloud
    'gamerxyt.com',        // HubCloud download page → workers.dev
];

// URLs that are direct video URLs (no resolution needed)
const DIRECT_VIDEO_HOSTS = [
    'workers.dev',         // Cloudflare Workers CDN (direct video, but needs Referer)
    'fileshubcdn',         // FileShub CDN
    'pixeldrain',          // PixelDrain direct
    'fsl-buckets',         // FSL CDN
    'fsl.gigabytes',       // FSL CDN
    'googleusercontent',   // Google CDN (direct but expires)
    'r2.dev',              // R2 CDN
    'hubcdn.fans',         // HubCDN
    'amazon',              // AWS CDN
    'hotstar',             // Hotstar CDN
    'goldmine-server',     // GoldMine CDN
    'cloudserver',         // Cloud Server CDN
];

function needsResolverWrap(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    // Already a resolver URL
    if (lower.includes('/resolve/httpstreaming/')) return false;
    // Check if it's a direct video URL
    if (DIRECT_VIDEO_HOSTS.some(h => lower.includes(h))) return false;
    // Check if it needs resolution
    return RESOLVER_REQUIRED_HOSTS.some(h => lower.includes(h));
}

export function wrapHttpStreamsWithResolver(streams, addonHost) {
    const base = addonHost || '';

    if (!streams || !Array.isArray(streams)) return [];

    return streams.map(stream => {
        const normalizedStream = {
            ...stream,
            httpProvider: stream?.httpProvider || stream?.provider || 'httpstreaming',
            provider: 'httpstreaming'
        };

        // Check if this stream needs lazy resolution (preview streams)
        if (normalizedStream.needsResolution && normalizedStream.url) {
            const encodedUrl = encodeURIComponent(normalizedStream.url);
            const resolverUrl = (base && base.startsWith('http'))
                ? `${base}/resolve/httpstreaming/${encodedUrl}`
                : normalizedStream.url;

            return {
                ...normalizedStream,
                url: resolverUrl,
                needsResolution: undefined
            };
        }

        // Auto-wrap HubCloud redirector URLs with the resolver.
        // These URLs (gpdl.hubcloud.cx, pixel.hubcloud.cx, hubcloud.ist) are 302
        // redirectors, NOT direct video URLs. If returned as-is, the player gets
        // HTML pages → "fully watched" / 403 / "unrecognized format".
        if (normalizedStream.url && !normalizedStream.externalUrl && needsResolverWrap(normalizedStream.url)) {
            const encodedUrl = encodeURIComponent(normalizedStream.url);
            const resolverUrl = (base && base.startsWith('http'))
                ? `${base}/resolve/httpstreaming/${encodedUrl}`
                : normalizedStream.url;
            return {
                ...normalizedStream,
                url: resolverUrl,
                behaviorHints: {
                    ...normalizedStream.behaviorHints,
                    notWebReady: true
                }
            };
        }

        // Convert externalUrl → url for embed pages that CAN be resolved server-side.
        if (normalizedStream.externalUrl && !normalizedStream.url) {
            const embedUrl = normalizedStream.externalUrl;
            if (isEmbedResolvable(embedUrl)) {
                const encodedUrl = encodeURIComponent(embedUrl);
                const resolverUrl = (base && base.startsWith('http'))
                    ? `${base}/resolve/httpstreaming/${encodedUrl}`
                    : embedUrl;
                return {
                    ...normalizedStream,
                    url: resolverUrl,
                    externalUrl: undefined,
                    behaviorHints: {
                        ...normalizedStream.behaviorHints,
                        notWebReady: true
                    }
                };
            }
        }

        return normalizedStream;
    });
}

export function isValidUrl(url) {
    return url &&
        typeof url === 'string' &&
        url !== 'undefined' &&
        url !== 'null' &&
        url.length > 0 &&
        (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('magnet:') || url.startsWith('/resolve/'));
}

export function isVideo(filename) {
    if (!filename || typeof filename !== 'string') return false;
    const exts = ['.mp4','.mkv','.avi','.mov','.wmv','.flv','.webm','.m4v','.mpg','.mpeg','.3gp','.ogv','.ts','.m2ts'];
    const i = filename.toLowerCase().lastIndexOf('.');
    if (i < 0) return false;
    return exts.includes(filename.toLowerCase().substring(i));
}
