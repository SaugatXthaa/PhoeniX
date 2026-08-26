// lib/common/torrent-utils.js
// Minimal port of sootio-stremio-addon/lib/common/torrent-utils.js
// Contains only the functions used by HTTP stream providers

const VIDEO_EXTENSIONS = [
    '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
    '.m4v', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts', '.m2ts'
];

function isVideoExtension(filename) {
    if (!filename || typeof filename !== 'string') return false;
    const extension = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    return VIDEO_EXTENSIONS.includes(extension);
}

export function extractFileName(path) {
    if (!path || typeof path !== 'string') return undefined;
    const filename = path.split('/').pop();
    if (!filename) return undefined;
    const extension = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    if (!VIDEO_EXTENSIONS.includes(extension)) return undefined;
    return filename;
}

export function isValidVideo(fileName, fileSize = 0, minSize = 50 * 1024 * 1024, logPrefix = 'UTIL') {
    if (!fileName) return false;
    let decoded;
    try {
        decoded = decodeURIComponent(fileName).toLowerCase();
    } catch (e) {
        decoded = fileName.toLowerCase();
    }
    if (!isVideoExtension(decoded)) return false;
    if (/\b(sample|trailer|promo|extra|featurette|behindthescenes|bonus|cd\d+|proof|cover)\b/i.test(decoded)) {
        return false;
    }
    if (/\.(exe|iso|dmg|pkg|msi|deb|rpm|zip|rar|7z|tar|gz|txt|nfo|sfv)$/i.test(decoded)) {
        return false;
    }
    if (fileSize > 0 && fileSize < minSize) {
        return false;
    }
    const nameWithoutExt = decoded.replace(/\.[^/.]+$/, '');
    if (/^(etrg|yify|rarbg|ettv|nogrp|axxo|sparks|dimension|lol|asap|killers|evolve)$/i.test(nameWithoutExt)) {
        return false;
    }
    return true;
}

export function getResolutionFromName(name) {
    if (!name) return 'other';
    const lower = name.toLowerCase();
    if (lower.includes('2160p')) return '2160p';
    if (lower.includes('1080p')) return '1080p';
    if (lower.includes('720p')) return '720p';
    if (lower.includes('540p')) return '540p';
    if (lower.includes('480p')) return '480p';
    if (lower.includes('4k') || lower.includes('uhd')) return '2160p';
    return 'other';
}

export function formatSize(size) {
    if (!size) return '0 B';
    const i = Math.floor(Math.log(size) / Math.log(1024));
    return Number((size / Math.pow(1024, i)).toFixed(2)) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
}

export function sizeToBytes(sizeStr) {
    if (!sizeStr) return 0;
    const match = String(sizeStr).match(/([\d.]+)\s*(TB|GB|MB|KB|B)/i);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    const multipliers = { B: 1, KB: 1024, MB: 1024**2, GB: 1024**3, TB: 1024**4 };
    return value * (multipliers[unit] || 1);
}

export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
