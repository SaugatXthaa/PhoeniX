import fetch from 'node-fetch';

const DEFAULT_BASE_URL = (process.env.VIXSRC_BASE_URL || 'https://vixsrc.to').replace(/\/+$/, '');
const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
};

function buildPageUrl(tmdbId, type, season, episode) {
    const base = DEFAULT_BASE_URL;
    if (type === 'series' || season != null || episode != null) {
        const s = season || 1;
        const e = episode || 1;
        return `${base}/tv/${tmdbId}/${s}/${e}`;
    }
    return `${base}/movie/${tmdbId}`;
}

function extractTitle(html) {
    const match = html.match(/<title>([^<]+)<\/title>/i);
    if (!match) return '';
    return match[1].replace(/\s*\|\s*vixsrc[^|]*$/i, '').trim();
}

function parseHeightFromPlaylist(playlistText) {
    let maxHeight = 0;
    const regex = /RESOLUTION=\d+x(\d+)/gi;
    let m;
    while ((m = regex.exec(playlistText)) !== null) {
        const h = parseInt(m[1], 10);
        if (!Number.isNaN(h) && h > maxHeight) {
            maxHeight = h;
        }
    }
    return maxHeight || undefined;
}

function parseLanguagesFromPlaylist(playlistText) {
    const langs = new Set();
    const regex = /LANGUAGE="([a-z]{2})"/gi;
    let m;
    while ((m = regex.exec(playlistText)) !== null) {
        langs.add(m[1].toLowerCase());
    }
    return Array.from(langs);
}

export async function getVixSrcStreams(tmdbId, type, season = null, episode = null) {
    const pageUrl = buildPageUrl(tmdbId, type, season, episode);

    try {
        const res = await fetch(pageUrl, { headers: REQUEST_HEADERS });
        if (!res.ok) {
            console.warn(`[VixSrc] Failed to load page ${pageUrl} (${res.status})`);
            return [];
        }

        const html = await res.text();
        const tokenMatch = html.match(/['"]token['"]\s*:\s*['"](.*?)['"]/i);
        const expiresMatch = html.match(/['"]expires['"]\s*:\s*['"](.*?)['"]/i);
        const urlMatch = html.match(/url:\s*['"](.*?)['"]/i);

        if (!tokenMatch || !expiresMatch || !urlMatch) {
            console.warn('[VixSrc] Missing token/expires/url in page response');
            return [];
        }

        const baseUrl = new URL(urlMatch[1]);
        const playlistUrl = new URL(`${baseUrl.origin}${baseUrl.pathname}.m3u8${baseUrl.search}`);
        playlistUrl.searchParams.set('token', tokenMatch[1]);
        playlistUrl.searchParams.set('expires', expiresMatch[1]);
        playlistUrl.searchParams.set('h', '1');

        let playlistText = '';
        try {
            const playlistRes = await fetch(playlistUrl, {
                headers: { ...REQUEST_HEADERS, Referer: pageUrl }
            });
            if (playlistRes.ok) {
                playlistText = await playlistRes.text();
            } else {
                console.warn(`[VixSrc] Failed to fetch playlist (${playlistRes.status})`);
            }
        } catch (err) {
            console.warn('[VixSrc] Error fetching playlist:', err.message);
        }

        const height = playlistText ? parseHeightFromPlaylist(playlistText) : undefined;
        const languages = playlistText ? parseLanguagesFromPlaylist(playlistText) : [];
        const title = extractTitle(html) || `VixSrc ${tmdbId}`;

        return [{
            name: '[HS+] VixSrc',
            title: height ? `${title}\n🔗 VixSrc ${height}p` : `${title}\n🔗 VixSrc`,
            url: playlistUrl.toString(),
            resolution: height ? `${height}p` : undefined,
            languages,
            behaviorHints: {
                bingeGroup: 'vixsrc-streams',
                notWebReady: true,
                proxyHeaders: {
                    request: {
                        Referer: pageUrl
                    }
                }
            }
        }];
    } catch (error) {
        console.error('[VixSrc] Error fetching streams:', error.message);
        return [];
    }
}
