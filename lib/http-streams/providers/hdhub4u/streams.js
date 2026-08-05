/**
 * HDHub4u Streams
 * Converts HDHub4u download links into direct HTTP streams
 */

import Cinemeta from '../../../util/cinemeta.js';
import {
    renderLanguageFlags,
    detectLanguagesFromTitle
} from '../../../util/language-mapping.js';
import {
    getResolutionFromName,
    removeYear,
    generateAlternativeQueries,
    calculateSimilarity,
    normalizeTitle
} from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { validateSeekableUrl } from '../../utils/validation.js';
import { searchHdHub4uPosts, loadHdHub4uPost } from './search.js';
import { processExtractorLinkWithAwait } from '../4khdhub/extraction.js';
import { batchExtractFilenames } from './extraction.js';
import { isLazyLoadEnabled, createPreviewStream, formatPreviewStreams } from '../../utils/preview-mode.js';
import { extractFileName } from '../../../common/torrent-utils.js';
import flaresolverrManager from '../../../util/flaresolverr-manager.js';

/**
 * Creates a user-visible error stream when FlareSolverr is unavailable
 * @param {string} reason - Reason for unavailability ('overloaded' or 'rate_limited')
 * @param {Object} options - Additional options
 * @returns {Object} A Stremio-formatted error stream
 */
function createFlareSolverrErrorStream(reason = 'overloaded', options = {}) {
    const { remaining = 0 } = options;
    let title, description;

    if (reason === 'rate_limited') {
        title = '⏳ Rate Limit Reached';
        description = `You've used your FlareSolverr quota for this hour.\n${remaining > 0 ? `${remaining} requests remaining.` : 'Please try again later.'}\n\nHDHub4u | Debrid streams unaffected`;
    } else {
        title = '⚠️ Server Busy';
        description = 'FlareSolverr is processing many requests.\nPlease try again in a moment.\n\nHDHub4u | Debrid streams unaffected';
    }

    return {
        name: `PhoeniX\nBusy`,
        title: `${title}\n${description}`,
        externalUrl: 'https://github.com/sootio/stremio-addon',
        behaviorHints: { notWebReady: true }
    };
}

// Filename extraction is expensive; keep it opt-in for lazy-load preview mode.
const EXTRACT_FILENAMES_IN_LAZY_MODE = process.env.HDHUB4U_EXTRACT_FILENAMES_IN_LAZY_MODE === 'true';
const EXTRACT_FILENAME_TIMEOUT_MS = parseInt(process.env.HDHUB4U_EXTRACT_TIMEOUT_MS, 10) || 2000;
const EXTRACT_FILENAME_CONCURRENCY = parseInt(process.env.HDHUB4U_EXTRACT_CONCURRENCY, 10) || 8;
const EXTRACT_FILENAME_MAX_LINKS = parseInt(process.env.HDHUB4U_EXTRACT_MAX_LINKS, 10) || 20;

const MAX_LINKS = parseInt(process.env.HDHUB4U_MAX_LINKS, 10) || 14;
const MAX_THREAD_COUNT = Math.max(
    1,
    parseInt(process.env.HDHUB4U_THREAD_COUNT || process.env.HDHUB4U_BATCH_SIZE, 10) || 8
);
const SEEK_VALIDATION_ENABLED = process.env.DISABLE_HDHUB4U_SEEK_VALIDATION !== 'true';

// Only hub hosts are now accepted - these are where we get actual file info
const TRUSTED_HOSTS = [
    'hubdrive',
    'hubcloud',
    'hubcdn'
];

const SUSPICIOUS_PATTERNS = [
    'cdn.ampproject.org',
    'bloggingvector.shop'
];

// Keywords that indicate a pack rather than individual episode
const PACK_KEYWORDS = [
    '.zip',
    '.rar',
    '.7z',
    'pack',
    'complete',
    'all episodes',
    'full series',
    'full season',
    's01-s',
    'season pack',
    "ep's",
    'vol1',
    'vol-1',
    'vol 1',
    'vol2',
    'vol-2',
    'vol 2'
];

function hasPackKeyword(filenameLower) {
    if (!filenameLower) return false;
    const isRepack = /\brepack\b/.test(filenameLower);

    return PACK_KEYWORDS.some(keyword => {
        if (keyword === 'pack') {
            return /\bpack\b/.test(filenameLower) && !isRepack;
        }
        return filenameLower.includes(keyword);
    });
}

/**
 * Check if a file is a pack based on filename and size
 * @param {string} filename - The extracted filename
 * @param {string} size - The file size (e.g., "5.9 GB")
 * @param {boolean} isEpisodeRequest - Whether this is for a specific episode
 * @returns {boolean} True if this looks like a pack
 */
