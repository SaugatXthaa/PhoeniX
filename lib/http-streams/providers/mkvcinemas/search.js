/**
 * MKVCinemas search helpers
 * Provides search and post parsing utilities for mkvcinemas.pe
 */

import * as cheerio from 'cheerio';
import crypto from 'crypto';
import axios from 'axios';
import { makeRequest } from '../../utils/http.js';
import { cleanTitle } from '../../utils/parsing.js';
const BASE_URL = 'https://mkvcinemas.ph';

// Cache configuration
const SEARCH_CACHE_TTL = parseInt(process.env.MKVCINEMAS_SEARCH_CACHE_TTL, 10) || 30 * 60 * 1000; // 30 minutes
const CONTENT_CACHE_TTL = parseInt(process.env.MKVCINEMAS_CONTENT_CACHE_TTL, 10) || 10 * 60 * 1000; // 10 minutes
const COOKIE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes — the cookie is valid for a while

// In-memory caches
const searchCache = new Map();
const contentCache = new Map();

// Cached solved cookie: { name, value, ts }
let solvedCookie = null;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function normalizeUrl(href, base = BASE_URL) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

function isJsChallenge(body = '', statusCode = null) {
    if (!body) return false;
    const lower = String(body).toLowerCase();
    if (statusCode === 202 && (lower.includes('/min.js') || lower.includes('please turn javascript'))) return true;
    if (lower.includes('please turn javascript on and reload the page')) return true;
    return false;
}

/**
 * Solve the mkvcinemas AES-128-CBC cookie challenge without a browser.
 * The challenge page contains:
 *   - An obfuscated array with a base64-encoded AES key
 *   - An explicit atob() call with the base64-encoded IV
 *   - A toNumbers() call with the hex ciphertext
 *   - Sets document.cookie with the decrypted value
 */
function solveAesChallenge(html) {
    try {
        // 1. Extract the obfuscated string array
        const arrayMatch = html.match(/var _0x\w+=\[([^\]]+)\]/);
        if (!arrayMatch) return null;

        const strings = [];
        const parts = arrayMatch[1].match(/"[^"]*"/g);
        if (!parts) return null;
        for (const p of parts) {
            const s = p.slice(1, -1).replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            strings.push(s);
        }

        // 2. Key is the last string in the array (base64 -> hex)
        const keyB64 = strings[strings.length - 1];

        // 3. IV is in the explicit atob("...") call
        const ivB64Match = html.match(/atob\("([A-Za-z0-9+/=]+)"\)/);
        if (!ivB64Match) return null;

        // 4. Ciphertext is the last toNumbers("hex") call
        const allHex = [...html.matchAll(/toNumbers\("([a-f0-9]+)"\)/g)].map(m => m[1]);
        if (allHex.length === 0) return null;
        const cipherHex = allHex[allHex.length - 1];

        // 5. Cookie name from document.cookie="Name=..."
        const cookieMatch = html.match(/document\.cookie="([^=]+)=/);
        if (!cookieMatch) return null;

        // 6. AES-128-CBC decrypt
        const keyHex = Buffer.from(keyB64, 'base64').toString();
        const ivHex = Buffer.from(ivB64Match[1], 'base64').toString();
        const key = Buffer.from(keyHex, 'hex');
        const iv = Buffer.from(ivHex, 'hex');
        const ciphertext = Buffer.from(cipherHex, 'hex');

        if (key.length !== 16 || iv.length !== 16) return null;

        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
        decipher.setAutoPadding(false);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

        return { name: cookieMatch[1], value: decrypted.toString('hex') };
    } catch (err) {
        console.warn(`[MKVCinemas] AES challenge solve failed: ${err.message}`);
        return null;
    }
}

/**
 * Fetch a URL, solving the JS anti-bot cookie challenge inline (no browser needed).
 * Flow: GET url → if 202 challenge → solve AES cookie → retry with cookie
 */
async function fetchWithCookieSolver(url) {
    try {
        // If we have a recently solved cookie, try it directly
        if (solvedCookie && Date.now() - solvedCookie.ts < COOKIE_CACHE_TTL) {
            const resp = await axios.get(url, {
                headers: {
                    'User-Agent': BROWSER_UA,
                    'Cookie': `${solvedCookie.name}=${solvedCookie.value}`
                },
                timeout: 10000,
                validateStatus: () => true,
                maxRedirects: 5
            });
            const body = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
            if (!isJsChallenge(body, resp.status)) {
                return {
                    statusCode: resp.status,
                    body,
                    document: cheerio.load(body),
                    headers: resp.headers || {}
                };
            }
            // Cookie expired, need to re-solve
            solvedCookie = null;
        }

        // Step 1: GET the challenge page
        const challengeResp = await axios.get(url, {
            headers: { 'User-Agent': BROWSER_UA },
            timeout: 10000,
            validateStatus: () => true,
            maxRedirects: 0
        });
        const challengeBody = typeof challengeResp.data === 'string' ? challengeResp.data : String(challengeResp.data || '');

        // Not a challenge page — return directly
        if (!isJsChallenge(challengeBody, challengeResp.status)) {
            return {
                statusCode: challengeResp.status,
                body: challengeBody,
                document: cheerio.load(challengeBody),
                headers: challengeResp.headers || {}
            };
        }

        // Step 2: Solve the AES cookie
        const solved = solveAesChallenge(challengeBody);
        if (!solved) {
            console.warn(`[MKVCinemas] Could not solve AES challenge for ${url}`);
            return null;
        }

        // Cache the solved cookie
        solvedCookie = { ...solved, ts: Date.now() };
        console.log(`[MKVCinemas] Solved anti-bot cookie for ${url}`);

        // Step 3: Retry with the solved cookie
        const realResp = await axios.get(url, {
            headers: {
                'User-Agent': BROWSER_UA,
                'Cookie': `${solved.name}=${solved.value}`
            },
            timeout: 10000,
            validateStatus: () => true,
            maxRedirects: 5
        });
        const realBody = typeof realResp.data === 'string' ? realResp.data : String(realResp.data || '');

        // If still challenged, cookie solve didn't work
        if (isJsChallenge(realBody, realResp.status)) {
            console.warn(`[MKVCinemas] Cookie solve didn't bypass challenge for ${url}`);
            solvedCookie = null;
            return null;
        }

        return {
            statusCode: realResp.status,
            body: realBody,
            document: cheerio.load(realBody),
            headers: realResp.headers || {}
        };
    } catch (err) {
        console.warn(`[MKVCinemas] Cookie solver request failed for ${url}: ${err.message}`);
        return null;
    }
}

