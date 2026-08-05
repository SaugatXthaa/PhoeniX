/**
 * 111477 Streams
 * Builds HTTP streams from a.111477.xyz directory listings.
 */

import Cinemeta from '../../../util/cinemeta.js';
import { detectLanguagesFromTitle, renderLanguageFlags } from '../../../util/language-mapping.js';
import { formatSize, getResolutionFromName, getSortedMatches, removeYear, generateAlternativeQueries } from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { createPreviewStream, formatPreviewStreams } from '../../utils/preview-mode.js';
import { isValidVideo } from '../../../common/torrent-utils.js';
import { load111477Content, scrape111477Search } from './search.js';

const PROVIDER = '111477';
const BULK_BASE_URL = (process.env.HTTP_111477_BULK_BASE_URL || 'https://p.111477.xyz/bulk').replace(/\/+$/, '');
const MAX_PREVIEW_STREAMS = parseInt(process.env.MAX_111477_PREVIEW_LINKS, 10) || 20;

function buildBulkUrl(sourceUrl) {
    try {
        const url = new URL(BULK_BASE_URL);
        url.searchParams.set('u', sourceUrl);
        return url.toString();
    } catch {
        return `${BULK_BASE_URL}?u=${encodeURIComponent(sourceUrl)}`;
    }
}

function rankFileEntries(entries = []) {
    const resolutionOrder = {
        '2160p': 5,
        '1080p': 4,
        '720p': 3,
        '540p': 2,
        '480p': 1,
        'other': 0
    };

    return [...entries].sort((a, b) => {
        const resolutionDiff = (resolutionOrder[getResolutionFromName(b.name)] || 0) - (resolutionOrder[getResolutionFromName(a.name)] || 0);
        if (resolutionDiff !== 0) return resolutionDiff;
        return (b.sizeBytes || 0) - (a.sizeBytes || 0);
    });
}

function toPreviewEntries(entries = []) {
    return rankFileEntries(entries)
        .filter(entry => entry?.url && isValidVideo(entry.name, entry.sizeBytes || 0, 50 * 1024 * 1024, PROVIDER))
        .map(entry => {
            const label = entry.name;
            return createPreviewStream({
                url: buildBulkUrl(entry.url),
                label,
                provider: PROVIDER,
                size: entry.sizeBytes ? formatSize(entry.sizeBytes) : null,
                languages: detectLanguagesFromTitle(label)
            });
        })
        .filter(Boolean)
        .slice(0, MAX_PREVIEW_STREAMS);
}

export async function get111477Streams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        let meta = prefetchedMeta;
        if (!meta) {
            meta = await Cinemeta.getMeta(type, tmdbId);
        }

        if (!meta?.name) {
            console.log(`[${PROVIDER}] No metadata for ${tmdbId}, skipping`);
            return [];
        }

        const queries = Array.from(new Set([
            meta.name,
            removeYear(meta.name),
            ...generateAlternativeQueries(meta.name, meta.original_title || '')
        ])).filter(Boolean);

        let searchResults = [];
        for (const query of queries) {
            const results = await scrape111477Search(query, type, meta.year || null, meta.original_title || null);
            if (results.length > 0) {
                searchResults = searchResults.concat(results);
            }
        }

        if (searchResults.length === 0) {
            console.log(`[${PROVIDER}] No search results for "${meta.name}"`);
            return [];
        }

        const deduped = Array.from(
            new Map(searchResults.map(result => [result.url, result])).values()
        );

        const rankedMatches = getSortedMatches(deduped, meta.name, { minScore: 20 });
        const candidatesToTry = rankedMatches.length > 0 ? rankedMatches.slice(0, 3) : deduped.slice(0, 3);

        let selectedContent = null;
        for (const candidate of candidatesToTry) {
            const content = await load111477Content(candidate, type, season, episode);
            if (content.fileEntries?.length) {
                selectedContent = content;
                break;
            }
        }

        if (!selectedContent?.fileEntries?.length) {
            console.log(`[${PROVIDER}] No file entries found for "${meta.name}"`);
            return [];
        }

        const previews = toPreviewEntries(selectedContent.fileEntries);
        if (previews.length === 0) {
            console.log(`[${PROVIDER}] No valid preview streams found`);
            return [];
        }

        const streams = formatPreviewStreams(previews, encodeUrlForStreaming, renderLanguageFlags)
            .map((stream, index) => ({
                ...stream,
                httpProvider: PROVIDER,
                behaviorHints: {
                    ...stream.behaviorHints,
                    fileName: previews[index]?.label || stream.behaviorHints?.fileName,
                    bingeGroup: '111477-streams'
                }
            }));

        console.log(`[${PROVIDER}] Returning ${streams.length} preview stream(s)`);
        return streams;
    } catch (error) {
        console.log(`[${PROVIDER}] Error getting streams: ${error.message}`);
        return [];
    }
}