function isPackFile(filename, size, isEpisodeRequest = false) {
    if (!filename) return false;

    const filenameLower = filename.toLowerCase();

    // Check for pack keywords in filename
    if (hasPackKeyword(filenameLower)) {
        return true;
    }

    // For episode requests, check if size is suspiciously large (>3GB for a single episode)
    if (isEpisodeRequest && size) {
        const sizeMatch = size.match(/([0-9.]+)\s*(GB|TB)/i);
        if (sizeMatch) {
            const value = parseFloat(sizeMatch[1]);
            const unit = sizeMatch[2].toUpperCase();
            const sizeInGB = unit === 'TB' ? value * 1024 : value;

            let maxEpisodeSizeGb = 5;
            const resolution = getResolutionFromName(filename);
            if (resolution === '2160p' || /\b(4k|uhd)\b/i.test(filenameLower)) {
                maxEpisodeSizeGb = 25;
            } else if (resolution === '1080p') {
                maxEpisodeSizeGb = 8;
            }

            // Packs are typically much larger than single-episode files
            if (sizeInGB > maxEpisodeSizeGb) {
                console.log(`[HDHub4u] Skipping large file (${size}) > ${maxEpisodeSizeGb}GB as likely pack: ${filename}`);
                return true;
            }
        }
    }

    return false;
}

