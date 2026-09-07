// src/source/IMDBPlay.js
// imdbplay.tech — movies/TV/anime via vidsrc.me backend (up to 4K)
//
// REVERSE-ENGINEERED CHAIN (fully resolved to direct playable m3u8):
//   1. TMDB → IMDB ID
//   2. proxy.garageband.rocks/vs_src.php?type={type}&id={imdbId} → {src: embed URL}
//   3. cloudorchestranova.com embed page → window.CFG with playerUrl + metaApi
//   4. data.vidsrcme.ru/api.php?type={type}&imdb={imdbId}&stream_urls → encrypted stream URLs + WASM URL
//   5. Download WASM → compile → decrypt stream_urls (ChaCha20 via WebAssembly)
//   6. peregrinepalaver.space/generate.php → JWT token (IP-bound)
//   7. Append ?token={jwt} to m3u8 URL → DIRECT PLAYABLE HLS STREAM
//
// The m3u8 URL + token is returned as a direct stream (routed through /proxy for HLS rewriting)
// Stremio plays it directly via HLS.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const BASE_URL = 'https://www.imdbplay.tech';
const GARAGEBAND_API = 'https://proxy.garageband.rocks/vs_src.php';
const VS_API = 'https://data.vidsrcme.ru/api.php';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let _gotScraping = null;
async function getGot() {
  if (_gotScraping) return _gotScraping;
  try { const mod = await import('got-scraping'); _gotScraping = mod.gotScraping; }
  catch (e) { console.error('[imdbplay] Failed to load got-scraping:', e.message); }
  return _gotScraping;
}

async function gotGet(url, headers = {}, timeoutMs = 12000, responseType) {
  const got = await getGot();
  if (!got) throw new Error('got-scraping unavailable');
  const opts = {
    headers: { 'User-Agent': UA, ...headers },
    timeout: { request: timeoutMs },
    throwHttpErrors: false,
    followRedirect: true,
    http2: true,
  };
  if (responseType === 'buffer') opts.responseType = 'buffer';
  return got(url, opts);
}

async function gotJson(url, headers = {}, timeoutMs = 12000) {
  const res = await gotGet(url, { Accept: 'application/json', ...headers }, timeoutMs);
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

async function isAnimeContent(fetcher, ctx, tmdbId) {
  try {
    const type = tmdbId.season ? 'tv' : 'movie';
    const url = new URL(`https://api.themoviedb.org/3/${type}/${tmdbId.id}`);
    url.searchParams.set('api_key', TMDB_API_KEY);
    const data = await fetcher.json(ctx, url);
    if (!data) return false;
    if ((data.genres || []).some(g => g.id === 16)) return true;
    if (data.original_language === 'ja') return true;
    return false;
  } catch { return false; }
}

function parseHeight(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('2160') || t.includes('4k')) return 2160;
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

// Decrypt stream_urls using the vidsrc.me WASM module
async function decryptStreamUrls(encryptedB64, wasmUrl) {
  try {
    // Download WASM
    const wasmRes = await gotGet(wasmUrl, { Accept: '*/*' }, 10000, 'buffer');
    if (!wasmRes.body || wasmRes.statusCode !== 200) return [];

    // Compile + instantiate
    const wasmModule = await WebAssembly.compile(wasmRes.body);
    const wasmInstance = await WebAssembly.instantiate(wasmModule, {});
    const { memory, alloc, decrypt } = wasmInstance.exports;

    // Decrypt: alloc → write encrypted bytes → decrypt → read output at ptr+12
    const enc = Buffer.from(encryptedB64, 'base64');
    const ptr = alloc(enc.length);
    new Uint8Array(memory.buffer, ptr, enc.length).set(enc);
    const outLen = decrypt(ptr, enc.length);
    const output = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr + 12, outLen));

    // Split by newlines to get individual stream URLs
    return output.split('\n').filter(s => s);
  } catch (e) {
    console.log(`[imdbplay] WASM decrypt error: ${e.message}`);
    return [];
  }
}

