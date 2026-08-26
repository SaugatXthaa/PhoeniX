/**
 * AnimeFlix HTTP Streams
 * Scrapes animeflix.dad posts -> episodes.animeflix.dad archive links -> driveseed
 * WordPress site with maxbutton download links pattern.
 */

import * as cheerio from 'cheerio';
import Cinemeta from '../../../util/cinemeta.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { makeRequest } from '../../utils/http.js';
import { fetchWithFlaresolverr } from '../../../util/flaresolverr-manager.js';
import {
    removeYear,
    generateAlternativeQueries,
    getSortedMatches,
    getResolutionFromName
} from '../../utils/parsing.js';
import { extractFileName } from '../../../common/torrent-utils.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import {
    parseSizeFromText,
    isLazyLoadEnabled,
    createPreviewStream,
    formatPreviewStreams
} from '../../utils/preview-mode.js';
import { processExtractorLinkWithAwait } from '../4khdhub/extraction.js';

const BASE_URL = (process.env.ANIMEFLIX_BASE_URL || 'https://animeflix.dad').replace(/\/+$/, '');
const PROVIDER = 'AnimeFlix';

const SEARCH_CACHE_TTL = parseInt(process.env.ANIMEFLIX_SEARCH_CACHE_TTL, 10) || 30 * 60 * 1000;
const PAGE_CACHE_TTL = parseInt(process.env.ANIMEFLIX_PAGE_CACHE_TTL, 10) || 10 * 60 * 1000;

const searchCache = new Map();
const pageCache = new Map();

function cleanText(text = '') {
    return text.replace(/\s+/g, ' ').replace(/^\W+/, '').trim();
}

function formatEpisodeHint(season, episode) {
    if (!season || !episode) return null;
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    return `S${s}E${e}`;
}

function appendAnimeFlixEpisodeHint(url, episodeHint) {
    if (!url || !episodeHint) return url;
    const encodedHint = encodeURIComponent(episodeHint);
    const joiner = url.includes('?') ? '&' : '?';
    // Use both query and fragment so episode hints survive nested proxy wrappers that may
    // drop fragments, while remaining compatible with existing hash-based hint parsing.
    return `${url}${joiner}sootio_ep=${encodedHint}#ep=${encodedHint}`;
}

/**
 * Search AnimeFlix via WordPress ?s= query
 */
