/**
 * CineWave Streams Provider
 * Direct CDN via hdhub.thevolecitor.qzz.io API
 * Returns direct playable URLs (FSL, workers.dev, pixeldrain) + hubcloud.cx redirectors
 */

import Cinemeta from '../../../util/cinemeta.js';
import { makeRequest } from '../../utils/http.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { detectLanguagesFromTitle, renderLanguageFlags } from '../../../util/language-mapping.js';
import { getResolutionFromName } from '../../utils/parsing.js';

const PROVIDER = 'CineWave';
const STREAM_API_BASE = process.env.CINEWAVE_API_BASE || 'https://hdhub.thevolecitor.qzz.io';
const STREAM_API_CONFIG = process.env.CINEWAVE_CONFIG || 'eyJ0b3Jib3giOiJ1bnNldCIsInF1YWxpdGllcyI6IjIxNjBwLDEwODBwLDcyMHAsNDgwcCIsInNvcnQiOiJkZXNjIiwiY29udGVudCI6ImFzaWFuIiwiY2F0YWxvZ3MiOiIifQ';
const API_TIMEOUT = parseInt(process.env.CINEWAVE_TIMEOUT || '30000', 10);
const streamCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function resolveTmdbId(meta) {
    if (!meta) return null;
    const candidates = [meta.moviedb_id, meta.moviedbId, meta.tmdb_id, meta.tmdbId];
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

function parseStreamDescription(description) {
    const result = { server: null, size: null, sizeBytes: null, filename: null, languages: [] };
    if (!description) return result;
    const lines = description.split('\n');
    const serverMatch = description.match(/^\[([^\]]+)\]/);
    if (serverMatch) result.server = serverMatch[1];
    const sizeMatch = description.match(/💾\s*([\d.]+)\s*(TB|GB|MB)/i);
    if (sizeMatch) {
        result.size = `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}`;
        const n = parseFloat(sizeMatch[1]); const u = sizeMatch[2].toUpperCase();
        result.sizeBytes = u === 'TB' ? n * 1024**4 : u === 'GB' ? n * 1024**3 : u === 'MB' ? n * 1024**2 : null;
    }
    const filenameMatch = description.match(/([\w\s().\-\[\]]+\.(?:mkv|mp4|avi|webm|mov))/i);
    if (filenameMatch) result.filename = filenameMatch[1].trim();
    if (lines.length > 1) result.languages = detectLanguagesFromTitle(lines[1] || '');
    if (result.languages.length === 0) result.languages = detectLanguagesFromTitle(description);
    return result;
}

function convertCineWaveStreams(apiStreams) {
    if (!Array.isArray(apiStreams)) return [];
    const streams = []; const seen = new Set();
    for (const s of apiStreams) {
        if (!s.url && s.externalUrl) continue;
        if (!s.url) continue;
        if (s.name && /donation|donate/i.test(s.name)) continue;
        if (!s.url.startsWith('http://') && !s.url.startsWith('https://')) continue;
        if (/\/login\.php|\/logout|\/wp-admin/i.test(s.url)) continue;
        if (seen.has(s.url)) continue;
        seen.add(s.url);
        const parsed = parseStreamDescription(s.description);
        const res = getResolutionFromName(s.name + ' ' + (parsed.filename || ''));
        const qualityLabel = res === '2160p' ? '4k' : res === '1080p' ? '1080p' : res === '720p' ? '720p' : res === '480p' ? '480p' : 'auto';
        const titleLines = [];
        if (parsed.filename) titleLines.push(parsed.filename);
        else titleLines.push(s.name || 'CineWave Stream');
        const langFlags = renderLanguageFlags(parsed.languages);
        const sizeInfo = parsed.size ? `💾 ${parsed.size}` : '';
        const serverInfo = parsed.server || 'CineWave';
        titleLines.push(`${langFlags} ${sizeInfo} ${serverInfo} | ${PROVIDER}`.trim());
        streams.push({
            name: `PhoeniX\n${qualityLabel}`,
            title: titleLines.join('\n'),
            url: s.url,
            behaviorHints: {
                notWebReady: true,
                bingeGroup: `phoenix-cinewave-${qualityLabel}-${parsed.server || 'unknown'}`,
                ...(s.behaviorHints?.videoSize || parsed.sizeBytes ? { videoSize: s.behaviorHints?.videoSize || parsed.sizeBytes } : {}),
                ...(parsed.filename ? { fileName: parsed.filename } : {})
            }
        });
    }
    return streams;
}

export async function getCineWaveStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        if (type === 'series' || type === 'tv') { console.log(`[${PROVIDER}] Skipping series (API too slow)`); return []; }
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];
        const tmdbId = resolveTmdbId(meta);
        if (!tmdbId) return [];
        const contentType = 'movie';
        const idPath = `tmdb:${tmdbId}`;
        const apiUrl = `${STREAM_API_BASE}/${STREAM_API_CONFIG}/stream/${contentType}/${idPath}.json`;
        const cached = streamCache.get(apiUrl);
        if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.streams;
        console.log(`[${PROVIDER}] Fetching streams for "${meta.name}" from API`);
        const response = await makeRequest(apiUrl, { timeout: API_TIMEOUT, maxRetries: 0, headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
        if (response.statusCode !== 200) return [];
        let data; try { data = JSON.parse(response.body); } catch { return []; }
        if (!data.streams || !Array.isArray(data.streams)) return [];
        const streams = convertCineWaveStreams(data.streams);
        console.log(`[${PROVIDER}] Returning ${streams.length} stream(s)`);
        streamCache.set(apiUrl, { streams, ts: Date.now() });
        return streams;
    } catch (error) { console.log(`[${PROVIDER}] Error: ${error.message}`); return []; }
}
