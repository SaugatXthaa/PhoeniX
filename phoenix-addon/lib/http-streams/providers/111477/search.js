/**
 * 111477 Search Module
 * Resolves deterministic directory paths on a.111477.xyz and falls back to cached indexes.
 */

import PTT from '../../../util/parse-torrent-title.js';
import {
    containsWords,
    generateAlternativeQueries,
    getSortedMatches,
    removeYear
} from '../../utils/parsing.js';
import { makeRequest } from '../../utils/http.js';

const BASE_URL = (process.env.HTTP_111477_BASE_URL || 'https://a.111477.xyz').replace(/\/+$/, '');
const DIRECTORY_CACHE_TTL = parseInt(process.env.HTTP_111477_DIRECTORY_CACHE_TTL, 10) || 10 * 60 * 1000;
const INDEX_CACHE_TTL = parseInt(process.env.HTTP_111477_INDEX_CACHE_TTL, 10) || 30 * 60 * 1000;
const DIRECTORY_MAX_BODY_BYTES = parseInt(process.env.HTTP_111477_MAX_BODY_BYTES, 10) || 8 * 1024 * 1024;
const ROOT_INDEX_MAX_BODY_BYTES = parseInt(process.env.HTTP_111477_ROOT_MAX_BODY_BYTES, 10) || 20 * 1024 * 1024;

const directoryCache = new Map();
const indexCache = new Map();

function compactText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeUrl(href, base = BASE_URL) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

function parseYearFromTitle(title = '') {
    const match = String(title || '').match(/\((19|20)\d{2}\)/);
    return match ? parseInt(match[0].slice(1, -1), 10) : null;
}

function parseSeasonNumber(name = '') {
    if (!name) return null;
    const match = String(name).match(/\bSeason\s*0*(\d{1,2})\b/i) || String(name).match(/\bS0*(\d{1,2})\b/i);
    if (!match) return null;
    const season = parseInt(match[1], 10);
    return Number.isFinite(season) ? season : null;
}

