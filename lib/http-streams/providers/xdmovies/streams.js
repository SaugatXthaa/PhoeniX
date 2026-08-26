/**
 * XDMovies Streams
 * Builds Stremio preview streams from the XDMovies API worker.
 */

import Cinemeta from '../../../util/cinemeta.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { scrapeXDMoviesSearch, loadXDMoviesContent } from './search.js';
import {
    removeYear,
    generateAlternativeQueries,
    getSortedMatches
} from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { createPreviewStream, formatPreviewStreams } from '../../utils/preview-mode.js';

const PROVIDER = 'XDMovies';

function compactText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseYear(value) {
    const parsed = parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function resolveTmdbId(meta) {
    if (!meta) return null;

    const candidates = [
        meta.moviedb_id,
        meta.moviedbId,
        meta.movieDbId,
        meta.tmdb_id,
        meta.tmdbId
    ];

    if (meta.ids) {
        if (Array.isArray(meta.ids)) {
            candidates.push(...meta.ids);
        } else if (typeof meta.ids === 'object') {
            candidates.push(...Object.values(meta.ids));
        }
    }

    if (meta.externalIds && typeof meta.externalIds === 'object') {
        candidates.push(...Object.values(meta.externalIds));
    }

    for (const candidate of candidates) {
        if (!candidate) continue;
        const str = String(candidate).trim();
        if (/^\d{3,}$/.test(str)) return str;

        const match = str.match(/tmdb[^0-9]*([0-9]{3,})/i) || str.match(/\/(?:movie|tv)\/([0-9]{3,})/i);
        if (match?.[1]) return match[1];
    }

    return null;
}

function chooseBestMatch(results, query, expectedYear = null, tmdbId = null) {
    if (!Array.isArray(results) || !results.length) return null;

    if (tmdbId) {
        const exact = results.find(item => String(item?.tmdbId || '') === String(tmdbId));
        if (exact) return exact;
    }

    const ranked = getSortedMatches(results, query, { minScore: 20 }).map(item => {
        let adjustedScore = item.score || 0;
        if (expectedYear && item.year && item.year === expectedYear) adjustedScore += 15;
        if (tmdbId && item.tmdbId && String(item.tmdbId) === String(tmdbId)) adjustedScore += 100;
        return { ...item, adjustedScore };
    }).sort((a, b) => (b.adjustedScore || 0) - (a.adjustedScore || 0));

    return ranked[0] || null;
}

function hasEpisodeMarker(text = '') {
    return /\bS\d{1,2}E\d{1,2}\b/i.test(text)
        || /\bSeason\s*\d+\b/i.test(text)
        || /\bEpisode\s*\d+\b/i.test(text);
}

function matchesEpisode(text = '', season, episode) {
    if (!season || !episode) return false;
    const numericSeason = parseInt(season, 10);
    const numericEpisode = parseInt(episode, 10);
    if (!Number.isFinite(numericSeason) || !Number.isFinite(numericEpisode)) return false;

    const paddedSeason = String(numericSeason).padStart(2, '0');
    const paddedEpisode = String(numericEpisode).padStart(2, '0');
    return new RegExp(`\\bS0*${numericSeason}E0*${numericEpisode}\\b`, 'i').test(text)
        || (
            new RegExp(`\\bSeason\\s*${numericSeason}\\b`, 'i').test(text)
            && new RegExp(`\\bEpisode\\s*${numericEpisode}\\b`, 'i').test(text)
        )
        || text.includes(`S${paddedSeason}E${paddedEpisode}`);
}

function matchesSeason(text = '', season) {
    if (!season) return false;
    const numericSeason = parseInt(season, 10);
    if (!Number.isFinite(numericSeason)) return false;

    return new RegExp(`\\bSeason\\s*${numericSeason}\\b`, 'i').test(text)
        || new RegExp(`\\bS0*${numericSeason}\\b`, 'i').test(text);
}

function matchesEpisodeNumber(text = '', episode) {
    if (!episode) return false;
    const numericEpisode = parseInt(episode, 10);
    if (!Number.isFinite(numericEpisode)) return false;
    return new RegExp(`\\bEpisode\\s*${numericEpisode}\\b`, 'i').test(text)
        || new RegExp(`\\bE0*${numericEpisode}\\b`, 'i').test(text);
}

function filterSeriesEntries(entries, season, episode) {
    if (!Array.isArray(entries) || !entries.length) return [];
    if (!season && !episode) return entries;

    const withContext = entries.map(entry => ({
        ...entry,
        searchText: compactText(`${entry.label || ''} ${entry.quality || ''}`)
    }));

    if (season && episode) {
        const exactEpisode = withContext.filter(entry => matchesEpisode(entry.searchText, season, episode));
        if (exactEpisode.length) return exactEpisode;
    }

    if (season) {
        const seasonMatches = withContext.filter(entry => matchesSeason(entry.searchText, season));
        if (seasonMatches.length) return seasonMatches;
    }

    if (episode) {
        const episodeOnly = withContext.filter(entry => matchesEpisodeNumber(entry.searchText, episode));
        if (episodeOnly.length) return episodeOnly;
    }

    const genericEntries = withContext.filter(entry => !hasEpisodeMarker(entry.searchText));
    return genericEntries.length ? genericEntries : withContext;
}

function buildLabel(entry, fallbackTitle) {
    const parts = [
        compactText(entry?.label || ''),
        compactText(entry?.quality || '')
    ].filter(Boolean);

    const combined = compactText(parts.join(' | '));
    return combined || compactText(fallbackTitle) || 'Download';
}

export async function getXDMoviesStreams(id, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        let meta = prefetchedMeta;
        if (!meta) {
            console.log(`[${PROVIDER}] Fetching metadata for ${id}...`);
            meta = await Cinemeta.getMeta(type, id);
        }

        if (!meta?.name) {
            console.log(`[${PROVIDER}] No metadata for ${id}, skipping`);
            return [];
        }

        const tmdbId = resolveTmdbId(meta);
        const year = parseYear(meta.year);
        const alternativeTitles = Array.from(new Set([
            ...(Array.isArray(meta.alternativeTitles) ? meta.alternativeTitles : []),
            ...(Array.isArray(meta.alternative_titles) ? meta.alternative_titles : [])
        ].filter(Boolean)));

        const queries = Array.from(new Set([
            meta.name,
            removeYear(meta.name),
            meta.original_title,
            meta.originalTitle,
            ...generateAlternativeQueries(meta.name, meta.original_title || meta.originalTitle || '')
        ])).filter(Boolean);

        console.log(
            `[${PROVIDER}] Searching for "${meta.name}" (${type}${season != null ? ` S${season}E${episode}` : ''}${tmdbId ? `, TMDB ${tmdbId}` : ''})`
        );

        let searchResults = [];
        for (const query of queries) {
            searchResults = await scrapeXDMoviesSearch(query, {
                type,
                year,
                originalTitle: meta.original_title || meta.originalTitle || null,
                alternativeTitles,
                tmdbId
            });
            if (searchResults.length) break;
        }

        if (!searchResults.length) {
            console.log(`[${PROVIDER}] No search results for "${meta.name}"`);
            return [];
        }

        const bestMatch = chooseBestMatch(searchResults, meta.name, year, tmdbId);
        if (!bestMatch?.url) {
            console.log(`[${PROVIDER}] No suitable match found`);
            return [];
        }

        console.log(`[${PROVIDER}] Best match: "${bestMatch.title}" -> ${bestMatch.url}`);

        const content = await loadXDMoviesContent(bestMatch.url, type);
        let downloadEntries = Array.isArray(content.downloadEntries) ? content.downloadEntries : [];

        if (type === 'series') {
            const filteredEntries = filterSeriesEntries(downloadEntries, season, episode);
            if (filteredEntries.length) {
                downloadEntries = filteredEntries;
            }
        }

        if (!downloadEntries.length) {
            console.log(`[${PROVIDER}] No download links found in detail response`);
            return [];
        }

        const fallbackTitle = content.title || bestMatch.title || meta.name;
        const previews = downloadEntries.map(entry => {
            const label = buildLabel(entry, fallbackTitle);
            const languages = Array.from(new Set([
                ...(Array.isArray(entry.languages) ? entry.languages : []),
                ...detectLanguagesFromTitle(label),
                ...detectLanguagesFromTitle(fallbackTitle)
            ].filter(Boolean)));

            return createPreviewStream({
                url: entry.url,
                label,
                provider: PROVIDER,
                size: entry.size || null,
                languages
            });
        }).filter(Boolean);

        const formatted = formatPreviewStreams(previews, encodeUrlForStreaming, renderLanguageFlags)
            .map(stream => ({
                ...stream,
                behaviorHints: { ...stream.behaviorHints, bingeGroup: 'xdmovies-streams' }
            }));

        console.log(`[${PROVIDER}] Returning ${formatted.length} stream(s)`);
        return formatted;
    } catch (error) {
        console.error(`[${PROVIDER}] Error: ${error.message}`);
        return [];
    }
}
