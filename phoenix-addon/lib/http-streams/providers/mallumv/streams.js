/**
 * MalluMv HTTP Streams
 * Scrapes mallumv.gay download pages and resolves HubCloud links to seekable video URLs.
 */

import Cinemeta from '../../../util/cinemeta.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { makeRequest } from '../../utils/http.js';
import {
    getResolutionFromName,
    removeYear,
    generateAlternativeQueries,
    getSortedMatches
} from '../../utils/parsing.js';
import {
    createPreviewStream,
    formatPreviewStreams,
    isLazyLoadEnabled,
    parseSizeFromText
} from '../../utils/preview-mode.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { processExtractorLinkWithAwait } from '../4khdhub/extraction.js';
import { extractFileName } from '../../../common/torrent-utils.js';

const BASE_URL = (process.env.MALLUMV_BASE_URL || 'https://mallumv.life').replace(/\/+$/, '');
const PROVIDER = 'MalluMv';

// Cache configuration
const SEARCH_CACHE_TTL = parseInt(process.env.MALLUMV_SEARCH_CACHE_TTL, 10) || 30 * 60 * 1000; // 30 minutes
const PAGE_CACHE_TTL = parseInt(process.env.MALLUMV_PAGE_CACHE_TTL, 10) || 10 * 60 * 1000; // 10 minutes

// In-memory cache only
const searchCache = new Map();
const contentCache = new Map();
const HOST_PATTERNS = [
    /hubcloud/i,
    /hubdrive/i,
    /hubcdn/i,
    /hubvid/i,
    /hubcloud\.php/i,
    /gamerxyt\.com/i,
    /pixeldrain/i,
    /workers\.dev/i,
    /r2\.dev/i,
    /fastdl/i,
    /vcloud/i,
    /hblinks/i
];

function toAbsolute(href, base = BASE_URL) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

function cleanText(text = '') {
    return text.replace(/\s+/g, ' ').replace(/^»\s*/i, '').trim();
}

function normalizeResolution(label = '') {
    const res = getResolutionFromName(label);
    if (res === '2160p') return '4k';
    if (['1080p', '720p', '480p'].includes(res)) return res;
    return 'HTTP';
}

async function searchMallumv(query) {
    // Check in-memory cache first
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
        console.log(`[${PROVIDER}] Search cache hit (memory) for "${query}"`);
        return cached.data;
    }

    const url = `${BASE_URL}/search.php?q=${encodeURIComponent(query)}`;
    try {
        const response = await makeRequest(url, { parseHTML: true, timeout: 10000 });
        const $ = response.document;
        const results = [];

        $('a[href*="movie/"]').each((_, a) => {
            const href = $(a).attr('href');
            const title = cleanText($(a).text() || $(a).find('b').text());
            const absolute = toAbsolute(href, url);
            if (title && absolute) {
                results.push({ title, url: absolute });
            }
        });

        // Cache the results in memory
        searchCache.set(cacheKey, { data: results, ts: Date.now() });

        return results;
    } catch (err) {
        console.log(`[${PROVIDER}] Search failed for "${query}": ${err.message}`);
        return [];
    }
}

async function resolveConfirmLink(confirmUrl) {
    try {
        const response = await makeRequest(confirmUrl, { parseHTML: true, timeout: 10000 });
        const $ = response.document;
        const internalHref =
            $('a[href*="/internal/"]').first().attr('href') ||
            $('a:contains("Confirm")').attr('href');

        return internalHref ? toAbsolute(internalHref, confirmUrl) : null;
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to resolve confirm page ${confirmUrl}: ${err.message}`);
        return null;
    }
}

async function extractHostLinks(downloadPageUrl) {
    try {
        const response = await makeRequest(downloadPageUrl, { parseHTML: true, timeout: 10000 });
        const $ = response.document;
        const links = [];
        const seen = new Set();

        $('a[href]').each((_, a) => {
            const href = $(a).attr('href');
            if (!href) return;
            const absolute = toAbsolute(href, downloadPageUrl);
            if (!absolute || seen.has(absolute)) return;

            const lower = absolute.toLowerCase();
            if (HOST_PATTERNS.some(pattern => pattern.test(lower))) {
                links.push({ url: absolute, text: cleanText($(a).text()) });
                seen.add(absolute);
            }
        });

        return links;
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to parse download page ${downloadPageUrl}: ${err.message}`);
        return [];
    }
}

