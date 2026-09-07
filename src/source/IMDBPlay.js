// src/source/IMDBPlay.js
// imdbplay.tech — movies/TV/anime via vidsrc.me backend (up to 4K)
//
// IMDbPlay is a Vite/TanStack Start SPA that wraps vidsrc.me streams.
// The streaming chain (reverse-engineered from the userscript + JS bundles):
//
//   1. TMDB → IMDB ID (via TMDB API)
//   2. proxy.garageband.rocks/embed/{movie|tv}/{imdbId} → embed page
//   3. /vs_src.php?type={type}&id={imdbId} → {src: cloudorchestranova embed URL}
//   4. cloudorchestranova embed → window.CFG with metaApi URL
//   5. data.vidsrcme.ru/api.php?type={type}&imdb={imdbId} → file_name + quality
//
// The actual stream URLs are encrypted with ChaCha20 via WASM (can't decrypt
// server-side). The garageband embed URL is returned as an external stream.
//
// ENRICHED METADATA (from data.vidsrcme.ru/api.php):
//   - file_name contains quality info: "Inception.2010.1080p.BrRip.x264.YIFY.mp4"
//   - height: 1080 (from file_name)
//   - codec: x264 (from file_name)
//   - sourceType: BluRay (from file_name)
//   - audioLabel: Dual Audio / Hindi / English (inferred)
//
// ANIME SUPPORT:
//   - Detects anime via TMDB genres (Animation=16) or original_language=ja
//   - Anime files typically have Japanese audio with subtitles

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://www.imdbplay.tech';
const GARAGEBAND_EMBED = 'https://proxy.garageband.rocks/embed';
const GARAGEBAND_API = 'https://proxy.garageband.rocks/vs_src.php';
const VS_API = 'https://data.vidsrcme.ru/api.php';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let _gotScraping = null;
async function getGot() {
  if (_gotScraping) return _gotScraping;
  try {
    const mod = await import('got-scraping');
    _gotScraping = mod.gotScraping;
  } catch (e) {
    console.error('[imdbplay] Failed to load got-scraping:', e.message);
  }
  return _gotScraping;
}

async function gotGet(url, headers = {}, timeoutMs = 12000) {
  const got = await getGot();
  if (!got) throw new Error('got-scraping unavailable');
  const res = await got(url, {
    headers: { 'User-Agent': UA, ...headers },
    timeout: { request: timeoutMs },
    throwHttpErrors: false,
    followRedirect: true,
    http2: true,
  });
  return res;
}

