/**
 * MoviesMod HTTP Streams
 * Scrapes moviesmod.town posts -> modpro.blog archive links -> driveseed/hubcloud
 * WordPress site with maxbutton download links pattern.
 */

import * as cheerio from 'cheerio';
import Cinemeta from '../../../util/cinemeta.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { makeRequest } from '../../utils/http.js';
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
    parseQualityFromText,
    isLazyLoadEnabled,
    createPreviewStream,
    formatPreviewStreams
} from '../../utils/preview-mode.js';
import { processExtractorLinkWithAwait } from '../4khdhub/extraction.js';
import { resolveHttpStreamUrl } from '../../resolvers/http-resolver.js';

const BASE_URL = (process.env.MOVIESMOD_BASE_URL || 'https://moviesmod.town').replace(/\/+$/, '');
const PROVIDER = 'MoviesMod';

const SEARCH_CACHE_TTL = parseInt(process.env.MOVIESMOD_SEARCH_CACHE_TTL, 10) || 30 * 60 * 1000;
const PAGE_CACHE_TTL = parseInt(process.env.MOVIESMOD_PAGE_CACHE_TTL, 10) || 10 * 60 * 1000;

const searchCache = new Map();
const pageCache = new Map();
const ARCHIVE_FALLBACK_HOSTS = ['modpro.blog', 'leechpro.blog'];
const SERIES_EXCLUDE_HINTS = [
    'movie',
    'in conversation',
    'the challenge',
    'behind the scenes',
    'making of',
    'fireplace'
];

function cleanText(text = '') {
    return text.replace(/\s+/g, ' ').replace(/^\W+/, '').trim();
}

function parseSeasonNumber(text = '') {
    if (!text) return null;
    const seasonMatch = text.match(/\bSeason\s*0*(\d+)/i) || text.match(/\bS0*(\d{1,2})\b/i);
    if (!seasonMatch) return null;
    const season = parseInt(seasonMatch[1], 10);
    return Number.isFinite(season) ? season : null;
}

function classifyLinkKind(buttonText = '', headingText = '') {
    const combined = `${buttonText} ${headingText}`.toLowerCase();
    if (combined.includes('episode links')) return 'episode-links';
    if (combined.includes('batch') || combined.includes('zip')) return 'batch';
    return 'download';
}

function appendEpisodeHint(url, season, episode) {
    if (!url || !season || !episode) return url;
    const epHint = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    try {
        const parsed = new URL(url);
        parsed.searchParams.set('sootio_ep', epHint);
        return parsed.toString();
    } catch {
        const joiner = url.includes('?') ? '&' : '?';
        return `${url}${joiner}sootio_ep=${encodeURIComponent(epHint)}`;
    }
}

function chooseBestSeriesMatch(results, title, requestedSeason = null) {
    if (!Array.isArray(results) || results.length === 0) return null;

    const ranked = getSortedMatches(results, title).map(item => {
        let bonus = 0;
        const lower = (item.title || '').toLowerCase();

        if (/\bseason\b/i.test(lower)) bonus += 30;
        if (requestedSeason && new RegExp(`\\bseason\\s*0*${requestedSeason}\\b`, 'i').test(lower)) bonus += 20;
        if (requestedSeason && new RegExp(`\\bs0*${requestedSeason}\\b`, 'i').test(lower)) bonus += 15;
        if (SERIES_EXCLUDE_HINTS.some(token => lower.includes(token))) bonus -= 35;
        if (/\bseason\s*\d+\s*-\s*\d+\b/i.test(lower)) bonus += 8;

        return { ...item, _moviesmodAdjustedScore: (item.score || 0) + bonus };
    }).sort((a, b) => (b._moviesmodAdjustedScore || 0) - (a._moviesmodAdjustedScore || 0));

    return ranked[0] || null;
}

