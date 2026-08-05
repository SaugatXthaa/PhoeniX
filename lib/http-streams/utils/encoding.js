// lib/http-streams/utils/encoding.js
// Faithful port of sootio-stremio-addon/lib/http-streams/utils/encoding.js

import { URL } from 'url';

export function base64Decode(str) {
    return Buffer.from(str, 'base64').toString('utf-8');
}

export function base64Encode(str) {
    return Buffer.from(str, 'utf-8').toString('base64');
}

export function rot13(str) {
    return str.replace(/[A-Za-z]/g, function(char) {
        const start = char <= 'Z' ? 65 : 97;
        return String.fromCharCode(((char.charCodeAt(0) - start + 13) % 26) + start);
    });
}

export function tryDecodeBase64(str) {
    try {
        if (str && str.length > 20 && /^[A-Za-z0-9+/=]+$/.test(str) && !str.includes(' ')) {
            const decoded = base64Decode(str);
            if (!/[^\x20-\x7E]/.test(decoded)) {
                return decoded;
            }
        }
    } catch (e) {
        // Not a valid base64 string
    }
    return str;
}

export function encodeUrlForStreaming(url) {
    if (!url) return url;

    // Don't re-encode already encoded URLs
    if (url.includes('%')) {
        return url;
    }

    try {
        const urlObj = new URL(url);
        return urlObj.toString();
    } catch (e) {
        return url
            .replace(/ /g, '%20')
            .replace(/#/g, '%23')
            .replace(/\[/g, '%5B')
            .replace(/\]/g, '%5D')
            .replace(/{/g, '%7B')
            .replace(/}/g, '%7D');
    }
}
