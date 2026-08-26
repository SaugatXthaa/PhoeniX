// lib/util/cinemeta.js
// Faithful port of sootio-stremio-addon/lib/util/cinemeta.js
// Metadata lookup chain: Cinemeta → TMDB → IMDB scrape
// All cache layers in-memory only (no SQLite/Postgres for simplicity)

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// In-memory cache for Cinemeta results
const metaCache = new Map();
const metaFetchInFlight = new Map(); // Deduplicates concurrent requests for same IMDB ID
const altTitleFetchInFlight = new Map();
const CINEMETA_CACHE_TTL_MS = parseInt(process.env.CINEMETA_CACHE_TTL_MS || '3600000', 10); // 1 hour
const CINEMETA_TIMEOUT_MS = parseInt(process.env.CINEMETA_TIMEOUT_MS || '12000', 10);
const CINEMETA_SLOW_THRESHOLD_MS = parseInt(process.env.CINEMETA_SLOW_THRESHOLD_MS || '4000', 10);
const CINEMETA_MAX_RETRIES = parseInt(process.env.CINEMETA_MAX_RETRIES || '1', 10);
const CINEMETA_RETRY_DELAY_MS = parseInt(process.env.CINEMETA_RETRY_DELAY_MS || '800', 10);
const CINEMETA_BASE_URLS = (process.env.CINEMETA_BASE_URLS || 'https://v3-cinemeta.strem.io,https://cinemeta.strem.io')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
const CINEMETA_FALLBACK_TO_IMDB = process.env.CINEMETA_FALLBACK_TO_IMDB !== 'false';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_FALLBACK_ENABLED = process.env.TMDB_FALLBACK_ENABLED !== 'false';
const TMDB_TIMEOUT_MS = parseInt(process.env.TMDB_TIMEOUT_MS || '8000', 10);
const IMDB_ALT_TIMEOUT_MS = parseInt(process.env.IMDB_ALT_TIMEOUT_MS || '8000', 10);

function isRetryableCinemetaError(err) {
    const code = err?.code || err?.cause?.code;
    const message = String(err?.message || '').toLowerCase();
    const retryableCodes = new Set([
        'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
        'ECONNABORTED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'
    ]);
    if (code && retryableCodes.has(code)) return true;
    if (message.includes('socket hang up')) return true;
    return false;
}

function isCacheableNullStatus(status) {
    return status === 404 || status === 410;
}

function extractYear(text) {
    if (!text) return null;
    const match = String(text).match(/\b(19\d{2}|20\d{2})\b/);
    return match ? match[1] : null;
}

function normalizeType(type = '') {
    if (type === 'tv') return 'series';
    return type;
}

function normalizeTmdbType(type = '') {
    if (type === 'series') return 'tv';
    return type === 'movie' ? 'movie' : type;
}

function parseTmdbId(id) {
    if (!id) return null;
    const str = String(id).trim();
    if (!str) return null;
    if (/^\d{3,}$/.test(str)) return str;
    const match = str.match(/tmdb[^0-9]*([0-9]{3,})/i) || str.match(/\/(movie|tv)\/([0-9]{3,})/i);
    if (match) return match[2] || match[1];
    return null;
}

async function tmdbFetchJson(url, label) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            console.warn(`[Cinemeta] TMDB ${label} failed with status ${response.status}`);
            return null;
        }
        return await response.json();
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error(`[Cinemeta] TMDB ${label} timeout after ${TMDB_TIMEOUT_MS}ms`);
        } else {
            console.error(`[Cinemeta] TMDB ${label} error:`, err.message);
        }
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

function buildTmdbMetaFromDetails(details, type, imdbId, tmdbId) {
    if (!details) return null;
    const title = details.title || details.name || details.original_title || details.original_name;
    const date = details.release_date || details.first_air_date || '';
    const year = extractYear(date) || undefined;
    if (!title) return null;
    return {
        name: title,
        year,
        imdb_id: imdbId && String(imdbId).startsWith('tt') ? imdbId : undefined,
        type,
        moviedb_id: tmdbId || details.id,
        tmdb_id: tmdbId || details.id
    };
}

async function fetchTmdbFallbackMeta(type, imdbId) {
    if (!TMDB_API_KEY || !TMDB_FALLBACK_ENABLED) return null;
    const normalizedType = normalizeTmdbType(type);
    const tmdbId = parseTmdbId(imdbId);

    try {
        if (tmdbId) {
            console.warn(`[Cinemeta] Falling back to TMDB metadata for TMDB ID ${tmdbId}`);
            const details = await tmdbFetchJson(
                `https://api.themoviedb.org/3/${normalizedType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`,
                `${normalizedType}:${tmdbId}`
            );
            return buildTmdbMetaFromDetails(details, type, null, tmdbId);
        }

        if (imdbId && String(imdbId).startsWith('tt')) {
            console.warn(`[Cinemeta] Falling back to TMDB metadata for IMDB ID ${imdbId}`);
            const find = await tmdbFetchJson(
                `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`,
                `find:${imdbId}`
            );
            if (!find) return null;
            const candidates = normalizedType === 'tv' ? (find.tv_results || []) : (find.movie_results || []);
            const first = candidates[0] || (find.movie_results || [])[0] || (find.tv_results || [])[0];
            if (!first?.id) return null;
            const details = await tmdbFetchJson(
                `https://api.themoviedb.org/3/${normalizedType}/${first.id}?api_key=${TMDB_API_KEY}&language=en-US`,
                `${normalizedType}:${first.id}`
            );
            return buildTmdbMetaFromDetails(details, type, imdbId, first.id);
        }
    } catch (err) {
        console.error('[Cinemeta] TMDB fallback error:', err.message);
    }
    return null;
}

