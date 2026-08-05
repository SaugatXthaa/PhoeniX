/**
 * Embed URL Resolver
 *
 * Extracts direct video URLs (m3u8/mp4) from embed pages that expose them
 * in their HTML source. Supports common patterns:
 *   - sources: [{ file: 'https://...master.m3u8' }]  (vidmoly, vidplay, etc.)
 *   - file: 'https://...m3u8'
 *   - <video><source src="https://...mp4"></video>
 *   - Direct .m3u8 or .mp4 URLs in JavaScript
 *
 * For embed pages that require JS execution (React SPAs, CF-protected pages),
 * returns null — the caller should fall back to externalUrl.
 */

import { makeRequest } from '../utils/http.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Patterns to extract video URLs from embed page HTML
const VIDEO_PATTERNS = [
    // JW Player / Video.js: sources: [{ file: 'URL' }]
    /sources:\s*\[\s*\{[^}]*file:\s*['"]([^'"]+)['"][^}]*\}/gi,
    // file: 'URL' (single file)
    /file:\s*['"]([^'"]+\.(?:m3u8|mp4|mkv)[^'"]*)['"]/gi,
    // <source src="URL">
    /<source[^>]+src=["']([^"']+)["']/gi,
    // Direct .m3u8 or .mp4 URL in JS string
    /['"](https?:\/\/[^'"]*\.(?:m3u8|mp4)[^'"]*)['"]/gi,
];

// Hosts that are known to be unresolvable (React SPAs, CF-protected, require JS)
const UNRESOLVABLE_HOSTS = [
    'gn1r5n.org',      // React SPA with credentials API
    'playmogo.com',    // Redirects to DoodStream (turnstile captcha)
    'vsembed.ru',      // Cloudflare-protected
    'vidsrc.mov',      // Redirects to vsembed.ru
    'vidsrc.to',       // Redirects to vsembed.ru
    'vidsrc.in',       // Redirects to vsembed.ru
    'vidsrc.fyi',      // Redirects to vsembed.ru
    'vidrock.net',     // CF-protected
    'vidking.net',     // CF-protected
    'vixsrc.to',       // CF-protected
    'vidlink.pro',     // React SPA (Next.js)
    'vidfast.pro',     // React SPA (Next.js)
    'vidup.to',        // React SPA (Next.js)
    'player.videasy.net', // React SPA (Next.js)
    '111movies.com',   // CF-protected
    'multiembed.mov',  // CF-protected
    'superflixapi.co', // CF-protected
    'peachify.top',    // CF-protected
    '2embed.cc',       // Redirects to streamsrcs → cineby (dead)
    'cineby.hair',     // Dead
    'megaplay.buzz',   // Obfuscated JS player
    'anikototv.to',    // React SPA
    'anikoto.cz',      // React SPA
    'miruro.to',       // CF-protected
    'aniwaves.ru',     // CF-protected
    'aniwave.dk',      // CF-protected
    'aniwave.lu',      // CF-protected
    'vidnest.fun',     // React SPA (Next.js) — no m3u8 in HTML
];

// Hosts that require Referer header for video playback
const REFERER_HOSTS = [
    'vidmoly.biz',
    'vmpx.online',
    'vmwesa.online',
];

function isUnresolvable(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return UNRESOLVABLE_HOSTS.some(h => hostname.includes(h));
    } catch {
        return false;
    }
}

/**
 * Try to extract a direct video URL from an embed page.
 * @param {string} embedUrl - The embed page URL
 * @returns {Promise<string|null>} - Direct video URL (m3u8/mp4) or null
 */
export async function resolveEmbedUrl(embedUrl) {
    if (!embedUrl) return null;

    // Fast check: if URL is already a direct video URL, return it
    if (/\.(m3u8|mp4|mkv)(\?|$)/i.test(embedUrl)) {
        return embedUrl;
    }

    // Skip known unresolvable hosts
    if (isUnresolvable(embedUrl)) {
        return null;
    }

    try {
        const response = await makeRequest(embedUrl, {
            timeout: 12000,
            maxRetries: 0,
            headers: {
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': embedUrl
            }
        });

        if (response.statusCode !== 200 || !response.body) {
            return null;
        }

        const html = response.body;

        // Try each pattern to extract a video URL
        for (const pattern of VIDEO_PATTERNS) {
            const matches = [...html.matchAll(pattern)];
            for (const match of matches) {
                const url = match[1];
                if (!url) continue;
                // Validate: must be http(s) and end with m3u8/mp4 or contain them
                if (!url.startsWith('http://') && !url.startsWith('https://')) continue;
                // Skip non-video files (images, API endpoints, etc.)
                if (/\.(jpg|jpeg|png|gif|webp|css|js|woff|svg)(\?|$)/i.test(url)) continue;
                // Check if it looks like a video URL
                if (/\.(m3u8|mp4|mkv|webm|avi)(\?|$)/i.test(url) || url.includes('master.m3u8') || url.includes('/hls/') || url.includes('/stream/')) {
                    console.log(`[EMBED-RESOLVE] Extracted: ${url.substring(0, 100)}...`);
                    return url;
                }
            }
        }

        // No video URL found
        return null;
    } catch (err) {
        console.log(`[EMBED-RESOLVE] Failed for ${embedUrl.substring(0, 60)}: ${err.message}`);
        return null;
    }
}

/**
 * Check if an embed URL can potentially be resolved to a direct video URL.
 * Used by providers to decide whether to use `url` (resolver-wrapped) or `externalUrl`.
 */
export function isEmbedResolvable(embedUrl) {
    if (!embedUrl) return false;
    if (/\.(m3u8|mp4|mkv)(\?|$)/i.test(embedUrl)) return true;
    return !isUnresolvable(embedUrl);
}

/**
 * Get proxy headers for a resolved video URL.
 * Some CDNs require a Referer header to allow playback.
 */
export function getEmbedProxyHeaders(videoUrl, embedUrl) {
    const headers = {};
    if (!videoUrl) return headers;
    const lower = videoUrl.toLowerCase();
    // Vidmoly CDN requires Referer from vidmoly.biz
    if (lower.includes('vmpx.online') || lower.includes('vmwesa.online') || lower.includes('vidmoly')) {
        headers.request = { Referer: 'https://vidmoly.biz/' };
    }
    return Object.keys(headers).length ? headers : undefined;
}
