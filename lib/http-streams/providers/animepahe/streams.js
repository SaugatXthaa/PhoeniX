/**
 * AnimePahe Streams Provider (animepahe.ru)
 * JSON API behind Cloudflare — uses FlareSolverr
 * API: /api?m=search, /api?m=list, /api?m=links
 * Anime-only (series)
 */
import Cinemeta from '../../../util/cinemeta.js';
import { makeRequest } from '../../utils/http.js';
import { fetchWithFlaresolverr } from '../../../util/flaresolverr-manager.js';

const PROVIDER = 'AnimePahe';
const BASE_URL = (process.env.ANIMEPAHE_BASE_URL || 'https://animepahe.ru').replace(/\/+$/, '');
const API_TIMEOUT = parseInt(process.env.ANIMEPAHE_TIMEOUT || '30000', 10);
const searchCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function fetchApiJson(url) {
    try {
        const resp = await makeRequest(url, { timeout: 10000, maxRetries: 0, headers: { 'Accept': 'application/json', 'Referer': BASE_URL + '/' } });
        if (resp.statusCode === 200 && resp.body) { try { return JSON.parse(resp.body); } catch {} }
    } catch {}
    if (process.env.FLARESOLVERR_URL) {
        const fr = await fetchWithFlaresolverr(url);
        if (fr?.body) { try { return JSON.parse(fr.body); } catch {} }
    }
    return null;
}

async function searchAnimePahe(query) {
    const cached = searchCache.get(query.toLowerCase().trim());
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
    try {
        const data = await fetchApiJson(`${BASE_URL}/api?m=search&q=${encodeURIComponent(query)}`);
        if (!data?.data) return [];
        const results = data.data.map(a => ({ id: a.id, title: a.title, session: a.session }));
        searchCache.set(query.toLowerCase().trim(), { data: results, ts: Date.now() });
        return results;
    } catch { return []; }
}

export async function getAnimePaheStreams(imdbId, type, season, episode, config, prefetchedMeta) {
    try {
        if (type !== 'series' && type !== 'tv') return [];
        let meta = prefetchedMeta;
        if (!meta) meta = await Cinemeta.getMeta(type, imdbId);
        if (!meta?.name) return [];
        let results = await searchAnimePahe(meta.name);
        if (results.length === 0 && meta.original_title) results = await searchAnimePahe(meta.original_title);
        if (results.length === 0) return [];
        const best = results[0];
        const epData = await fetchApiJson(`${BASE_URL}/api?m=list&id=${best.id}&session=${best.session}&sort=episode_asc`);
        if (!epData?.data) return [];
        const reqEp = episode ? parseInt(episode) : 1;
        const targetEp = epData.data.find(ep => parseInt(ep.episode) === reqEp);
        if (!targetEp) return [];
        const linksData = await fetchApiJson(`${BASE_URL}/api?m=links&id=${targetEp.id}&session=${best.session}`);
        if (!Array.isArray(linksData)) return [];
        return linksData.map(link => ({
            name: `PhoeniX\n${link.quality || 'auto'}`,
            title: `${best.title} - Episode ${reqEp} ${link.audio || ''}\n💾 ${link.size || ''} | ${PROVIDER}`.trim(),
            url: link.link,
            behaviorHints: { notWebReady: true, bingeGroup: `phoenix-animepahe-${link.quality || 'auto'}` }
        }));
    } catch { return []; }
}