async function fetchImdbFallbackMeta(type, imdbId) {
    try {
        console.warn(`[Cinemeta] Falling back to IMDB metadata for ${imdbId}`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), IMDB_ALT_TIMEOUT_MS);

        const response = await fetch(`https://www.imdb.com/title/${imdbId}/`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            signal: controller.signal
        }).finally(() => clearTimeout(timeoutId));

        if (!response.ok) {
            console.error(`[Cinemeta] IMDB fallback failed with status ${response.status} for ${imdbId}`);
            return null;
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        let name = '';
        let year = '';

        const titleTag = $('title').first().text().trim();
        const titleMatch = titleTag.match(/^(.*?)\s*\((\d{4})(?:–\d{4})?\)\s*-\s*IMDb$/i);
        if (titleMatch) {
            name = titleMatch[1].trim();
            year = titleMatch[2];
        }

        if (!name) {
            const mainTitle = $('h1[data-testid="hero__pageTitle"] span').first().text().trim();
            if (mainTitle) name = mainTitle;
        }

        if (!year) {
            const yearCandidates = [
                $('a[href*="releaseinfo"]').first().text().trim(),
                $('span[data-testid="release-year"]').first().text().trim(),
                $('ul[data-testid="hero-title-block__metadata"] li').first().text().trim()
            ];
            for (const candidate of yearCandidates) {
                const parsedYear = extractYear(candidate);
                if (parsedYear) {
                    year = parsedYear;
                    break;
                }
            }
        }

        if (!name) {
            console.error(`[Cinemeta] IMDB fallback could not parse title for ${imdbId}`);
            return null;
        }

        return {
            name,
            year: year || undefined,
            imdb_id: imdbId,
            type
        };
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error(`[Cinemeta] IMDB fallback timeout after ${IMDB_ALT_TIMEOUT_MS}ms for ${imdbId}`);
        } else {
            console.error(`[Cinemeta] IMDB fallback error for ${imdbId}:`, err.message);
        }
        return null;
    }
}

async function fetchImdbAlternativeTitles(imdbId) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), IMDB_ALT_TIMEOUT_MS);

        const response = await fetch(`https://www.imdb.com/title/${imdbId}/`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            signal: controller.signal
        }).finally(() => clearTimeout(timeoutId));

        if (!response.ok) return [];

        const html = await response.text();
        const $ = cheerio.load(html);

        const titles = new Set();
        const mainTitle = $('h1[data-testid="hero__pageTitle"] span').first().text().trim();
        if (mainTitle) titles.add(mainTitle);

        const originalTitle = $('div[data-testid="hero__pageTitle"] ul li:contains("Original title:")').text().replace('Original title:', '').trim();
        if (originalTitle) titles.add(originalTitle);

        const akaSection = $('li[data-testid="title-details-akas"]');
        if (akaSection.length > 0) {
            const akaText = akaSection.find('a, button, span').text();
            if (akaText && !akaText.includes('See more')) {
                const cleanedText = akaText
                    .replace(/Also known as\s*/gi, '')
                    .replace(/AKA\s*/gi, '');
                const akas = cleanedText.split(/[,;]/).map(t => t.trim()).filter(t => t.length > 0);
                akas.forEach(aka => titles.add(aka));
            }
        }

        return Array.from(titles).filter(t => t.length > 0 && t.length < 100);
    } catch (err) {
        return [];
    }
}