async function searchAnimeFlix(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
        console.log(`[${PROVIDER}] Search cache hit for "${query}"`);
        return cached.data;
    }

    const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    try {
        let response = await makeRequest(url, { parseHTML: true, timeout: 8000 });

        // If we got Cloudflare challenge, try FlareSolverr
        if (response.body && response.body.includes('Just a moment') && response.body.includes('Cloudflare')) {
            console.log(`[${PROVIDER}] Cloudflare detected, using FlareSolverr for search...`);
            const flareResult = await fetchWithFlaresolverr(url, { timeout: 30000 });
            if (!flareResult?.body) {
                console.log(`[${PROVIDER}] FlareSolverr failed for search`);
                return [];
            }
            response = { body: flareResult.body, document: cheerio.load(flareResult.body) };
        }

        const $ = response.document;
        const results = [];

        // AnimeFlix uses .latestPost with .title h3 elements
        $('.latestPost, article, .post-item').each((_, el) => {
            const $el = $(el);
            const link = $el.find('a[href]').first().attr('href');
            const title = cleanText(
                $el.find('.title a, .title, h3 a, h2 a').first().text() ||
                $el.find('a').first().attr('title') ||
                $el.find('a').first().text()
            );

            if (link && title && link.includes('animeflix') && link.includes('download-')) {
                results.push({ title, url: link });
            }
        });

        // Fallback: regex for download page links
        if (results.length === 0) {
            const body = response.body || '';
            const regex = new RegExp(`https?://[^"'\\s]*animeflix[^"'\\s]*/download-[^"'\\s]+`, 'gi');
            const seen = new Set();
            for (const match of body.matchAll(regex)) {
                const href = match[0].replace(/['"]+$/, '');
                if (seen.has(href)) continue;
                seen.add(href);
                const slug = href.split('/').filter(Boolean).pop() || '';
                const derived = cleanText(slug.replace(/^download-/, '').replace(/[-_]+/g, ' '));
                if (derived) {
                    results.push({ title: derived, url: href });
                }
            }
        }

        searchCache.set(cacheKey, { data: results, ts: Date.now() });
        console.log(`[${PROVIDER}] Search "${query}" returned ${results.length} results`);
        return results;
    } catch (err) {
        console.log(`[${PROVIDER}] Search failed for "${query}": ${err.message}`);
        return [];
    }
}

/**
 * Parse an AnimeFlix detail page for download links
 * Pattern: <strong> with quality/size + <a class="maxbutton-8 maxbutton-af-download"> pointing to episodes.animeflix.dad archive URLs
 * The archive pages contain getlink URLs that 302-redirect to driveseed.org
 */
async function loadAnimeFlixPage(detailUrl) {
    const cached = pageCache.get(detailUrl);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) {
        console.log(`[${PROVIDER}] Page cache hit for ${detailUrl}`);
        return cached.data;
    }

    try {
        const response = await makeRequest(detailUrl, { parseHTML: true, timeout: 8000 });
        const $ = response.document;
        const entries = [];

        // Strategy 1: Find <strong> with quality text followed by maxbutton links
        $('a[class*="maxbutton"]').each((_, el) => {
            const $el = $(el);
            const href = $el.attr('href');
            if (!href || !href.includes('animeflix')) return;

            // Walk up to find quality context from surrounding <strong> or <p> elements
            const $parent = $el.closest('p, div');
            const $prevStrong = $parent.prev().find('strong').first();
            let qualityText = $prevStrong.text().trim();

            // If no strong found, check parent paragraph and its siblings
            if (!qualityText) {
                const $prevP = $parent.prev('p');
                qualityText = $prevP.find('strong').text().trim() || $prevP.text().trim();
            }

            // Also try looking at the paragraph itself
            if (!qualityText) {
                qualityText = $parent.find('strong').first().text().trim();
            }

            const quality = qualityText.match(/(480p|720p|1080p|2160p|4K)/i)?.[1] || '';
            const sizeMatch = qualityText.match(/\[([^\]]*(?:MB|GB|TB)[^\]]*)\]/i);
            const size = sizeMatch ? sizeMatch[1].trim() : parseSizeFromText(qualityText);
            const languages = detectLanguagesFromTitle(qualityText);

            entries.push({
                url: href,
                quality: qualityText || 'Download',
                size,
                languages: languages.length ? languages : ['japanese'],
                resolution: quality
            });
        });

        // Strategy 2: Fallback - use regex to find episode archive links
        if (entries.length === 0) {
            const body = response.body || '';
            const archiveRegex = /https?:\/\/episodes\.animeflix\.[^"'\s]+\/archives\/\d+/gi;
            for (const match of body.matchAll(archiveRegex)) {
                entries.push({
                    url: match[0],
                    quality: 'Download',
                    size: null,
                    languages: ['japanese'],
                    resolution: ''
                });
            }
        }

        pageCache.set(detailUrl, { data: entries, ts: Date.now() });
        console.log(`[${PROVIDER}] Parsed ${entries.length} download entries from ${detailUrl}`);
        return entries;
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to load page ${detailUrl}: ${err.message}`);
        return [];
    }
}

/**
 * Resolve an AnimeFlix archive page to get the actual download links.
 * Archive pages contain getlink URLs that 302-redirect to driveseed.org
 */
async function resolveAnimeFlixArchive(archiveUrl) {
    try {
        const response = await makeRequest(archiveUrl, { parseHTML: true, timeout: 8000 });
        const $ = response.document;
        const body = response.body || '';
        const links = [];

        // Find getlink URLs in the page
        const getlinkRegex = /https?:\/\/episodes\.animeflix\.[^"'\s]+\/getlink\/[^"'\s]+/gi;
        for (const match of body.matchAll(getlinkRegex)) {
            links.push(match[0]);
        }

        // Also check href attributes
        $('a[href*="/getlink/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href) links.push(href);
        });

        // Find direct hosting service links
        const hostRegex = /https?:\/\/[^\s"'<>]*(?:driveseed|hubcloud|hubdrive|hubcdn|gdflix|pixeldrain)[^\s"'<>]*/gi;
        for (const match of body.matchAll(hostRegex)) {
            links.push(match[0]);
        }

        // Also find maxbutton links that might point to hosting services
        $('a[class*="maxbutton"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && !href.includes('animeflix')) {
                links.push(href);
            }
        });

        return [...new Set(links)];
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to resolve archive ${archiveUrl}: ${err.message}`);
        return [];
    }
}

