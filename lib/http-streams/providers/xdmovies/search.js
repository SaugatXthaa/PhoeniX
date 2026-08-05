/**
 * XDMovies API search helpers
 * Uses the public xdmovies worker for listing and detail extraction.
 */

import {
    calculateSimilarity,
    containsWords,
    generateAlternativeQueries,
    removeYear
} from '../../utils/parsing.js';
import { makeRequest } from '../../utils/http.js';

const BASE_URL = (process.env.XDMOVIES_API_BASE_URL || 'https://xdmovies-api.hdmovielover.workers.dev').replace(/\/+$/, '');
const SEARCH_CACHE_TTL = parseInt(process.env.XDMOVIES_SEARCH_CACHE_TTL, 10) || 15 * 60 * 1000;
const DETAIL_CACHE_TTL = parseInt(process.env.XDMOVIES_DETAIL_CACHE_TTL, 10) || 10 * 60 * 1000;
const PAGE_CACHE_TTL = parseInt(process.env.XDMOVIES_PAGE_CACHE_TTL, 10) || 10 * 60 * 1000;
const MAX_SEARCH_PAGES = parseInt(process.env.XDMOVIES_MAX_SEARCH_PAGES, 10) || 80;
const MAX_TMDB_SCAN_PAGES = parseInt(process.env.XDMOVIES_MAX_TMDB_SCAN_PAGES, 10) || 160;
const PAGE_BATCH_SIZE = Math.max(1, parseInt(process.env.XDMOVIES_PAGE_BATCH_SIZE, 10) || 8);

const searchCache = new Map();
const detailCache = new Map();
const pageCache = new Map();

const URL_KEY_HINT = /(url|href|link|download|file|stream|source|watch|play|server)/i;
const CONTEXT_KEY_HINT = /^(title|name|label|quality|resolution|size|language|languages|audio|server|provider|format|season|episode)$/i;
const PATH_KEY_HINT = /(season|episode|download|link|quality|server|source|stream|audio|language|file|watch|play|s\d{1,2}e\d{1,2})/i;
const IGNORE_KEY_HINT = /(image|poster|thumb|thumbnail|backdrop|logo|icon|subtitle|caption|sample|preview)/i;

function compactText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseNumeric(value) {
    const parsed = parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function safeJsonParse(body) {
    try {
        return JSON.parse(body);
    } catch {
        return null;
    }
}

function humanizeKey(key = '') {
    return compactText(
        String(key || '')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/[_-]+/g, ' ')
    );
}

function normalizeDetailUrl(url) {
    if (!url) return null;

    const normalized = String(url).trim().replace(/^https?:\/(?!\/)/i, match => `${match}/`);
    try {
        return new URL(normalized).toString();
    } catch {
        return null;
    }
}

function normalizeType(type = '') {
    const lower = String(type || '').toLowerCase().trim();
    if (['series', 'show', 'tv'].includes(lower)) return 'series';
    return 'movie';
}

function extractTmdbIdFromDetailUrl(detailUrl = '') {
    const match = String(detailUrl || '').match(/-(\d{3,})(?:\/)?$/);
    return match ? match[1] : null;
}

