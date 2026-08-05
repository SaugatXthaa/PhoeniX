// lib/stream-provider/utils/url-validation.js
// Wraps HTTP streaming URLs with the resolver endpoint for lazy resolution
// Faithful port of sootio-stremio-addon/lib/stream-provider/utils/url-validation.js

export function wrapHttpStreamsWithResolver(streams, addonHost) {
    const base = addonHost || '';

    if (!streams || !Array.isArray(streams)) return [];

    return streams.map(stream => {
        const normalizedStream = {
            ...stream,
            httpProvider: stream?.httpProvider || stream?.provider || 'httpstreaming',
            provider: 'httpstreaming'
        };

        // Check if this stream needs lazy resolution
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