// Fetch JWT token from the stream host's generate.php
async function fetchToken(streamHost) {
  try {
    const tokenUrl = `https://${streamHost}/generate.php`;
    const res = await gotGet(tokenUrl, { Referer: 'https://cloudorchestranova.com/' }, 8000);
    if (res.statusCode === 200 && res.body && !res.body.includes('<')) {
      return res.body.trim();
    }
  } catch (e) {
    console.log(`[imdbplay] Token fetch error: ${e.message}`);
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
    this.ttl = 5 * 60 * 1000; // 5min — tokens are short-lived
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
    console.log(`[imdbplay] IMDB: ${imdbId}${isAnime ? ' [ANIME]' : ''}`);

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    const season = tmdbId.season || null;
    const episode = tmdbId.episode || null;

    // Step 1: Fetch vs_src.php to get embed URL
    let vsApiUrl = `${GARAGEBAND_API}?type=${mediaType}&id=${imdbId}`;
    if (mediaType === 'tv' && season && episode) {
      vsApiUrl += `&season=${season}&episode=${episode}`;
    }
    const vsData = await gotJson(vsApiUrl, { Referer: 'https://proxy.garageband.rocks/' });
    if (!vsData?.src) {
      console.log('[imdbplay] No embed URL from vs_src.php');
      return [];
    }
    const embedUrl = vsData.src;
    const embedOrigin = new URL(embedUrl).origin;
    console.log(`[imdbplay] Embed: ${embedUrl.slice(0, 60)}...`);

    // Step 2: Fetch embed page to get metaApi
    const embedRes = await gotGet(embedUrl, { Referer: 'https://proxy.garageband.rocks/' });
    if (embedRes.statusCode !== 200) {
      console.log('[imdbplay] Embed page failed');
      return [];
    }

    // Step 3: Fetch API data with stream_urls
    let apiUrl = `${VS_API}?type=${mediaType}&imdb=${imdbId}&stream_urls`;
    if (mediaType === 'tv' && season && episode) {
      apiUrl += `&season=${season}&episode=${episode}`;
    }
    const apiData = await gotJson(apiUrl, { Referer: embedOrigin + '/' });
    if (!apiData?.data) {
      console.log('[imdbplay] API failed');
      return [];
    }

    const fileName = apiData.data.file_name || '';
    const height = parseHeight(fileName);
    const codec = parseCodec(fileName);
    const sourceType = parseSourceType(fileName);
    const language = parseLanguage(fileName, isAnime);
    console.log(`[imdbplay] File: ${fileName.slice(0, 50)}... | ${height}p ${codec}`);

    // Step 4: Decrypt stream URLs using WASM
    if (!apiData.data.stream_urls || typeof apiData.data.stream_urls !== 'string') {
      console.log('[imdbplay] No encrypted stream_urls');
      return [];
    }
    if (!apiData.vs?.wasm_url) {
      console.log('[imdbplay] No WASM URL');
      return [];
    }

    const streamUrls = await decryptStreamUrls(apiData.data.stream_urls, apiData.vs.wasm_url);
    if (streamUrls.length === 0) {
      console.log('[imdbplay] Decryption returned no URLs');
      return [];
    }
    console.log(`[imdbplay] Decrypted: ${streamUrls.length} stream URL(s)`);

    // Step 5: Fetch token from the stream host's generate.php
    const results = [];
    for (const streamUrl of streamUrls) {
      try {
        const streamHost = new URL(streamUrl).hostname;
        const token = await fetchToken(streamHost);
        if (!token) {
          console.log(`[imdbplay] No token for ${streamHost}`);
          continue;
        }

        // Append token to stream URL
        const urlWithToken = streamUrl + (streamUrl.includes('?') ? '&' : '?') + 'token=' + token;
        const streamUrlObj = new URL(urlWithToken);

        // Route through /proxy for HLS rewriting (m3u8 needs Referer)
        const proxyUrl = new URL('/proxy', ctx.hostUrl);
        proxyUrl.searchParams.set('url', streamUrlObj.href);
        proxyUrl.searchParams.set('referer', embedOrigin + '/');

        const countryCodes = isAnime
          ? [CountryCode.multi, CountryCode.ja, CountryCode.en]
          : [CountryCode.multi, CountryCode.hi, CountryCode.en];
        const audioTag = isAnime ? ' [SUB+DUB]' : '';

        results.push({
          url: proxyUrl,
          format: Format.hls,
          meta: {
            countryCodes,
            title: `${title} — [IMDBPlay ${height}p ${sourceType} ${codec} ${language}]${audioTag}`,
            sourceId: this.id,
            sourceLabel: this.label,
            height,
            sourceType,
            codec,
            serverName: streamHost,
            audioLabel: language,
            isMultiAudio: /multi|dual/i.test(language),
            ...(isAnime && { isMultiAudio: true }),
          },
        });

        console.log(`[imdbplay] ✓ ${streamHost} (token: ${token.slice(0, 20)}...)`);
        break; // Use first working stream only (others are mirrors)
      } catch (e) {
        console.log(`[imdbplay] Stream failed: ${e.message}`);
      }
    }

    console.log(`[imdbplay] ${results.length} direct playable stream(s)${isAnime ? ' [anime]' : ''}`);
    return results;
  }
}