function dedupeByUrl(items = []) {
    const seen = new Set();
    return items.filter(item => {
        const key = item?.url || '';
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function buildQueryVariants(query, originalTitle = null, alternativeTitles = []) {
    const variants = new Set();

    const add = (value) => {
        const normalized = compactText(value);
        if (!normalized) return;
        variants.add(normalized);
        const withoutYear = compactText(removeYear(normalized));
        if (withoutYear) variants.add(withoutYear);
    };

    add(query);
    add(originalTitle);

    for (const alt of Array.isArray(alternativeTitles) ? alternativeTitles : []) {
        add(alt);
    }

    for (const generated of generateAlternativeQueries(query, originalTitle || '')) {
        add(generated);
    }

    return Array.from(variants);
}

function maybeMatchesTitle(title, queries = []) {
    return queries.some(query =>
        containsWords(title, query) || calculateSimilarity(title, query) >= 0.55
    );
}

function looksLikeHttpUrl(value) {
    try {
        const parsed = new URL(String(value || ''));
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function normalizeLanguages(value) {
    if (!value) return [];

    if (Array.isArray(value)) {
        return Array.from(new Set(value.map(item => compactText(item)).filter(Boolean)));
    }

    return Array.from(new Set(
        String(value)
            .split(/[,/|]+/)
            .map(item => compactText(item))
            .filter(Boolean)
    ));
}

function parseSize(value = '') {
    const match = String(value || '').match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)/i);
    return match ? `${match[1]} ${match[2].toUpperCase()}` : null;
}

function shouldIgnoreCandidateUrl(url, key = '', detailUrl = '') {
    const lowerKey = String(key || '').toLowerCase();
    if (IGNORE_KEY_HINT.test(lowerKey)) return true;

    let parsed;
    let detailParsed;
    try {
        parsed = new URL(url);
        detailParsed = detailUrl ? new URL(detailUrl) : null;
    } catch {
        return true;
    }

    const pathname = parsed.pathname.toLowerCase();
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|avif)(?:$|\?)/i.test(pathname)) return true;
    if (parsed.hostname === 'image.tmdb.org') return true;
    if (parsed.hostname === new URL(BASE_URL).hostname) return true;

    if (detailParsed) {
        if (parsed.toString() === detailParsed.toString()) return true;
        if (parsed.hostname === detailParsed.hostname && /^\/(movies|series)\//i.test(pathname)) {
            return true;
        }
    }

    return false;
}

function collectObjectContext(node) {
    const parts = [];
    const languages = [];

    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return { parts, languages };
    }

    for (const [key, value] of Object.entries(node)) {
        if (value == null) continue;

        if (typeof value === 'string' || typeof value === 'number') {
            if (!CONTEXT_KEY_HINT.test(key)) continue;

            if (/^languages?$/i.test(key)) {
                languages.push(...normalizeLanguages(value));
                continue;
            }

            if (/^season$/i.test(key)) {
                const season = parseNumeric(value);
                if (season != null) parts.push(`Season ${season}`);
                continue;
            }

            if (/^episode$/i.test(key)) {
                const episode = parseNumeric(value);
                if (episode != null) parts.push(`Episode ${episode}`);
                continue;
            }

            const text = compactText(value);
            if (text) parts.push(text);
        }
    }

    return {
        parts: Array.from(new Set(parts.filter(Boolean))),
        languages: Array.from(new Set(languages.filter(Boolean)))
    };
}

function buildEntry(url, key, node, state, detailUrl) {
    if (!looksLikeHttpUrl(url) || shouldIgnoreCandidateUrl(url, key, detailUrl)) {
        return null;
    }

    const localContext = collectObjectContext(node);
    const labelParts = Array.from(new Set([
        ...(state?.parts || []),
        ...localContext.parts,
        humanizeKey(key)
    ].filter(Boolean)));

    const label = compactText(labelParts.join(' | ')) || 'Download';
    const size = parseSize(node?.size || node?.file_size || node?.filesize || label);
    const quality = compactText(node?.quality || node?.resolution || node?.video_quality || '');
    const languages = Array.from(new Set([
        ...((state && state.languages) || []),
        ...localContext.languages
    ].filter(Boolean)));

    return {
        url: normalizeDetailUrl(url),
        label,
        size,
        quality,
        languages
    };
}