function buildTitleVariants(title = '') {
    const base = compactText(title)
        .replace(/[\/\\]/g, ' ')
        .replace(/\s+/g, ' ');

    if (!base) return [];

    const variants = new Set([base]);

    if (base.includes(':')) {
        variants.add(compactText(base.replace(/\s*:\s*/g, ' - ')));
        variants.add(compactText(base.replace(/\s*:\s*/g, ' ')));
    }

    if (/[–—]/.test(base)) {
        variants.add(compactText(base.replace(/[–—]/g, '-')));
        variants.add(compactText(base.replace(/[–—]/g, ' ')));
    }

    if (base.includes('&')) {
        variants.add(compactText(base.replace(/&/g, 'and')));
    }

    if (base.includes('\'')) {
        variants.add(compactText(base.replace(/'/g, '')));
    }

    return Array.from(variants).filter(Boolean);
}

function buildSegmentCandidates(title, originalTitle = null, year = null) {
    const titles = Array.from(new Set([
        title,
        removeYear(title),
        originalTitle,
        removeYear(originalTitle || ''),
        ...generateAlternativeQueries(title, originalTitle)
    ].filter(Boolean)));

    const candidates = [];
    const seen = new Set();

    const addCandidate = (value) => {
        const candidate = compactText(value);
        if (!candidate) return;
        const key = candidate.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(candidate);
    };

    for (const sourceTitle of titles) {
        for (const variant of buildTitleVariants(sourceTitle)) {
            if (year) addCandidate(`${variant} (${year})`);
            addCandidate(variant);
        }
    }

    return candidates;
}

function parseListingEntries($, pageUrl) {
    const entries = [];

    $('tr[data-entry="true"]').each((_, row) => {
        const $row = $(row);
        const anchor = $row.find('td a').first();
        const href = $row.attr('data-url') || anchor.attr('href') || '';
        const url = normalizeUrl(href, pageUrl);
        if (!url) return;

        const anchorText = compactText(anchor.text());
        const dataName = compactText($row.attr('data-name') || '');
        const sizeSort = parseInt($row.find('td.size').attr('data-sort') || '', 10);

        entries.push({
            title: anchorText || dataName,
            name: anchorText || dataName,
            url,
            isDirectory: href.endsWith('/'),
            sizeBytes: Number.isFinite(sizeSort) && sizeSort >= 0 ? sizeSort : null
        });
    });

    return entries;
}

async function fetchListing(url, {
    signal = null,
    maxBodySize = DIRECTORY_MAX_BODY_BYTES,
    cacheTtl = DIRECTORY_CACHE_TTL,
    cacheStore = directoryCache
} = {}) {
    const cacheKey = `${url}:${maxBodySize}`;
    const cached = cacheStore.get(cacheKey);
    if (cached && Date.now() - cached.ts < cacheTtl) {
        return cached.data;
    }

    try {
        const response = await makeRequest(url, {
            signal,
            parseHTML: true,
            timeout: 15000,
            maxBodySize,
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });

        const data = {
            statusCode: response?.statusCode || null,
            title: compactText(response?.document?.('#pageTitle').text() || response?.document?.('h1').first().text() || ''),
            url,
            entries: response?.document ? parseListingEntries(response.document, url) : []
        };

        cacheStore.set(cacheKey, { ts: Date.now(), data });
        return data;
    } catch (error) {
        console.log(`[111477] Listing fetch failed for ${url}: ${error.message}`);
        const data = { statusCode: null, title: '', url, entries: [] };
        cacheStore.set(cacheKey, { ts: Date.now(), data });
        return data;
    }
}

async function getSectionIndex(section, signal = null) {
    return fetchListing(`${BASE_URL}/${section}/`, {
        signal,
        maxBodySize: ROOT_INDEX_MAX_BODY_BYTES,
        cacheTtl: INDEX_CACHE_TTL,
        cacheStore: indexCache
    });
}

async function findDeterministicMatch(section, title, originalTitle = null, year = null, signal = null) {
    const candidates = buildSegmentCandidates(title, originalTitle, year);

    for (const segment of candidates) {
        const url = `${BASE_URL}/${section}/${encodeURIComponent(segment)}/`;
        const listing = await fetchListing(url, { signal });
        if (listing.statusCode === 200 && listing.entries.length > 0) {
            return {
                title: segment,
                url,
                isDirectory: true,
                entries: listing.entries
            };
        }
    }

    return null;
}

function rankIndexMatches(entries, primaryQuery, fallbackQueries = [], expectedYear = null) {
    const query = compactText(primaryQuery);
    if (!query || !entries.length) return [];

    const loweredFallbacks = Array.from(new Set(fallbackQueries.map(item => compactText(item)).filter(Boolean)));
    let candidates = entries.filter(entry =>
        containsWords(entry.title, query)
        || loweredFallbacks.some(fallback => containsWords(entry.title, fallback))
    );

    if (candidates.length === 0) {
        const tokens = query.toLowerCase().split(' ').filter(token => token.length >= 3);
        candidates = entries.filter(entry => {
            const lowerTitle = entry.title.toLowerCase();
            return tokens.every(token => lowerTitle.includes(token));
        });
    }

    if (candidates.length === 0) return [];

    const sorted = getSortedMatches(candidates, query, { minScore: 20 }).map(entry => {
        let adjustedScore = entry.score || 0;
        const entryYear = parseYearFromTitle(entry.title);

        if (expectedYear && entryYear === expectedYear) adjustedScore += 20;
        if (expectedYear && entryYear && entryYear !== expectedYear) adjustedScore -= 10;
        if (entry.isDirectory) adjustedScore += 5;

        return { ...entry, adjustedScore };
    });

    return sorted.sort((a, b) => (b.adjustedScore || 0) - (a.adjustedScore || 0));
}

async function fallbackIndexSearch(section, title, originalTitle = null, year = null, signal = null) {
    const index = await getSectionIndex(section, signal);
    if (index.statusCode !== 200 || index.entries.length === 0) {
        return [];
    }

    const ranked = rankIndexMatches(
        index.entries,
        title,
        [removeYear(title), originalTitle, removeYear(originalTitle || '')],
        year
    );

    return ranked.slice(0, 5);
}

function matchesEpisodeFile(name, season, episode) {
    const expectedSeason = Number(season);
    const expectedEpisode = Number(episode);
    const parsed = PTT.parse(name) || {};

    if (Number.isFinite(parsed?.season) && Number.isFinite(parsed?.episode)) {
        return parsed.season === expectedSeason && parsed.episode === expectedEpisode;
    }

    if (Number.isFinite(parsed?.season) && Array.isArray(parsed?.episodes) && parsed.episodes.includes(expectedEpisode)) {
        return parsed.season === expectedSeason;
    }

    const text = String(name || '');
    const patterns = [
        new RegExp(`\\bS0*${expectedSeason}E0*${expectedEpisode}\\b`, 'i'),
        new RegExp(`\\b${expectedSeason}x0*${expectedEpisode}\\b`, 'i'),
        new RegExp(`\\bEpisode\\s*0*${expectedEpisode}\\b`, 'i'),
        new RegExp(`\\bEp(?:isode)?\\.?\\s*0*${expectedEpisode}\\b`, 'i')
    ];

    return patterns.some(pattern => pattern.test(text));
}

export async function scrape111477Search(query, type = 'movie', year = null, originalTitle = null, signal = null) {
    if (!query) return [];

    const section = type === 'series' ? 'tvs' : 'movies';
    const deterministic = await findDeterministicMatch(section, query, originalTitle, year, signal);
    if (deterministic) {
        return [deterministic];
    }

    return fallbackIndexSearch(section, query, originalTitle, year, signal);
}

export async function load111477Content(result, type = 'movie', season = null, episode = null, signal = null) {
    if (!result?.url) {
        return { title: '', fileEntries: [] };
    }

    if (type !== 'series') {
        if (!result.isDirectory) {
            return {
                title: result.title || result.name || '',
                fileEntries: [result]
            };
        }

        const listing = result.entries?.length
            ? { entries: result.entries }
            : await fetchListing(result.url, { signal });

        return {
            title: result.title || '',
            fileEntries: (listing.entries || []).filter(entry => !entry.isDirectory)
        };
    }

    const showListing = result.entries?.length
        ? { entries: result.entries }
        : await fetchListing(result.url, { signal });

    const topLevelFiles = (showListing.entries || []).filter(entry => !entry.isDirectory);
    const seasonDirectories = (showListing.entries || []).filter(entry =>
        entry.isDirectory && parseSeasonNumber(entry.name) !== null
    );

    let fileEntries = topLevelFiles;

    if (seasonDirectories.length > 0 && season != null) {
        const matchingSeasons = seasonDirectories.filter(entry => parseSeasonNumber(entry.name) === Number(season));
        if (matchingSeasons.length === 0) {
            return { title: result.title || '', fileEntries: [] };
        }

        const seasonListings = await Promise.all(
            matchingSeasons.map(entry => fetchListing(entry.url, { signal }))
        );

        fileEntries = seasonListings.flatMap(listing =>
            (listing.entries || []).filter(entry => !entry.isDirectory)
        );
    }

    if (season != null && episode != null) {
        fileEntries = fileEntries.filter(entry => matchesEpisodeFile(entry.name, season, episode));
    }

    return {
        title: result.title || '',
        fileEntries
    };
}