function normalizeLabel(label) {
    return label ? label.replace(/\s+/g, ' ').trim() : '';
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSeasonNumbersFromText(value) {
    const seasons = new Set();
    if (!value) return seasons;

    const text = value.toLowerCase();

    const rangeRegex = /\b(?:s|season[s]?)\s*0*(\d{1,2})\s*(?:-|–|to)\s*(?:s|season)?\s*0*(\d{1,2})\b/gi;
    let match = null;
    while ((match = rangeRegex.exec(text)) !== null) {
        const start = parseInt(match[1], 10);
        const end = parseInt(match[2], 10);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        const min = Math.max(1, Math.min(start, end));
        const max = Math.min(50, Math.max(start, end));
        for (let season = min; season <= max; season += 1) {
            seasons.add(season);
        }
    }

    const singleRegex = /\b(?:season\s*0*(\d{1,2})|s0*(\d{1,2}))(?:\b|e\d+)/gi;
    while ((match = singleRegex.exec(text)) !== null) {
        const valueMatch = parseInt(match[1] || match[2], 10);
        if (Number.isFinite(valueMatch)) {
            seasons.add(valueMatch);
        }
    }

    return seasons;
}

function scoreSeasonMatch(text, requestedSeason) {
    if (!text || !requestedSeason) return 0;
    const seasons = extractSeasonNumbersFromText(text);
    if (seasons.size === 0) return 0;
    return seasons.has(requestedSeason) ? 2 : -1;
}

function getHostname(value) {
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function getEpisodeFromLabel(label) {
    if (!label) return null;
    const match = label.match(/S0*\d+\s*E0*(\d+)/i)
        || label.match(/Episode\s*0*(\d+)/i)
        || label.match(/\bEP\.?\s*0*(\d+)/i);
    if (!match) return null;
    const parsed = parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function prioritizeLinks(downloadLinks, type, season, episode) {
    const requestedSeason = season ? parseInt(season) : null;
    const requestedEpisode = episode ? parseInt(episode) : null;

    return downloadLinks
        .map(link => {
            let priority = 0;

            // Prefer per-episode links for series
            if (type === 'series') {
                if (requestedSeason && link.season === requestedSeason) {
                    priority += 30;
                }
                if (requestedEpisode && link.episode === requestedEpisode) {
                    priority += 40;
                }
                if (!requestedEpisode && requestedSeason && link.label?.includes(`S${requestedSeason}`)) {
                    priority += 20;
                }
            }

            // Prefer higher resolution
            const resolution = getResolutionFromName(link.label);
            if (resolution === '2160p') priority += 25;
            else if (resolution === '1080p') priority += 20;
            else if (resolution === '720p') priority += 10;

            // Prefer HEVC/265 encodes
            if (/HEVC|H265|x265/i.test(link.label)) priority += 5;

            // Slight preference for smaller sizes for faster extraction
            if (link.size && /MB/i.test(link.size)) priority += 3;

            return { ...link, priority };
        })
        .sort((a, b) => b.priority - a.priority);
}

async function processDownloadLink(link, index) {
    try {
        const results = await processExtractorLinkWithAwait(link.url, index + 1);
        if (!results || results.length === 0) {
            return [];
        }

        return results.map(result => ({
            url: result.url,
            name: result.name || 'HDHub4u',
            quality: result.quality || getResolutionFromName(link.label),
            size: link.size,
            sourceLabel: link.label,
            languages: link.languages?.length ? link.languages : detectLanguagesFromTitle(link.label),
            resolverUrl: link.url
        }));
    } catch (error) {
        console.error(`[HDHub4u] Failed to process link ${link.url}:`, error.message);
        return [];
    }
}

async function extractStreamingLinks(downloadLinks, type, season, episode) {
    const prioritized = prioritizeLinks(downloadLinks, type, season, episode);
    const limited = prioritized.slice(0, MAX_LINKS);

    if (limited.length === 0) {
        return [];
    }

    const concurrency = Math.min(MAX_THREAD_COUNT, limited.length);
    console.log(`[HDHub4u] Extracting ${limited.length} links with concurrency ${concurrency}`);

    const results = new Array(limited.length);
    let cursor = 0;

    const worker = async () => {
        while (cursor < limited.length) {
            const currentIndex = cursor++;
            const link = limited[currentIndex];
            results[currentIndex] = await processDownloadLink(link, currentIndex);
        }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    return results.flat();
}

function filterSuspicious(links) {
    return links.filter(link => {
        if (!link.url) return false;
        const lower = link.url.toLowerCase();
        const suspicious = SUSPICIOUS_PATTERNS.some(pattern => lower.includes(pattern));
        if (suspicious) {
            console.log(`[HDHub4u] Filtered suspicious URL: ${link.url}`);
            return false;
        }
        return true;
    });
}

function dedupeLinks(links) {
    const seen = new Set();
    const unique = [];
    for (const link of links) {
        if (!link.url) continue;
        if (!seen.has(link.url)) {
            seen.add(link.url);
            unique.push(link);
        }
    }
    return unique;
}

async function validateLinks(links) {
    if (!links?.length) {
        return [];
    }

    if (process.env.DISABLE_HDHUB4U_URL_VALIDATION === 'true') {
        console.log('[HDHub4u] URL validation disabled via env, but enforcing 206 confirmation');
    }

    if (!SEEK_VALIDATION_ENABLED) {
        console.log('[HDHub4u] Seek validation disabled via env override, forcing 206 confirmation for all links');
    }

    const trusted = [];
    const otherLinks = [];
    for (const link of links) {
        if (!link.url) continue;
        if (TRUSTED_HOSTS.some(host => link.url.includes(host))) {
            trusted.push(link);
        } else {
            otherLinks.push(link);
        }
    }

    const orderedLinks = [...trusted, ...otherLinks];
    const validated = [];

    for (let i = 0; i < orderedLinks.length; i += 4) {
        const slice = orderedLinks.slice(i, i + 4);
        const checks = await Promise.all(slice.map(async (link) => {
            try {
                const result = await validateSeekableUrl(link.url, { requirePartialContent: true });
                if (!result.isValid) {
                    console.log(`[HDHub4u] Dropped link (status ${result.statusCode || 'unknown'}) without confirmed 206 response: ${link.url}`);
                    return null;
                }
                if (result.filename) {
                    link.sourceLabel = `${result.filename} ${link.sourceLabel || ''}`.trim();
                }
                return link;
            } catch (error) {
                console.log(`[HDHub4u] Error validating ${link.url}: ${error.message}`);
                return null;
            }
        }));

        validated.push(...checks.filter(Boolean));
    }

    return validated;
}

function mapToStreams(links) {
    const trustedDirectHosts = ['hubcloud', 'hubcdn', 'pixeldrain', 'r2.dev', 'workers.dev', 'googleusercontent.com'];

    return links.map(link => {
        let resolution = getResolutionFromName(link.sourceLabel);
        if (resolution === 'other') {
            resolution = getResolutionFromName(link.name);
        }

        let resolutionLabel = resolution;
        if (resolution === '2160p') resolutionLabel = '4k';

        const languages = link.languages?.length ? link.languages : detectLanguagesFromTitle(link.sourceLabel);
        const languageFlags = renderLanguageFlags(languages);
        let needsResolution = Boolean(link.resolverUrl);
        const directUrl = encodeUrlForStreaming(link.url);

        const urlLower = (link.url || '').toLowerCase();
        const directIsTrusted = urlLower && trustedDirectHosts.some(host => urlLower.includes(host));

        let streamUrl;
        if (directIsTrusted) {
            needsResolution = false;
            streamUrl = encodeUrlForStreaming(link.url);
        } else {
            const resolverSource = needsResolution ? link.resolverUrl : link.url;
            streamUrl = encodeUrlForStreaming(resolverSource || link.url);
        }
        const size = link.size || extractSizeFromLabel(link.sourceLabel || link.name);
        const fileName = extractFileName(link.sourceLabel || link.name || '');
        const behaviorHints = {
            bingeGroup: 'hdhub4u-streams',
            hdhub4uDirectUrl: directUrl
        };
        if (fileName) {
            behaviorHints.fileName = fileName;
        }

        return {
            name: `PhoeniX\n${resolutionLabel}`,
            title: `${normalizeLabel(link.sourceLabel || link.name)}${languageFlags}\n💾 ${size || 'N/A'} | HDHub4u`,
            url: streamUrl,
            size,
            resolution,
            needsResolution,
            resolverFallbackUrl: directUrl,
            behaviorHints
        };
    });
}

function extractSizeFromLabel(label) {
    if (!label) return null;
    const match = label.match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)/i);
    if (!match) return null;
    return `${match[1]} ${match[2].toUpperCase()}`;
}

function filterEpisodeStreams(streams, season, episode) {
    if (!season || !episode) return streams;
    const requestedSeason = parseInt(season);
    const requestedEpisode = parseInt(episode);

    return streams.filter(stream => {
        const title = stream.title || '';

        // First, check for explicit SxxExx format which is most reliable
        const sxxexxMatch = title.match(/S0*(\d+)\s*E0*(\d+)/i);
        if (sxxexxMatch) {
            const s = parseInt(sxxexxMatch[1]);
            const e = parseInt(sxxexxMatch[2]);
            return s === requestedSeason && e === requestedEpisode;
        }

        // Check for "Episode X" at the START of the title (before any "|" or "–" separators)
        // This avoids matching button text like "Instant EPiSODE 1" at the end
        const titleStart = title.split(/[|–-]/)[0];
        const episodeMatch = titleStart.match(/Episode\s*0*(\d+)/i);
        if (episodeMatch) {
            const e = parseInt(episodeMatch[1]);
            return e === requestedEpisode;
        }

        // Check for "EP X" or "Ep.X" format at the start
        const epMatch = titleStart.match(/\bEP\.?\s*0*(\d+)/i);
        if (epMatch) {
            const e = parseInt(epMatch[1]);
            return e === requestedEpisode;
        }

        // Fallback: no episode marker found, exclude by default for series
        return false;
    });
}

async function findBestMatch(searchResults, targetTitle) {
    let bestMatch = null;
    let bestScore = -Infinity;
    const normalizedTarget = normalizeTitle(targetTitle);

    for (const result of searchResults) {
        const similarity = calculateSimilarity(normalizedTarget, result.slug);
        const score = similarity - (result.score || 0);
        if (score > bestScore) {
            bestScore = score;
            bestMatch = result;
        }
    }

    return bestMatch;
}

export async function getHDHub4uStreams(imdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    // Signal not used in wrapper, but internal functions expect it - set to null
    const signal = null;

    try {
        // Extract clientIp from config for per-IP rate limiting
        const clientIp = config?.clientIp || null;

        // Check FlareSolverr availability early (HDHub4u depends on it for HubCloud extraction)
        // Only return error stream if IP is specifically rate-limited
        if (clientIp && flaresolverrManager.isIpRateLimited(clientIp)) {
            const remaining = flaresolverrManager.getIpRemainingRequests(clientIp);
            console.warn(`[HDHub4u] Client IP ${clientIp} rate limited (${remaining} remaining)`);
            return [createFlareSolverrErrorStream('rate_limited', { remaining })];
        }

        // Use pre-fetched metadata if available, otherwise fetch it (fallback for direct calls)
        let cinemetaDetails = prefetchedMeta;
        if (!cinemetaDetails) {
            console.log(`[HDHub4u] No pre-fetched metadata, fetching from Cinemeta...`);
            cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        } else {
            console.log(`[HDHub4u] Using pre-fetched Cinemeta metadata: "${cinemetaDetails.name}"`);
        }

        if (!cinemetaDetails) {
            console.log('[HDHub4u] Cinemeta lookup failed');
            return [];
        }

        const year = cinemetaDetails.year ? parseInt(String(cinemetaDetails.year).split('-')[0]) : null;

        // Build query list: use alternative titles if available, otherwise use standard generation
        let queries = [];
        if (cinemetaDetails.alternativeTitles && cinemetaDetails.alternativeTitles.length > 0) {
            console.log(`[HDHub4u] Using ${cinemetaDetails.alternativeTitles.length} alternative titles for search`);
            queries = cinemetaDetails.alternativeTitles;
        } else {
            queries = generateAlternativeQueries(cinemetaDetails.name, cinemetaDetails.original_title);
        }

        let searchResults = [];
        let usedYearFallback = false;
        for (const query of queries) {
            console.log(`[HDHub4u] Searching with query: "${query}"`);
            const results = await searchHdHub4uPosts(query, 12);
            if (results.length > 0) {
                searchResults = results;
                console.log(`[HDHub4u] Query "${query}" found ${results.length} results`);
                break;
            }
        }

        // Fallback: For recent movies/series with regional title mismatches
        // This helps when Cinemeta has a different title than what's on HDHub4u
        // (e.g., "Vampires of Vijay Nagar" vs "Thamma")
        if (searchResults.length === 0 && year && year >= 2020) {
            console.log(`[HDHub4u] Primary search failed, trying fallback with year ${year}`);

            // For very recent movies, search by year with larger limit
            // Fuse.js prioritizes shorter titles, so we need more results to find longer titles
            const yearResults = await searchHdHub4uPosts(year.toString(), 100);
            if (yearResults.length > 0) {
                searchResults = yearResults;
                usedYearFallback = true;
                console.log(`[HDHub4u] Year-based fallback found ${yearResults.length} results`);
            }
        }

        if (searchResults.length === 0) {
            console.log('[HDHub4u] No search results found');
            return [];
        }

        const isSeries = type === 'series' || type === 'tv';
        if (isSeries && season) {
            const requestedSeason = parseInt(season);
            searchResults.sort((a, b) => {
                const aScore = scoreSeasonMatch(a.slug, requestedSeason);
                const bScore = scoreSeasonMatch(b.slug, requestedSeason);
                if (aScore !== bScore) return bScore - aScore;
                const aFuse = typeof a.score === 'number' ? a.score : 0;
                const bFuse = typeof b.score === 'number' ? b.score : 0;
                return aFuse - bFuse;
            });
        }

        // Try multiple matches to find one with correct year/season
        // For series with season requested, try more matches to find the correct season
        // Check more results since Fuse.js prioritizes shorter titles
        let content = null;
        let matchIndex = 0;
        const needsMultipleAttempts = usedYearFallback || (isSeries && season);
        const maxAttempts = needsMultipleAttempts ? Math.min(80, searchResults.length) : Math.min(12, searchResults.length);

        while (matchIndex < maxAttempts && !content) {
            const bestMatch = searchResults[matchIndex];
            if (!bestMatch) break;

            // When using year fallback, skip very short generic titles (like "55", "Mrs", "G20")
            // to prefer longer, more specific titles that might be regional variations
            if (usedYearFallback) {
                const titleWords = bestMatch.slug.split(/\s+/).filter(w => w.length > 0 && !/^\d{4}$/.test(w)); // Filter out year
                const mainTitle = titleWords.filter(w => {
                    const lowerWord = w.toLowerCase();
                    return !['hindi', 'english', 'webrip', 'bluray', 'full', 'movie', 'series', 'hdtc', 'dubbed', 'dual', 'audio'].includes(lowerWord);
                });

                if (mainTitle.length > 0) {
                    const titleText = mainTitle.join(' ');
                    const titleLength = titleText.replace(/\s+/g, '').length;
                    // Skip if title is very short (1-5 characters) unless we've checked many matches
                    // This helps skip generic abbreviated titles like "55", "Mrs", "HAQ" in favor of
                    // longer regional titles like "Thamma" that might appear later
                    if (titleLength <= 5 && matchIndex < 60) {
                        console.log(`[HDHub4u] Skipping short title "${titleText}" (${titleLength} chars) at position ${matchIndex + 1}, looking for more specific match`);
                        matchIndex++;
                        continue;
                    }
                }
            }

            console.log(`[HDHub4u] Trying match ${matchIndex + 1}: ${bestMatch.slug}`);
            const candidateContent = await loadHdHub4uPost(bestMatch.url, signal);

            if (!candidateContent || !candidateContent.downloadLinks?.length) {
                console.log(`[HDHub4u] No download links found for ${bestMatch.url}`);
                matchIndex++;
                continue;
            }

            // Check year match when using fallback
            if (usedYearFallback && year && candidateContent.year && Math.abs(candidateContent.year - year) > 1) {
                console.log(`[HDHub4u] Year mismatch (${candidateContent.year} vs ${year}), trying next match`);
                matchIndex++;
                continue;
            }

            const normalizedTarget = normalizeTitle(cinemetaDetails.name);
            const normalizedContentTitle = normalizeTitle(candidateContent.title || '');
            const normalizedSlug = normalizeTitle(bestMatch.slug || '');

            // Skip strict title matching for series when using year fallback (helps with regional title mismatches)
            if (type !== 'movie' && normalizedTarget && !normalizedContentTitle.includes(normalizedTarget) && !usedYearFallback) {
                console.log(`[HDHub4u] Skipping content due to title mismatch: "${candidateContent.title}" vs target "${normalizedTarget}"`);
                matchIndex++;
                continue;
            }

            // For movies, enforce a minimum title similarity to avoid wrong matches
            if (type === 'movie' && normalizedTarget) {
                const titleSimilarity = calculateSimilarity(normalizedTarget, normalizedContentTitle);
                const minSimilarity = usedYearFallback ? 0.38 : 0.32;
                const targetWords = normalizedTarget.split(' ').filter(Boolean);
                const allowContainsFallback = targetWords.length > 1 || normalizedTarget.length >= 4;
                const targetPattern = allowContainsFallback ? new RegExp(`\\b${escapeRegExp(normalizedTarget)}\\b`) : null;
                const containsTarget = allowContainsFallback
                    && (targetPattern.test(normalizedContentTitle) || targetPattern.test(normalizedSlug));

                if (titleSimilarity < minSimilarity && !containsTarget) {
                    console.log(`[HDHub4u] Skipping content due to low title similarity (${titleSimilarity.toFixed(3)} < ${minSimilarity}): "${candidateContent.title}"`);
                    matchIndex++;
                    continue;
                }
            }

            // For movies, verify year match
            if (type === 'movie' && year && candidateContent.year && Math.abs(candidateContent.year - year) > 1) {
                console.log(`[HDHub4u] Year mismatch (${candidateContent.year} vs ${year})`);
                matchIndex++;
                continue;
            }

            // For series, verify that the requested season exists in the content
            if ((type === 'series' || type === 'tv') && season) {
                const requestedSeason = parseInt(season);
                const contentTitle = (candidateContent.title || '').toLowerCase();

                // Check if content title mentions a DIFFERENT season
                const titleSeasons = extractSeasonNumbersFromText(contentTitle);
                if (titleSeasons.size > 0 && !titleSeasons.has(requestedSeason)) {
                    const listed = Array.from(titleSeasons).sort((a, b) => a - b).join(', ');
                    console.log(`[HDHub4u] Season mismatch in title: found Season(s) ${listed}, requested Season ${requestedSeason} - "${candidateContent.title}"`);
                    matchIndex++;
                    continue;
                }
                const titleSeasonMatches = titleSeasons.size > 0 && titleSeasons.has(requestedSeason);

                // Also check if any download links have the requested season
                if (!titleSeasonMatches) {
                    const hasRequestedSeason = candidateContent.downloadLinks?.some(link => {
                        const linkSeason = link.season;
                        if (linkSeason === requestedSeason) return true;

                        // Check label for season markers
                        const labelLower = (link.label || '').toLowerCase();
                        const labelSeasonMatch = labelLower.match(/s0*(\d+)|season\s*(\d+)/i);
                        if (labelSeasonMatch) {
                            const labelSeason = parseInt(labelSeasonMatch[1] || labelSeasonMatch[2]);
                            return labelSeason === requestedSeason;
                        }

                        return false;
                    });

                    if (!hasRequestedSeason && candidateContent.downloadLinks?.length > 0) {
                        // Check if links have ANY season info - if they do and none match, skip
                        const hasAnySeasonInfo = candidateContent.downloadLinks.some(link => {
                            const labelLower = (link.label || '').toLowerCase();
                            return link.season || /s\d+|season\s*\d+/i.test(labelLower);
                        });

                        if (hasAnySeasonInfo) {
                            console.log(`[HDHub4u] Content has season info but not Season ${requestedSeason}, skipping "${candidateContent.title}"`);
                            matchIndex++;
                            continue;
                        }
                    }
                }
            }

            // For series, skip candidates that only include different episodes
            if ((type === 'series' || type === 'tv') && episode) {
                const requestedEpisode = parseInt(episode);
                const episodeLinks = (candidateContent.downloadLinks || []).filter(link => {
                    if (link.episode !== null && link.episode !== undefined) {
                        return true;
                    }
                    return getEpisodeFromLabel(link.label || '') !== null;
                });

                if (episodeLinks.length > 0) {
                    const hasRequestedEpisode = episodeLinks.some(link => {
                        if (link.episode !== null && link.episode !== undefined) {
                            return link.episode === requestedEpisode;
                        }
                        return getEpisodeFromLabel(link.label || '') === requestedEpisode;
                    });

                    if (!hasRequestedEpisode) {
                        const knownEpisodes = Array.from(new Set(episodeLinks.map(link => (
                            link.episode ?? getEpisodeFromLabel(link.label || '')
                        )).filter(Number.isFinite))).sort((a, b) => a - b);
                        const listed = knownEpisodes.length > 0 ? knownEpisodes.join(', ') : 'unknown';
                        console.log(`[HDHub4u] Episode mismatch: found Episode(s) ${listed}, requested Episode ${requestedEpisode} - "${candidateContent.title}"`);
                        matchIndex++;
                        continue;
                    }
                }
            }

            // Found a good match!
            content = candidateContent;
            console.log(`[HDHub4u] Using match: ${candidateContent.title}`);
        }

        if (!content) {
            console.log(`[HDHub4u] No suitable content found after checking ${matchIndex} matches`);
            return [];
        }

        // CHECK FOR LAZY-LOAD MODE
        if (isLazyLoadEnabled()) {
            console.log(`[HDHub4u] Lazy-load enabled: returning ${content.downloadLinks.length} preview streams without extraction/validation`);

            // HDHub4u already has rich metadata in downloadLinks!
            let linksToProcess = content.downloadLinks;

            // Filter out "Instant" links - these are low-quality redirect links that often fail
            const beforeInstantFilter = linksToProcess.length;
            linksToProcess = linksToProcess.filter(link => {
                if (link.isInstant === true) return false;
                if (link.isInstant === false) return true;
                const label = link.label || '';
                if (!/\bInstant\b/i.test(label)) return true;
                const host = getHostname(link.url);
                if (host.includes('hubdrive') || host.includes('hubcloud')) return true;
                return false;
            });
            if (linksToProcess.length < beforeInstantFilter) {
                console.log(`[HDHub4u] Filtered out ${beforeInstantFilter - linksToProcess.length} "Instant" links`);
            }

            // PRE-FILTER by episode metadata for series
            if ((type === 'series' || type === 'tv') && season && episode) {
                const requestedSeason = parseInt(season);
                const requestedEpisode = parseInt(episode);

                // Filter links that have episode metadata matching the requested episode
                const episodeFilteredLinks = linksToProcess.filter(link => {
                    // If link has explicit episode number, it must match
                    if (link.episode !== null && link.episode !== undefined) {
                        return link.episode === requestedEpisode;
                    }

                    // Check label for episode markers at the START (before separators)
                    const label = link.label || '';
                    const labelStart = label.split(/[|–]/)[0];

                    // Check for SxxExx format
                    const sxxexxMatch = labelStart.match(/S0*(\d+)\s*E0*(\d+)/i);
                    if (sxxexxMatch) {
                        const e = parseInt(sxxexxMatch[2]);
                        return e === requestedEpisode;
                    }

                    // Check for "Episode X" at the start
                    const episodeMatch = labelStart.match(/Episode\s*0*(\d+)/i);
                    if (episodeMatch) {
                        const e = parseInt(episodeMatch[1]);
                        return e === requestedEpisode;
                    }

                    // Check for "EP X" format
                    const epMatch = labelStart.match(/\bEP\.?\s*0*(\d+)/i);
                    if (epMatch) {
                        const e = parseInt(epMatch[1]);
                        return e === requestedEpisode;
                    }

                    // No episode marker - exclude for series
                    return false;
                });

                if (episodeFilteredLinks.length > 0) {
                    console.log(`[HDHub4u] Pre-filtered to ${episodeFilteredLinks.length} links for Episode ${requestedEpisode}`);
                    linksToProcess = episodeFilteredLinks;
                } else {
                    console.log(`[HDHub4u] No links matched Episode ${requestedEpisode} by metadata, keeping all for title-based filtering`);
                }
            }

            // Prioritize and limit the links
            const prioritized = prioritizeLinks(linksToProcess, type, season, episode);
            const limited = prioritized.slice(0, MAX_LINKS);

            // Optional filename/size extraction (expensive; disabled by default in lazy-load mode)
            let filenameMap = new Map();
            if (EXTRACT_FILENAMES_IN_LAZY_MODE) {
                try {
                    const targets = limited.slice(0, EXTRACT_FILENAME_MAX_LINKS);
                    if (targets.length > 0) {
                        console.log(`[HDHub4u] Extracting file info from ${targets.length} drive links...`);
                        filenameMap = await batchExtractFilenames(targets, {
                            concurrency: EXTRACT_FILENAME_CONCURRENCY,
                            timeoutMs: EXTRACT_FILENAME_TIMEOUT_MS
                        });
                    }
                } catch (err) {
                    console.log(`[HDHub4u] Filename extraction failed: ${err.message}`);
                }
            } else {
                console.log('[HDHub4u] Skipping filename extraction in lazy-load mode');
            }

            // Determine if this is an episode request
            const isEpisodeRequest = (type === 'series' || type === 'tv') && season && episode;

            // Filter out packs and create preview streams
            const previewStreams = [];
            for (const link of limited) {
                const extractedInfo = filenameMap.get(link.url);
                const filename = extractedInfo?.filename || link.label || 'HDHub4u Stream';
                const size = extractedInfo?.size || link.size;

                // Skip packs for episode requests
                if (isEpisodeRequest && isPackFile(filename, size, true)) {
                    console.log(`[HDHub4u] Filtered out pack: ${filename} (${size})`);
                    continue;
                }

                previewStreams.push(createPreviewStream({
                    url: link.url,
                    label: filename,
                    provider: 'HDHub4u',
                    size: size,
                    languages: link.languages || []
                }));
            }

            // If all links were filtered out as packs, return empty
            if (previewStreams.length === 0) {
                console.log('[HDHub4u] All links were filtered out (likely packs). Returning empty.');
                return [];
            }

            // Format for Stremio
            const streams = formatPreviewStreams(previewStreams, encodeUrlForStreaming, renderLanguageFlags);

            // Apply additional episode filtering on formatted titles as fallback
            if ((type === 'series' || type === 'tv') && season && episode) {
                const episodeStreams = filterEpisodeStreams(streams, season, episode);
                if (episodeStreams.length > 0) {
                    console.log(`[HDHub4u] Returning ${episodeStreams.length} preview streams for S${season}E${episode} (lazy-load mode)`);
                    return episodeStreams;
                }

                // No matching episode found - check if all links have DIFFERENT episode markers
                // If so, the requested episode doesn't exist on this page
                const requestedEpisode = parseInt(episode);
                const allHaveDifferentEpisodes = streams.every(stream => {
                    const title = stream.title || '';
                    const titleStart = title.split(/[|–]/)[0];

                    // Check for explicit episode markers
                    const sxxexxMatch = titleStart.match(/S0*(\d+)\s*E0*(\d+)/i);
                    if (sxxexxMatch) {
                        return parseInt(sxxexxMatch[2]) !== requestedEpisode;
                    }

                    const episodeMatch = titleStart.match(/Episode\s*0*(\d+)/i);
                    if (episodeMatch) {
                        return parseInt(episodeMatch[1]) !== requestedEpisode;
                    }

                    const epMatch = titleStart.match(/\bEP\.?\s*0*(\d+)/i);
                    if (epMatch) {
                        return parseInt(epMatch[1]) !== requestedEpisode;
                    }

                    // Check for VOL patterns that indicate episode ranges (e.g., VOL-1 = Ep 1-4)
                    const volMatch = title.match(/VOL[\s.-]*(\d+)/i);
                    if (volMatch) {
                        // VOL-1 typically contains episodes 1-4, VOL-2 contains 5-8, etc.
                        const volNum = parseInt(volMatch[1]);
                        const volStartEp = (volNum - 1) * 4 + 1;
                        const volEndEp = volNum * 4;
                        // If requested episode is outside this volume's range, it's a mismatch
                        if (requestedEpisode < volStartEp || requestedEpisode > volEndEp) {
                            return true;
                        }
                    }

                    // No episode marker found - could potentially contain the episode
                    return false;
                });

                if (allHaveDifferentEpisodes) {
                    console.log(`[HDHub4u] Episode ${episode} not found - all links are for different episodes. Returning empty.`);
                    return [];
                }

                // Some links don't have episode markers - return only those (potential packs)
                const nonEpisodeStreams = streams.filter(stream => {
                    const title = stream.title || '';
                    const titleStart = title.split(/[|–]/)[0];

                    // Exclude streams with explicit wrong episode markers
                    const sxxexxMatch = titleStart.match(/S0*(\d+)\s*E0*(\d+)/i);
                    if (sxxexxMatch && parseInt(sxxexxMatch[2]) !== requestedEpisode) {
                        return false;
                    }

                    const episodeMatch = titleStart.match(/Episode\s*0*(\d+)/i);
                    if (episodeMatch && parseInt(episodeMatch[1]) !== requestedEpisode) {
                        return false;
                    }

                    const epMatch = titleStart.match(/\bEP\.?\s*0*(\d+)/i);
                    if (epMatch && parseInt(epMatch[1]) !== requestedEpisode) {
                        return false;
                    }

                    // Check VOL patterns
                    const volMatch = title.match(/VOL[\s.-]*(\d+)/i);
                    if (volMatch) {
                        const volNum = parseInt(volMatch[1]);
                        const volStartEp = (volNum - 1) * 4 + 1;
                        const volEndEp = volNum * 4;
                        if (requestedEpisode < volStartEp || requestedEpisode > volEndEp) {
                            return false;
                        }
                    }

                    return true;
                });

                if (nonEpisodeStreams.length > 0) {
                    console.log(`[HDHub4u] Returning ${nonEpisodeStreams.length} non-episode-specific streams that may contain Episode ${episode}`);
                    return nonEpisodeStreams;
                }

                console.log(`[HDHub4u] Episode ${episode} not available on this page. Returning empty.`);
                return [];
            }

            console.log(`[HDHub4u] Returning ${streams.length} preview streams (lazy-load mode)`);
            return streams;
        }

        // LEGACY MODE: Full extraction and validation (slow but thorough)
        console.log(`[HDHub4u] Lazy-load disabled: extracting and validating all streams (legacy mode)`);
        const streamingLinks = await extractStreamingLinks(content.downloadLinks, type, season, episode);
        if (streamingLinks.length === 0) {
            console.log('[HDHub4u] No streaming links after extraction');
            return [];
        }

        const filtered = filterSuspicious(streamingLinks);
        const unique = dedupeLinks(filtered);
        const validated = await validateLinks(unique);
        if (validated.length === 0) {
            console.log('[HDHub4u] No validated links remained');
            return [];
        }

        // ALWAYS filter out googleusercontent.com - user requested to NEVER return these
        const googleUserContentCount = validated.filter(link => link.url?.includes('googleusercontent.com')).length;
        const finalValidated = validated.filter(link => !link.url?.includes('googleusercontent.com'));

        if (googleUserContentCount > 0) {
            console.log(`[HDHub4u] Filtered out ${googleUserContentCount} googleusercontent.com link(s), keeping ${finalValidated.length} other links`);
        }

        if (finalValidated.length === 0) {
            console.log('[HDHub4u] No links remaining after filtering googleusercontent.com');
            return [];
        }

        let streams = mapToStreams(finalValidated);
        streams.sort((a, b) => {
            const priority = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1, other: 0 };
            const resDiff = (priority[b.resolution] || 0) - (priority[a.resolution] || 0);
            if (resDiff !== 0) return resDiff;

            // If resolutions are the same, sort by size (larger first)
            // Convert sizes to MB for proper comparison
            const getSizeInMB = (sizeStr) => {
                if (!sizeStr) return 0;
                const match = sizeStr.match(/([0-9.]+)\s*(GB|MB|TB)/i);
                if (!match) return 0;
                const value = parseFloat(match[1]);
                const unit = match[2].toUpperCase();
                if (unit === 'TB') return value * 1024 * 1024;
                if (unit === 'GB') return value * 1024;
                if (unit === 'MB') return value;
                return 0;
            };
            const sizeA = getSizeInMB(a.size);
            const sizeB = getSizeInMB(b.size);
            return sizeB - sizeA;
        });

        if ((type === 'series' || type === 'tv') && season && episode) {
            const episodeStreams = filterEpisodeStreams(streams, season, episode);
            if (episodeStreams.length > 0) {
                streams = episodeStreams;
            }
        }

        console.log(`[HDHub4u] Returning ${streams.length} streams`);
        return streams;
    } catch (error) {
        console.error('[HDHub4u] Error getting streams:', error.message);
        return [];
    }
}

export { filterEpisodeStreams };