function traverseDetails(node, state, results, detailUrl) {
    if (node == null) return;

    if (Array.isArray(node)) {
        node.forEach(child => {
            if (typeof child === 'string' && looksLikeHttpUrl(child)) {
                const key = state?.parts?.[state.parts.length - 1] || 'link';
                const entry = buildEntry(child, key, {}, state, detailUrl);
                if (entry) results.push(entry);
                return;
            }

            traverseDetails(child, state, results, detailUrl);
        });
        return;
    }

    if (typeof node !== 'object') {
        return;
    }

    const localContext = collectObjectContext(node);
    const nextState = {
        parts: Array.from(new Set([...(state?.parts || []), ...localContext.parts])),
        languages: Array.from(new Set([...(state?.languages || []), ...localContext.languages]))
    };

    for (const [key, value] of Object.entries(node)) {
        if (typeof value === 'string' && looksLikeHttpUrl(value) && URL_KEY_HINT.test(key)) {
            const entry = buildEntry(value, key, node, nextState, detailUrl);
            if (entry) results.push(entry);
        }

        if (typeof value === 'string' && looksLikeHttpUrl(value) && PATH_KEY_HINT.test(key)) {
            const entry = buildEntry(value, key, node, nextState, detailUrl);
            if (entry) results.push(entry);
        }

        if (Array.isArray(value) && PATH_KEY_HINT.test(key)) {
            const childState = {
                parts: [...nextState.parts, humanizeKey(key)],
                languages: nextState.languages
            };
            value.forEach(item => {
                if (typeof item !== 'string' || !looksLikeHttpUrl(item)) return;
                const entry = buildEntry(item, key, node, childState, detailUrl);
                if (entry) results.push(entry);
            });
        }
    }

    for (const [key, value] of Object.entries(node)) {
        if (value == null || typeof value !== 'object') continue;

        const pathKey = PATH_KEY_HINT.test(key) ? humanizeKey(key) : '';
        traverseDetails(
            value,
            {
                parts: pathKey ? [...nextState.parts, pathKey] : nextState.parts,
                languages: nextState.languages
            },
            results,
            detailUrl
        );
    }
}

function extractDownloadEntries(detailData, detailUrl) {
    const results = [];
    traverseDetails(detailData, { parts: [], languages: [] }, results, detailUrl);

    const merged = new Map();
    for (const entry of results) {
        if (!entry?.url) continue;
        const existing = merged.get(entry.url);
        if (!existing) {
            merged.set(entry.url, entry);
            continue;
        }

        const languages = Array.from(new Set([
            ...(existing.languages || []),
            ...(entry.languages || [])
        ]));
        const label = existing.label.length >= entry.label.length ? existing.label : entry.label;

        merged.set(entry.url, {
            ...existing,
            label,
            size: existing.size || entry.size || null,
            quality: existing.quality || entry.quality || '',
            languages
        });
    }

    return Array.from(merged.values());
}

async function requestJson(url, { signal = null, timeout = 10000 } = {}) {
    const response = await makeRequest(url, {
        signal,
        timeout,
        headers: {
            'Accept': 'application/json, text/plain, */*'
        }
    });

    return {
        statusCode: response?.statusCode || null,
        data: safeJsonParse(response?.body || '')
    };
}

async function fetchPage(pageNo, signal = null) {
    const cached = pageCache.get(pageNo);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) {
        return cached.data;
    }

    try {
        const { statusCode, data } = await requestJson(`${BASE_URL}/page?no=${pageNo}`, {
            signal,
            timeout: 12000
        });
        const items = Array.isArray(data?.items)
            ? data.items
                .map(item => {
                    const title = compactText(item?.title || item?.name);
                    const url = normalizeDetailUrl(item?.detail_url || item?.detailUrl || item?.url);
                    if (!title || !url) return null;

                    return {
                        title,
                        url,
                        year: parseNumeric(item?.year),
                        type: normalizeType(item?.type),
                        poster: item?.image_url || item?.poster || null,
                        tmdbId: extractTmdbIdFromDetailUrl(url)
                    };
                })
                .filter(Boolean)
            : [];

        const pageData = {
            page: pageNo,
            statusCode,
            items,
            signature: items[0] ? `${items[0].url}|${items.length}` : `empty:${pageNo}`
        };
        pageCache.set(pageNo, { ts: Date.now(), data: pageData });
        return pageData;
    } catch (error) {
        console.log(`[XDMovies] Page ${pageNo} fetch failed: ${error.message}`);
        const pageData = {
            page: pageNo,
            statusCode: null,
            items: [],
            signature: `error:${pageNo}`
        };
        pageCache.set(pageNo, { ts: Date.now(), data: pageData });
        return pageData;
    }
}

async function scanPages(pageLimit, signal, onPage) {
    let previousSignature = null;
    let repeatedSignatureCount = 0;

    for (let start = 1; start <= pageLimit; start += PAGE_BATCH_SIZE) {
        const pageNumbers = [];
        for (let page = start; page < start + PAGE_BATCH_SIZE && page <= pageLimit; page++) {
            pageNumbers.push(page);
        }

        const batch = await Promise.all(pageNumbers.map(page => fetchPage(page, signal)));
        for (const pageData of batch) {
            if (pageData.signature === previousSignature) {
                repeatedSignatureCount += 1;
            } else {
                previousSignature = pageData.signature;
                repeatedSignatureCount = 0;
            }

            const result = await onPage(pageData);
            if (result?.done) {
                return result.value;
            }

            if (repeatedSignatureCount >= 2) {
                return null;
            }
        }
    }

    return null;
}