export async function scrapeMKVCinemasSearch(query, signal = null) {
    if (!query) return [];

    // MKVCinemas search breaks when query contains colons - strip them
    const cleanQuery = query.replace(/:/g, '').replace(/\s+/g, ' ').trim();

    // Check in-memory cache first (only use if we have actual results)
    const cacheKey = cleanQuery.toLowerCase();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL && Array.isArray(cached.data) && cached.data.length > 0) {
        console.log(`[MKVCinemas] Search cache hit (memory) for "${query}"`);
        return cached.data;
    }

    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(cleanQuery)}`;
    try {
        // Primary: solve the AES cookie challenge inline (fast, no browser needed)
        let response = await fetchWithCookieSolver(searchUrl);

        if (!response?.document) return [];

        const $ = response.document;
        const results = [];
        $('article.entry-card').each((_, el) => {
            const anchor = $(el).find('h2.entry-title a');
            const title = anchor.text().trim();
            const url = normalizeUrl(anchor.attr('href'));

            if (!title || !url) return;

            const yearMatch = title.match(/\b(19|20)\d{2}\b/);
            const poster = $(el).find('img').attr('src') || null;

            results.push({
                title,
                url,
                year: yearMatch ? parseInt(yearMatch[0], 10) : null,
                poster,
                normalizedTitle: cleanTitle(title)
            });
        });

        // Cache the results in memory - only if we have results
        if (results.length > 0) {
            searchCache.set(cacheKey, { data: results, ts: Date.now() });
        }

        return results;
    } catch (error) {
        console.error(`[MKVCinemas] Search failed for "${query}": ${error.message}`);
        return [];
    }
}

export async function loadMKVCinemasContent(postUrl, signal = null) {
    if (!postUrl) return { title: '', downloadPages: [], languages: [] };

    // Check in-memory cache first (only use if we have actual download pages)
    const cached = contentCache.get(postUrl);
    if (cached && Date.now() - cached.ts < CONTENT_CACHE_TTL && cached.data?.downloadPages?.length > 0) {
        console.log(`[MKVCinemas] Content cache hit (memory) for ${postUrl}`);
        return cached.data;
    }

    try {
        // Primary: solve the AES cookie challenge inline
        let response = await fetchWithCookieSolver(postUrl);

        if (!response?.document) {
            return { title: '', downloadPages: [], languages: [] };
        }

        const $ = response.document;
        let title = $('h1.entry-title').text().trim() || $('title').text().trim() || '';
        // Clean up site branding from title (e.g., "Mkvcinemas.com | Mkvcinema | ... - Mkvcinemas" -> just the movie title)
        title = title
            .replace(/^Mkvcinemas?\.com\s*\|\s*Mkvcinemas?\s*\|\s*Hindi Dubbed Dual Audio Movies and Web Series/i, '')
            .replace(/\s*-\s*Mkvcinemas?$/i, '')
            .replace(/\s*\|\s*Mkvcinemas?$/i, '')
            .trim();

        const languages = [];
        $('.series-info .language, li.language, li:contains("Language")').each((_, el) => {
            const text = $(el).text().replace(/Language:/i, '').trim();
            if (text) {
                // Split on common separators: comma, ampersand, slash, plus
                text.split(/[,&/+]+/).forEach(lang => {
                    const cleaned = lang.trim();
                    if (cleaned) languages.push(cleaned);
                });
            }
        });

        const downloadPagesSet = new Set();
        $('.entry-content a[href]').each((_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();

            // New format: fly2url links with base64-encoded URLs
            if (href && href.includes('fly2url.com')) {
                try {
                    const url = new URL(href);
                    const encodedUrl = url.searchParams.get('url');
                    if (encodedUrl) {
                        const decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf-8');
                        console.log(`[MKVCinemas] Decoded fly2url: ${decodedUrl}`);
                        downloadPagesSet.add(decodedUrl);
                    }
                } catch (err) {
                    console.log(`[MKVCinemas] Failed to decode fly2url: ${err.message}`);
                }
            }
            // Old format: direct links to download pages
            else if (href && /filesdl|view|downloads?|hubdrive|gdflix|vcloud/i.test(href)) {
                const absolute = normalizeUrl(href, postUrl);
                if (absolute) downloadPagesSet.add(absolute);
            }
        });

        const result = {
            title,
            languages,
            downloadPages: Array.from(downloadPagesSet)
        };

        // Cache the result in memory - only if we have download pages
        if (result.downloadPages.length > 0) {
            contentCache.set(postUrl, { data: result, ts: Date.now() });
        }

        return result;
    } catch (error) {
        console.error(`[MKVCinemas] Failed to load post ${postUrl}: ${error.message}`);
        return { title: '', downloadPages: [], languages: [] };
    }
}