async function loadMalluMvContent(detailUrl) {
    // Check in-memory cache first
    const cached = contentCache.get(detailUrl);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) {
        console.log(`[${PROVIDER}] Content cache hit (memory) for ${detailUrl}`);
        return cached.data;
    }

    try {
        const response = await makeRequest(detailUrl, { parseHTML: true, timeout: 12000 });
        const $ = response.document;
        const downloads = [];

        const pageLanguages = detectLanguagesFromTitle(
            cleanText($('p:contains("Category")').text())
        );

        const candidates = [];
        $('a[href*="/confirm/"]').each((_, a) => {
            const href = $(a).attr('href');
            const label = cleanText($(a).text());
            const absolute = toAbsolute(href, detailUrl);
            if (absolute) {
                candidates.push({ label: label || 'Download', confirmUrl: absolute, languages: pageLanguages });
            }
        });

        for (const candidate of candidates) {
            const internalUrl = await resolveConfirmLink(candidate.confirmUrl);
            if (!internalUrl) continue;

            const hostLinks = await extractHostLinks(internalUrl);
            hostLinks.forEach(link => {
                downloads.push({
                    label: candidate.label,
                    url: link.url,
                    linkText: link.text,
                    languages: candidate.languages || []
                });
            });
        }

        // Cache the result in memory
        contentCache.set(detailUrl, { data: downloads, ts: Date.now() });

        return downloads;
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to load detail page ${detailUrl}: ${err.message}`);
        return [];
    }
}

function buildStream(result, context = {}) {
    if (!result?.url) return null;

    const baseLabel = cleanText(context.label || result.title || result.name || '');
    const size = result.size || parseSizeFromText(baseLabel) || null;
    const detectedLanguages = [
        ...detectLanguagesFromTitle(baseLabel),
        ...detectLanguagesFromTitle(result.title || ''),
        ...(context.languages || [])
    ];
    const languages = Array.from(new Set(detectedLanguages.filter(Boolean)));
    const resolutionLabel = normalizeResolution(result.title || baseLabel);
    const languageFlags = renderLanguageFlags(languages);
    const sizeInfo = size ? `\n💾 ${size} | ${PROVIDER}` : `\n${PROVIDER}`;
    const title = `${baseLabel || 'Download'}${languageFlags}${sizeInfo}`;
    const fileName = extractFileName(result.title || result.name || '');
    const behaviorHints = { bingeGroup: 'mallumv-http' };
    if (fileName) {
        behaviorHints.fileName = fileName;
    }

    return {
        name: `PhoeniX\n${resolutionLabel}`,
        title,
        url: encodeUrlForStreaming(result.url),
        size,
        resolution: resolutionLabel,
        languages,
        behaviorHints,
        httpProvider: PROVIDER
    };
}

export async function getMalluMvStreams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        // MalluMv primarily offers single-file downloads; ignore season/episode filters
        console.log(`[${PROVIDER}] Starting search for ${tmdbId} (${type}${season ? ` S${season}` : ''}${episode ? `E${episode}` : ''})`);

        // Use pre-fetched metadata if available, otherwise fetch it (fallback for direct calls)
        let meta = prefetchedMeta;
        if (!meta) {
            console.log(`[${PROVIDER}] No pre-fetched metadata, fetching from Cinemeta...`);
            meta = await Cinemeta.getMeta(type, tmdbId);
        } else {
            console.log(`[${PROVIDER}] Using pre-fetched Cinemeta metadata: "${meta.name}"`);
        }

        if (!meta?.name) {
            console.log(`[${PROVIDER}] Missing metadata for ${tmdbId}`);
            return [];
        }

        const queries = Array.from(new Set([
            meta.name,
            removeYear(meta.name),
            ...(meta.alternativeTitles || []),
            ...generateAlternativeQueries(meta.name, meta.original_title)
        ].filter(Boolean)));

        const searchResults = [];
        for (const query of queries) {
            const results = await searchMallumv(query);
            results.forEach(r => searchResults.push(r));
        }

        if (searchResults.length === 0) {
            console.log(`[${PROVIDER}] No search results found for ${meta.name}`);
            return [];
        }

        const sorted = getSortedMatches(searchResults, meta.name);
        const best = sorted[0];
        if (!best?.url) {
            console.log(`[${PROVIDER}] No suitable match for ${meta.name}`);
            return [];
        }

        console.log(`[${PROVIDER}] Selected match: ${best.title} -> ${best.url}`);
        const downloads = await loadMalluMvContent(best.url);
        if (downloads.length === 0) {
            console.log(`[${PROVIDER}] No download links found on page`);
            return [];
        }

        if (isLazyLoadEnabled()) {
            console.log(`[${PROVIDER}] Lazy-load enabled: returning ${downloads.length} preview streams without extraction`);
            const previews = downloads.map(entry => {
                const label = cleanText(`${entry.label || 'Download'}${entry.linkText ? ` ${entry.linkText}` : ''}`);
                return createPreviewStream({
                    url: entry.url,
                    label,
                    provider: PROVIDER,
                    size: parseSizeFromText(label),
                    languages: entry.languages || []
                });
            });

            const streams = formatPreviewStreams(previews, encodeUrlForStreaming, renderLanguageFlags)
                .map(stream => ({
                    ...stream,
                    behaviorHints: {
                        ...stream.behaviorHints,
                        bingeGroup: 'mallumv-http'
                    }
                }));

            console.log(`[${PROVIDER}] Returning ${streams.length} preview streams (lazy-load mode)`);
            return streams;
        }

        const extractionPromises = downloads.map(async (item, idx) => {
            try {
                const extracted = await processExtractorLinkWithAwait(item.url, idx + 1);
                if (!extracted) return [];
                return extracted
                    .map(res => buildStream(res, item))
                    .filter(Boolean);
            } catch (err) {
                console.log(`[${PROVIDER}] Extraction failed for ${item.url}: ${err.message}`);
                return [];
            }
        });

        const extracted = (await Promise.all(extractionPromises)).flat().filter(Boolean);
        if (extracted.length === 0) return [];

        // Prefer PixelServer/pixeldrain links and drop googleusercontent fallbacks entirely
        const nonGoogle = extracted.filter(s => !s.url?.toLowerCase().includes('googleusercontent.com'));
        const prioritized = nonGoogle.length ? nonGoogle : extracted;

        prioritized.sort((a, b) => {
            const score = (url = '') => {
                const u = url.toLowerCase();
                if (u.includes('pixeldrain') || u.includes('pixel')) return 3;
                if (u.includes('hubcdn') || u.includes('workers.dev') || u.includes('r2.dev')) return 2;
                return 1;
            };
            return score(b.url) - score(a.url);
        });

        // Deduplicate by URL
        const seen = new Set();
        const streams = [];
        for (const stream of prioritized) {
            if (!stream.url || seen.has(stream.url)) continue;
            seen.add(stream.url);
            streams.push(stream);
        }

        console.log(`[${PROVIDER}] Returning ${streams.length} validated streams`);
        return streams;
    } catch (err) {
        console.error(`[${PROVIDER}] Unexpected error: ${err.message}`);
        return [];
    }
}