function filterSeriesEntries(entries, season, episode) {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    const requestedSeason = season ? parseInt(season, 10) : null;
    const requestedEpisode = episode ? parseInt(episode, 10) : null;

    let filtered = entries.slice();

    // Prefer explicit episode-links entries over batch/zip packs.
    const hasEpisodeLinks = filtered.some(entry => entry.linkKind === 'episode-links');
    if (hasEpisodeLinks) {
        filtered = filtered.filter(entry => entry.linkKind === 'episode-links');
    }

    // Remove explicit packs/batch archives for episode requests.
    if (requestedEpisode) {
        filtered = filtered.filter(entry => !entry.isPack);
    }

    if (requestedSeason) {
        const entriesWithSeason = filtered.filter(entry => Number.isFinite(entry.season));
        if (entriesWithSeason.length > 0) {
            const seasonMatched = entriesWithSeason.filter(entry => entry.season === requestedSeason);
            if (seasonMatched.length > 0) {
                filtered = seasonMatched;
            } else {
                filtered = [];
            }
        }
    }

    if (requestedSeason && requestedEpisode) {
        filtered = filtered.map(entry => ({
            ...entry,
            // Some season pages use generic "Download" buttons that still point to episode
            // archives. Attach the episode hint to all non-pack entries so the resolver can
            // select the requested episode instead of exposing a whole-season wrapper.
            url: entry.isPack ? entry.url : appendEpisodeHint(entry.url, requestedSeason, requestedEpisode)
        }));
    }

    // De-dupe duplicate buttons with identical season/quality/link-kind.
    const seen = new Set();
    return filtered.filter(entry => {
        const key = [
            entry.linkKind || '',
            entry.season ?? '',
            (entry.quality || '').toLowerCase(),
            entry.url || ''
        ].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Search MoviesMod via WordPress ?s= query
 */
async function searchMoviesMod(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
        console.log(`[${PROVIDER}] Search cache hit for "${query}"`);
        return cached.data;
    }

    const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    try {
        const response = await makeRequest(url, { parseHTML: true, timeout: 8000 });
        const $ = response.document;
        const results = [];

        // MoviesMod uses .post-item or article elements with links
        $('article, .post-item, .result-item').each((_, el) => {
            const $el = $(el);
            const link = $el.find('a[href]').first().attr('href');
            const title = cleanText(
                $el.find('.title a, h2 a, h3 a').first().text() ||
                $el.find('a').first().attr('title') ||
                $el.find('a').first().text()
            );

            if (link && title && link.includes('moviesmod') && link.includes('download-')) {
                results.push({ title, url: link });
            }
        });

        // Fallback: regex for download page links
        if (results.length === 0) {
            const body = response.body || '';
            const regex = new RegExp(`https?://[^"'\\s]*moviesmod[^"'\\s]*/download-[^"'\\s]+`, 'gi');
            const seen = new Set();
            for (const match of body.matchAll(regex)) {
                const href = match[0].replace(/['"]+$/, '');
                if (seen.has(href)) continue;
                seen.add(href);
                // Derive title from slug
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
 * Parse a MoviesMod detail page for download links
 * Pattern: <h3/h4> with quality info + <a class="maxbutton-1"> pointing to archive URLs
 */
async function loadMoviesModPage(detailUrl) {
    const cached = pageCache.get(detailUrl);
    if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) {
        console.log(`[${PROVIDER}] Page cache hit for ${detailUrl}`);
        return cached.data;
    }

    try {
        const response = await makeRequest(detailUrl, { parseHTML: true, timeout: 8000 });
        const $ = response.document;
        const entries = [];

        // Extract download sections: <h3/h4> with quality text followed by <a> with maxbutton class
        const body = response.body || '';

        // Strategy 1: Parse h3/h4 headings paired with maxbutton links
        const headings = $('h3, h4').toArray();
        for (const heading of headings) {
            const $heading = $(heading);
            const headingText = $heading.text().trim();

            // Only process download-related headings
            if (!headingText.toLowerCase().includes('download')) continue;

            // Find the next sibling paragraph with a maxbutton link
            let $next = $heading.parent().next();
            if (!$next.find('a[class*="maxbutton"]').length) {
                $next = $heading.next();
            }

            const $link = $next.find('a[class*="maxbutton"]').first();
            if (!$link.length) continue;

            const href = $link.attr('href');
            if (!href) continue;
            const buttonText = cleanText($link.text());

            // Extract quality and size from heading text
            const quality = headingText.match(/(480p|720p|1080p|2160p|4K)/i)?.[1] || '';
            const sizeMatch = headingText.match(/\[([^\]]*(?:MB|GB|TB)[^\]]*)\]/i);
            const size = sizeMatch ? sizeMatch[1].trim() : parseSizeFromText(headingText);
            const languages = detectLanguagesFromTitle(headingText);
            const linkKind = classifyLinkKind(buttonText, headingText);
            const season = parseSeasonNumber(`${headingText} ${buttonText}`);

            entries.push({
                url: href,
                quality: headingText,
                size,
                languages,
                resolution: quality,
                buttonText,
                linkKind,
                isPack: linkKind === 'batch',
                season
            });
        }

        // Strategy 2: Fallback - find all maxbutton links with archive URLs
        if (entries.length === 0) {
            $('a[class*="maxbutton"]').each((_, el) => {
                const href = $(el).attr('href');
                if (!href || (!href.includes('modpro.blog') && !href.includes('/archives/'))) return;

                // Walk up to find quality context
                const $parent = $(el).closest('p, div');
                const $prevHeading = $parent.prevAll('h3, h4').first();
                const qualityText = $prevHeading.text().trim() || '';

                const quality = qualityText.match(/(480p|720p|1080p|2160p|4K)/i)?.[1] || '';
                const sizeMatch = qualityText.match(/\[([^\]]*(?:MB|GB|TB)[^\]]*)\]/i);
                const size = sizeMatch ? sizeMatch[1].trim() : parseSizeFromText(qualityText);
                const buttonText = cleanText($(el).text());
                const linkKind = classifyLinkKind(buttonText, qualityText);
                const season = parseSeasonNumber(`${qualityText} ${buttonText}`);

                entries.push({
                    url: href,
                    quality: qualityText || 'Download',
                    size,
                    languages: detectLanguagesFromTitle(qualityText),
                    resolution: quality,
                    buttonText,
                    linkKind,
                    isPack: linkKind === 'batch',
                    season
                });
            });
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
 * Build a Stremio stream object
 */
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
    const behaviorHints = { bingeGroup: 'moviesmod-http' };
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

export async function getMoviesModStreams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
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
        const searchPromises = queries.map(q => searchMoviesMod(q).then(results => ({ query: q, results })));
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

        const best = type === 'series'
            ? chooseBestSeriesMatch(searchResults, meta.name, season)
            : getSortedMatches(searchResults, meta.name)[0];
        if (!best?.url) {
            console.log(`[${PROVIDER}] No suitable match for ${meta.name}`);
            return [];
        }

        console.log(`[${PROVIDER}] Selected match: ${best.title} -> ${best.url}`);
        let downloadEntries = await loadMoviesModPage(best.url);
        if (downloadEntries.length === 0) {
            console.log(`[${PROVIDER}] No download entries found`);
            return [];
        }

        if (type === 'series') {
            const beforeCount = downloadEntries.length;
            downloadEntries = filterSeriesEntries(downloadEntries, season, episode);
            console.log(`[${PROVIDER}] Series filtering reduced entries ${beforeCount} -> ${downloadEntries.length} for S${season ?? '?'}E${episode ?? '?'}`);
            if (downloadEntries.length === 0) {
                console.log(`[${PROVIDER}] No relevant episode entries after series filtering`);
                return [];
            }
        }

        // Lazy-load mode (default): return preview streams
        if (isLazyLoadEnabled()) {
            console.log(`[${PROVIDER}] Lazy-load: returning ${downloadEntries.length} preview streams`);

            const previewStreams = downloadEntries.map(entry => {
                const label = entry.quality || 'Download';
                const languages = entry.languages?.length
                    ? entry.languages
                    : detectLanguagesFromTitle(entry.quality || '');
                return createPreviewStream({
                    url: entry.url,
                    label,
                    provider: PROVIDER,
                    size: entry.size,
                    languages
                });
            });

            return formatPreviewStreams(previewStreams, encodeUrlForStreaming, renderLanguageFlags);
        }

        // Full extraction mode
        const streamPromises = downloadEntries.map(async (entry) => {
            try {
                const extracted = await processExtractorLinkWithAwait(entry.url, 2);
                if (extracted?.length) {
                    return extracted.map(r => buildStream(r, entry)).filter(Boolean);
                }

                const needsArchiveFallback = ARCHIVE_FALLBACK_HOSTS.some(host => entry.url?.includes(host));
                if (!needsArchiveFallback) return [];

                console.log(`[${PROVIDER}] No extractor match for archive URL, trying resolver fallback: ${entry.url}`);
                const resolvedUrl = await resolveHttpStreamUrl(entry.url);
                if (!resolvedUrl) {
                    console.log(`[${PROVIDER}] Resolver fallback failed for ${entry.url}`);
                    return [];
                }

                const fallbackResult = {
                    url: resolvedUrl,
                    name: entry.quality || 'MoviesMod',
                    title: entry.quality || 'MoviesMod'
                };
                return [buildStream(fallbackResult, entry)].filter(Boolean);
            } catch (err) {
                console.log(`[${PROVIDER}] Extraction failed for ${entry.url}: ${err.message}`);
                return [];
            }
        });

        const resolved = (await Promise.all(streamPromises)).flat().filter(Boolean);

        // Deduplicate by URL
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