async function gotJson(url, headers = {}, timeoutMs = 12000) {
  const res = await gotGet(url, { Accept: 'application/json', ...headers }, timeoutMs);
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

// Detect anime via TMDB genres + original language
async function isAnimeContent(fetcher, ctx, tmdbId) {
  try {
    const type = tmdbId.season ? 'tv' : 'movie';
    const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}`);
    url.searchParams.set('api_key', TMDB_API_KEY);
    const data = await fetcher.json(ctx, url);
    if (!data) return false;
    const genres = data.genres || [];
    if (genres.some(g => g.id === 16)) return true;
    if (data.original_language === 'ja') return true;
    return false;
  } catch { return false; }
}

// Parse quality from filename
function parseHeight(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('2160') || t.includes('4k') || t.includes('uhd')) return 2160;
  if (t.includes('1080')) return 1080;
  if (t.includes('720')) return 720;
  if (t.includes('480')) return 480;
  return 1080;
}

function parseCodec(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('x265') || t.includes('h265') || t.includes('hevc') || t.includes('h.265')) return 'HEVC';
  if (t.includes('x264') || t.includes('h264') || t.includes('h.264') || t.includes('avc')) return 'x264';
  if (t.includes('2160') || t.includes('4k')) return 'HEVC';
  return 'x264';
}

function parseSourceType(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('remux')) return 'BluRay Remux';
  if (t.includes('bluray') || t.includes('brrip') || t.includes('bdrip')) return 'BluRay';
  if (t.includes('web-dl') || t.includes('webdl') || t.includes('web dl')) return 'WebDL';
  if (t.includes('webrip')) return 'WebRip';
  if (t.includes('hdrip')) return 'HDRip';
  return 'WebDL';
}

function parseLanguage(text, isAnime) {
  const t = (text || '').toLowerCase();
  if (isAnime) {
    if (t.includes('dual') || (t.includes('japanese') && (t.includes('hindi') || t.includes('english')))) return 'Dual Audio (Sub+Dub)';
    if (t.includes('japanese')) return 'Japanese (Sub)';
    return 'Japanese';
  }
  if (t.includes('dual') || (t.includes('hindi') && t.includes('english'))) return 'Dual Audio';
  if (t.includes('hindi')) return 'Hindi';
  if (t.includes('english')) return 'English';
  return 'English';
}

// Fetch metadata from vidsrc.me API
async function fetchVsMeta(type, imdbId, season, episode) {
  let url = `${VS_API}?type=${type}&imdb=${imdbId}`;
  if (type === 'tv' && season && episode) {
    url += `&season=${season}&episode=${episode}`;
  }
  try {
    const data = await gotJson(url);
    if (data?.status_code === '200' && data?.data) {
      return data;
    }
  } catch (e) {
    console.log(`[imdbplay] VS API failed: ${e.message}`);
  }
  return null;
}

// Fetch the embed URL from garageband
async function fetchEmbedUrl(type, imdbId, season, episode) {
  let url = `${GARAGEBAND_API}?type=${type}&id=${imdbId}`;
  if (type === 'tv' && season && episode) {
    url += `&season=${season}&episode=${episode}`;
  }
  try {
    const data = await gotJson(url, { Referer: GARAGEBAND_EMBED + '/' });
    if (data?.src) return data.src;
  } catch (e) {
    console.log(`[imdbplay] Garageband API failed: ${e.message}`);
  }
  return null;
}

export class IMDBPlay extends Source {
  constructor(fetcher) {
    super();
    this.id = 'imdbplay';
    this.label = 'IMDBPlay';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = BASE_URL;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const isAnime = await isAnimeContent(this.fetcher, ctx, tmdbId);

    // Resolve IMDB ID from TMDB
    let imdbId = null;
    try {
      const type = tmdbId.season ? 'tv' : 'movie';
      const tmdbUrl = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}`);
      tmdbUrl.searchParams.set('api_key', TMDB_API_KEY);
      tmdbUrl.searchParams.set('append_to_response', 'external_ids');
      const tmdbData = await gotJson(tmdbUrl.href);
      imdbId = tmdbData?.imdb_id || tmdbData?.external_ids?.imdb_id;
    } catch (e) {
      console.log(`[imdbplay] Failed to get IMDB ID: ${e.message}`);
    }

    if (!imdbId || !imdbId.startsWith('tt')) {
      console.log('[imdbplay] No IMDB ID found');
      return [];
    }
    console.log(`[imdbplay] IMDB ID: ${imdbId}${isAnime ? ' [ANIME]' : ''}`);

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    const season = tmdbId.season || null;
    const episode = tmdbId.episode || null;

    // Step 1: Fetch metadata from vidsrc.me API
    const vsMeta = await fetchVsMeta(mediaType, imdbId, season, episode);
    if (!vsMeta) {
      console.log('[imdbplay] No metadata found');
      return [];
    }

    const fileName = vsMeta.data?.file_name || '';
    const height = parseHeight(fileName);
    const codec = parseCodec(fileName);
    const sourceType = parseSourceType(fileName);
    const language = parseLanguage(fileName, isAnime);
    const subs = vsMeta.default_subs || [];

    console.log(`[imdbplay] File: ${fileName.slice(0, 60)}... | ${height}p ${codec} ${sourceType}`);

    // Step 2: Fetch the embed URL from garageband
    const embedUrl = await fetchEmbedUrl(mediaType, imdbId, season, episode);
    if (!embedUrl) {
      console.log('[imdbplay] No embed URL found');
      return [];
    }
    console.log(`[imdbplay] Embed: ${embedUrl.slice(0, 80)}...`);

    // Build stream result
    const countryCodes = isAnime
      ? [CountryCode.multi, CountryCode.ja, CountryCode.en]
      : [CountryCode.multi, CountryCode.hi, CountryCode.en];

    const audioTag = isAnime ? ' [SUB+DUB]' : '';
    const results = [];

    // The embed URL is an iframe player — return as external URL
    // Stremio opens it in browser where the player loads the encrypted stream
    let embedUrlObj;
    try { embedUrlObj = new URL(embedUrl); } catch { return []; }

    results.push({
      url: embedUrlObj,
      format: 'iframe',
      isExternal: true,
      meta: {
        countryCodes,
        title: `${title} — [IMDBPlay ${height}p ${sourceType} ${codec} ${language}]${audioTag}`,
        sourceId: this.id,
        sourceLabel: this.label,
        height,
        sourceType,
        codec,
        serverName: 'vidsrc',
        audioLabel: language,
        isMultiAudio: /multi|dual/i.test(language),
        ...(isAnime && { isMultiAudio: true }),
        // Pass subtitles from the API if available
        ...(Array.isArray(subs) && subs.length > 0 && {
          subtitles: subs.map(s => ({
            id: s.lang || s.label || 'en',
            url: s.url || s.src || '',
            lang: s.label || s.lang || 'English',
          })).filter(s => s.url),
        }),
      },
    });

    // Also add the garageband embed URL as a second stream (different server)
    const garagebandUrl = `${GARAGEBAND_EMBED}/${mediaType}/${imdbId}` +
      (mediaType === 'tv' && season && episode ? `?s=${season}&e=${episode}` : '');
    results.push({
      url: new URL(garagebandUrl),
      format: 'iframe',
      isExternal: true,
      meta: {
        countryCodes,
        title: `${title} — [IMDBPlay Garageband ${height}p ${sourceType} ${codec} ${language}]${audioTag}`,
        sourceId: this.id,
        sourceLabel: this.label,
        height,
        sourceType,
        codec,
        serverName: 'garageband',
        audioLabel: language,
        isMultiAudio: /multi|dual/i.test(language),
        ...(isAnime && { isMultiAudio: true }),
      },
    });

    console.log(`[imdbplay] ${results.length} stream(s)${isAnime ? ' [anime]' : ''}`);
    return results;
  }
}
