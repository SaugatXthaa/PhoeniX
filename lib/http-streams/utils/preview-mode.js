/**
 * Preview Mode Utilities
 * Enables fast preview results by deferring extraction/validation until user clicks
 */

import { getResolutionFromName } from './parsing.js';

/**
 * Feature flag to enable/disable lazy loading
 * Default: disabled unless explicitly enabled.
 */
export function isLazyLoadEnabled() {
    // Default ON; allow explicit opt-out with ENABLE_HTTP_STREAM_LAZY_LOAD=false
    return process.env.ENABLE_HTTP_STREAM_LAZY_LOAD !== 'false';
}

/**
 * Extracts quality information from link text/label
 * @param {string} text - Link text or label
 * @returns {string} Quality label (4k, 1080p, 720p, etc)
 */
export function parseQualityFromText(text) {
    if (!text) return 'auto';

    const resolution = getResolutionFromName(text);

    if (resolution === '2160p') return '4k';
    if (resolution === '1080p') return '1080p';
    if (resolution === '720p') return '720p';
    if (resolution === '540p') return '540p';
    if (resolution === '480p') return '480p';

    return 'auto';
}

/**
 * Extracts size information from link text/label
 * @param {string} text - Link text or label
 * @returns {string|null} Size string (e.g., "2.5 GB")
 */
export function parseSizeFromText(text) {
    if (!text) return null;

    const sizeMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)/i);
    if (sizeMatch) {
        return `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}`;
    }

    return null;
}

/**
 * Extracts codec information from link text/label
 * @param {string} text - Link text or label
 * @returns {string} Codec info or empty string
 */
export function parseCodecFromText(text) {
    if (!text) return '';

    const codecs = [];

    if (/H\.?265|HEVC|x265/i.test(text)) {
        codecs.push('H265');
    } else if (/H\.?264|AVC|x264/i.test(text)) {
        codecs.push('H264');
    }

    if (/10.?bit/i.test(text)) {
        codecs.push('10bit');
    }

    return codecs.join(' ');
}

/**
 * Attempts to extract a plausible video filename from a label
 * @param {string} label - Label text that may contain a filename
 * @returns {string|null} The extracted filename (with extension) if present
 */
function extractFilenameFromLabel(label) {
    if (!label) return null;

    // Remove trailing host/extra info in square brackets (e.g., "[PixelDrain]")
    const cleaned = label.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
    const match = cleaned.match(/([\w\s().-]+\.(?:mkv|mp4|avi|mov|wmv|mpg|mpeg|webm))/i);
    return match ? match[1].trim() : null;
}

/**
 * Creates a preview stream object without extraction/validation
 * @param {Object} options - Stream options
 * @param {string} options.url - Redirect URL (will be resolved on click)
 * @param {string} options.label - Link label/text for metadata extraction
 * @param {string} options.provider - Provider name (e.g., '4KHDHub', 'HDHub4u')
 * @param {string} options.size - Optional explicit size
 * @param {Array<string>} options.languages - Optional language array
 * @returns {Object} Preview stream object
 */
export function createPreviewStream({ url, label, provider, size = null, languages = [] }) {
    const quality = parseQualityFromText(label);
    const extractedSize = size || parseSizeFromText(label);
    const codec = parseCodecFromText(label);

    return {
        url,              // Redirect URL - extraction happens on click
        label,            // Original label for display
        quality,          // Parsed quality
        size: extractedSize,
        codec,
        languages,
        provider,
        isPreview: true,  // Flag to indicate this needs resolution
        needsResolution: true
    };
}

/**
 * Formats preview streams for Stremio display
 * @param {Array} previewStreams - Array of preview stream objects
 * @param {Function} encodeUrlFn - Function to encode URLs
 * @param {Function} renderLanguageFlagsFn - Function to render language flags
 * @returns {Array} Formatted Stremio streams
 */
export function formatPreviewStreams(previewStreams, encodeUrlFn, renderLanguageFlagsFn) {
    return previewStreams.map(stream => {
        const languageFlags = renderLanguageFlagsFn(stream.languages);
        const codecInfo = stream.codec ? ` ${stream.codec}` : '';

        // Only show size if we actually have it - don't show "N/A"
        const sizeInfo = stream.size ? `\n💾 ${stream.size} | ${stream.provider}` : `\n${stream.provider}`;
        const behaviorHints = {
            bingeGroup: `${stream.provider.toLowerCase()}-streams`
        };
        const fileName = extractFilenameFromLabel(stream.label);
        if (fileName) {
            behaviorHints.fileName = fileName;
        }

        return {
            name: `PhoeniX\n${stream.quality}`,
            title: `${stream.label}${codecInfo}${languageFlags}${sizeInfo}`,
            url: encodeUrlFn(stream.url),
            behaviorHints,
            size: stream.size,
            resolution: stream.quality,
            needsResolution: true,
            isPreview: true
        };
    });
}