/**
 * Search XDMovies by scanning the paginated API index.
 * Exact TMDB ID matches are prioritized when available.
 */
export async function scrapeXDMoviesSearch(query, options = {}) {
    const {
        type = 'movie',
        year = null,
        originalTitle = null,
        alternativeTitles = [],
        tmdbId = null,
        signal = null,
        maxPages = null
    } = options;

    const normalizedType = normalizeType(type);
    const normalizedQueries = buildQueryVariants(query, originalTitle, alternativeTitles);
    const targetTmdbId = tmdbId ? String(tmdbId) : null;
    const pageLimit = Math.max(1, maxPages || (targetTmdbId ? MAX_TMDB_SCAN_PAGES : MAX_SEARCH_PAGES));

    const cacheKey = JSON.stringify({
        query: compactText(query).toLowerCase(),
        type: normalizedType,
        year: parseNumeric(year),
        originalTitle: compactText(originalTitle).toLowerCase(),
        alternativeTitles: normalizedQueries,
        tmdbId: targetTmdbId,
        pageLimit
    });

    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
        return cached.data;
    }

    const scannedItems = [];
    const exactMatches = [];

    await scanPages(pageLimit, signal, async pageData => {
        const typedItems = pageData.items.filter(item => normalizeType(item.type) === normalizedType);
        if (!typedItems.length) return null;

        scannedItems.push(...typedItems);

        if (targetTmdbId) {
            const matched = typedItems.filter(item => item.tmdbId === targetTmdbId);
            if (matched.length) {
                exactMatches.push(...matched);
                return { done: true, value: dedupeByUrl(exactMatches) };
            }
        }

        return null;
    });

    let results = exactMatches.length
        ? dedupeByUrl(exactMatches)
        : dedupeByUrl(scannedItems.filter(item => maybeMatchesTitle(item.title, normalizedQueries)));

    if (!results.length && year) {
        const numericYear = parseNumeric(year);
        results = dedupeByUrl(scannedItems.filter(item => item.year && item.year === numericYear));
    }

    searchCache.set(cacheKey, { ts: Date.now(), data: results });
    return results;
}

/**
 * Load XDMovies detail JSON and extract candidate download links.
 */
export async function loadXDMoviesContent(detailUrl, type = 'movie', signal = null) {
    const normalizedUrl = normalizeDetailUrl(detailUrl);
    if (!normalizedUrl) {
        return { title: '', downloadEntries: [], raw: null };
    }

    const cacheKey = `${normalizeType(type)}:${normalizedUrl}`;
    const cached = detailCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < DETAIL_CACHE_TTL) {
        return cached.data;
    }

    const endpoint = normalizeType(type) === 'series' ? 'series' : 'movie';

    try {
        const { statusCode, data } = await requestJson(
            `${BASE_URL}/${endpoint}/details?url=${encodeURIComponent(normalizedUrl)}`,
            { signal, timeout: 15000 }
        );

        if (!data || statusCode >= 400 || /failed to fetch/i.test(String(data?.detail || ''))) {
            const result = { title: '', downloadEntries: [], raw: data };
            detailCache.set(cacheKey, { ts: Date.now(), data: result });
            return result;
        }

        const title = compactText(
            data?.title
            || data?.name
            || data?.movieTitle
            || data?.seriesTitle
        );
        const downloadEntries = extractDownloadEntries(data, normalizedUrl);
        const result = { title, downloadEntries, raw: data };
        detailCache.set(cacheKey, { ts: Date.now(), data: result });
        return result;
    } catch (error) {
        console.log(`[XDMovies] Detail load failed for ${normalizedUrl}: ${error.message}`);
        const result = { title: '', downloadEntries: [], raw: null };
        detailCache.set(cacheKey, { ts: Date.now(), data: result });
        return result;
    }
}