async function fetchMeta(type, imdbId, cacheKey) {
    let lastError = null;
    let lastStatus = null;
    let hadNetworkError = false;
    const baseUrls = CINEMETA_BASE_URLS.length ? CINEMETA_BASE_URLS : ['https://v3-cinemeta.strem.io'];

    for (const baseUrl of baseUrls) {
        for (let attempt = 0; attempt <= CINEMETA_MAX_RETRIES; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CINEMETA_TIMEOUT_MS);
                const startTime = Date.now();

                const safeBase = baseUrl.replace(/\/+$/, '');
                const response = await fetch(`${safeBase}/meta/${type}/${imdbId}.json`, {
                    signal: controller.signal
                }).finally(() => clearTimeout(timeoutId));

                const duration = Date.now() - startTime;
                if (duration >= CINEMETA_SLOW_THRESHOLD_MS) {
                    console.error(`[Cinemeta] Slow metadata response (${duration}ms) for ${type}:${imdbId} via ${safeBase}`);
                }

                if (!response.ok) {
                    lastStatus = response.status;
                    if (response.status >= 500 && attempt < CINEMETA_MAX_RETRIES) {
                        console.warn(`[Cinemeta] ${response.status} from Cinemeta (${safeBase}), retrying (${attempt + 1}/${CINEMETA_MAX_RETRIES})`);
                        await new Promise(resolve => setTimeout(resolve, CINEMETA_RETRY_DELAY_MS));
                        continue;
                    }
                    if (isCacheableNullStatus(response.status)) {
                        metaCache.set(cacheKey, { data: null, timestamp: Date.now() });
                    }
                    console.error(`[Cinemeta] Received a ${response.status} response for ${type}:${imdbId} via ${safeBase}`);
                    break;
                }

                const body = await response.json();
                const meta = body && body.meta;

                metaCache.set(cacheKey, { data: meta, timestamp: Date.now() });

                // Background-fetch alternative titles from IMDB
                if (meta && process.env.ENABLE_IMDB_ALTERNATIVE_TITLES !== 'false') {
                    if (!altTitleFetchInFlight.has(imdbId)) {
                        const altFetchPromise = fetchImdbAlternativeTitles(imdbId)
                            .then(altTitles => {
                                if (altTitles.length > 0) {
                                    meta.alternativeTitles = altTitles;
                                    metaCache.set(cacheKey, { data: meta, timestamp: Date.now() });
                                }
                            })
                            .catch(() => {})
                            .finally(() => {
                                altTitleFetchInFlight.delete(imdbId);
                            });

                        altTitleFetchInFlight.set(imdbId, altFetchPromise);
                    }
                }

                return meta;
            } catch (err) {
                lastError = err;
                if (isRetryableCinemetaError(err) || err.name === 'AbortError' || err.name === 'SyntaxError') {
                    hadNetworkError = true;
                }
                if (err.name === 'AbortError') {
                    console.error(`[Cinemeta] Metadata timeout after ${CINEMETA_TIMEOUT_MS}ms for ${type}:${imdbId} via ${baseUrl}`);
                } else {
                    console.error(`[Cinemeta] A network or parsing error occurred:`, err.message);
                }
                if (attempt < CINEMETA_MAX_RETRIES && isRetryableCinemetaError(err)) {
                    await new Promise(resolve => setTimeout(resolve, CINEMETA_RETRY_DELAY_MS));
                    continue;
                }
                break;
            }
        }
    }

    // Fall back to TMDB
    const tmdbIdCandidate = parseTmdbId(imdbId);
    const shouldFallbackToTmdb = TMDB_FALLBACK_ENABLED && TMDB_API_KEY && (
        hadNetworkError || (lastStatus && lastStatus >= 400) || tmdbIdCandidate
    );
    if (shouldFallbackToTmdb) {
        const tmdbMeta = await fetchTmdbFallbackMeta(type, imdbId);
        if (tmdbMeta) {
            metaCache.set(cacheKey, { data: tmdbMeta, timestamp: Date.now() });
            return tmdbMeta;
        }
    }

    // Fall back to IMDB scrape
    const shouldFallbackToImdb = CINEMETA_FALLBACK_TO_IMDB && (
        hadNetworkError || (lastStatus && lastStatus >= 400)
    );
    if (shouldFallbackToImdb) {
        const fallbackMeta = await fetchImdbFallbackMeta(type, imdbId);
        if (fallbackMeta) {
            metaCache.set(cacheKey, { data: fallbackMeta, timestamp: Date.now() });
            return fallbackMeta;
        }
    }

    if (hadNetworkError) {
        const cached = metaCache.get(cacheKey);
        if (cached?.data) {
            console.warn(`[Cinemeta] Returning stale cache for ${imdbId} after retries exhausted`);
            return cached.data;
        }
    }
    return null;
}

async function getMeta(type, imdbId) {
    const normalizedType = normalizeType(type);

    // Check in-memory cache first
    const cacheKey = `${normalizedType}:${imdbId}`;
    const cached = metaCache.get(cacheKey);
    const cacheAgeMs = cached ? (Date.now() - cached.timestamp) : null;
    if (cached && cacheAgeMs < CINEMETA_CACHE_TTL_MS) {
        return cached.data;
    }

    // Stale-while-revalidate: serve stale cache + background refresh
    if (cached && cacheAgeMs != null) {
        if (!metaFetchInFlight.has(cacheKey)) {
            const refreshPromise = (async () => {
                return await fetchMeta(normalizedType, imdbId, cacheKey);
            })();
            metaFetchInFlight.set(cacheKey, refreshPromise);
            refreshPromise.finally(() => metaFetchInFlight.delete(cacheKey));
        }
        return cached.data;
    }

    // Coalesce concurrent requests
    if (metaFetchInFlight.has(cacheKey)) {
        return metaFetchInFlight.get(cacheKey);
    }

    const fetchPromise = fetchMeta(normalizedType, imdbId, cacheKey);
    metaFetchInFlight.set(cacheKey, fetchPromise);
    fetchPromise.finally(() => {
        metaFetchInFlight.delete(cacheKey);
    });

    return fetchPromise;
}

export default { getMeta };
export { getMeta };