function buildStream(result, context) {
    if (!result?.url) return null;

    const labelBase = cleanText(result.title || result.name || context.quality || '');
    const size = result.size || context.size || parseSizeFromText(labelBase) || null;
    const qualityLabel = getResolutionFromName(labelBase || context.quality || '') || 'HTTP';
    const resLabel = qualityLabel === '2160p' ? '4k' : qualityLabel;
    const languages = Array.from(
        new Set([
            ...(context.languages || []),
            ...detectLanguagesFromTitle(labelBase),
            ...detectLanguagesFromTitle(context.quality || '')
        ].filter(Boolean))
    );
    const languageFlags = renderLanguageFlags(languages);
    const sizeInfo = size ? `\n💾 ${size} | ${PROVIDER}` : `\n${PROVIDER}`;
    const title = `${labelBase || context.quality || 'Download'}${languageFlags}${sizeInfo}`;
    const fileName = extractFileName(result.title || result.name || '');
    const behaviorHints = { bingeGroup: 'animeflix-http' };
    if (fileName) behaviorHints.fileName = fileName;

    return {
        name: `PhoeniX\n${resLabel}`,
        title,
        url: encodeUrlForStreaming(result.url),
        size,
        resolution: resLabel,
        languages,
        behaviorHints,
        httpProvider: PROVIDER
    };
}

export async function getAnimeFlixStreams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        console.log(`[${PROVIDER}] Starting search for ${tmdbId} (${type}${season ? ` S${season}` : ''}${episode ? `E${episode}` : ''})`);

        let meta = prefetchedMeta;
        if (!meta) {
            meta = await Cinemeta.getMeta(type, tmdbId);
        }

        if (!meta?.name) {
            console.log(`[${PROVIDER}] Missing metadata for ${tmdbId}`);
            return [];
        }

        const queries = Array.from(new Set([
            meta.name,
            removeYear(meta.name),
            ...generateAlternativeQueries(meta.name, meta.original_title)
        ].filter(Boolean)));

        console.log(`[${PROVIDER}] Searching with ${queries.length} queries:`, queries);
        const searchPromises = queries.map(q => searchAnimeFlix(q).then(results => ({ query: q, results })));
        const searchResponses = await Promise.all(searchPromises);

        const searchResults = [];
        for (const { query, results } of searchResponses) {
            console.log(`[${PROVIDER}] Query "${query}" returned ${results.length} results`);
            searchResults.push(...results);
        }

        if (searchResults.length === 0) {
            console.log(`[${PROVIDER}] No search results for ${meta.name}`);
            return [];
        }

        const best = getSortedMatches(searchResults, meta.name)[0];
        if (!best?.url) {
            console.log(`[${PROVIDER}] No suitable match for ${meta.name}`);
            return [];
        }

        console.log(`[${PROVIDER}] Selected match: ${best.title} -> ${best.url}`);
        const downloadEntries = await loadAnimeFlixPage(best.url);
        if (downloadEntries.length === 0) {
            console.log(`[${PROVIDER}] No download entries found`);
            return [];
        }

        if (isLazyLoadEnabled()) {
            console.log(`[${PROVIDER}] Lazy-load: returning ${downloadEntries.length} preview streams`);
            const episodeHint = type === 'series' ? formatEpisodeHint(season, episode) : null;

            const previewStreams = downloadEntries.map(entry => {
                const label = entry.quality || 'Download';
                const languages = entry.languages?.length
                    ? entry.languages
                    : ['japanese'];
                const hintedUrl = appendAnimeFlixEpisodeHint(entry.url, episodeHint);
                return createPreviewStream({
                    url: hintedUrl,
                    label,
                    provider: PROVIDER,
                    size: entry.size,
                    languages
                });
            });

            return formatPreviewStreams(previewStreams, encodeUrlForStreaming, renderLanguageFlags);
        }

        // Full extraction mode: resolve archive pages to get hosting service links
        const streamPromises = downloadEntries.map(async (entry) => {
            try {
                // First resolve the archive page to get getlink/hosting URLs
                const resolvedLinks = await resolveAnimeFlixArchive(entry.url);
                if (!resolvedLinks.length) return [];

                const allStreams = [];
                for (const link of resolvedLinks) {
                    try {
                        const extracted = await processExtractorLinkWithAwait(link, 2);
                        if (extracted?.length) {
                            allStreams.push(...extracted.map(r => buildStream(r, entry)).filter(Boolean));
                        }
                    } catch (err) {
                        console.log(`[${PROVIDER}] Extraction failed for ${link}: ${err.message}`);
                    }
                }
                return allStreams;
            } catch (err) {
                console.log(`[${PROVIDER}] Resolution failed for ${entry.url}: ${err.message}`);
                return [];
            }
        });

        const resolved = (await Promise.all(streamPromises)).flat().filter(Boolean);

        const seen = new Set();
        const streams = [];
        for (const stream of resolved) {
            if (!stream.url || seen.has(stream.url)) continue;
            seen.add(stream.url);
            streams.push(stream);
        }

        console.log(`[${PROVIDER}] Returning ${streams.length} streams`);
        return streams;
    } catch (err) {
        console.error(`[${PROVIDER}] Unexpected error: ${err.message}`);
        return [];
    }
}
