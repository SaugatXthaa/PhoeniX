// src/nuvio/persianstremio.cjs
// PersianStremio — Stremio-style addon backend with Persian-dual-audio movies
// and series (up to 4K, direct MKV/MP4 file links).
//
// Task 84: CLEAN REWRITE replacing the obfuscated module. The old module's
// internal FETCH_TIMEOUT was 12s, but the upstream's fresh-tt lookups measure
// 17-21s (their TMDB/external_ids cold path — Task 65 measured 17-20s, Task 84
// re-measured 18.6-21.1s with real streams returned). The 12s cap therefore
// expired BEFORE the upstream ever answered → guaranteed production zero on
// every request that mattered. This rewrite keeps the exact protocol and
// output shape but budgets 25s per fetch (inside the wrapper's 26s
// retry-on-empty budget and 33s race).
//
// CHAIN
//   TMDB id → GET api.themoviedb.org/3/{movie|tv}/<id>?append_to_response=external_ids
//           → imdbId (fallback: the tmdb id itself — the addon resolves both)
//   → GET https://persianstremio.vercel.app/stream/movie/<imdbId>.json
//     or      https://persianstremio.vercel.app/stream/series/<imdbId>:S:E.json
//   → Stremio JSON { streams: [{ url | externalUrl, title, name, ... }] }
//   → map to nuvio stream objects (quality inferred from title+name+url)
//   → empty answer → ONE fallback retry keyed by the raw TMDB id
//
// Upstream flaps: intermittent 503s and cold-boot windows (Task 52/65/84).
// The 503s are fast (130ms) and best handled by the source wrapper's
// withRetryOnEmpty ladder, which retries on empty results.

'use strict';

const PROVIDER_NAME = 'PersianStremio';
const PERSIAN_BASE = 'https://persianstremio.vercel.app';
// Central site-secret registry (env-overridable; same key the other ESM
// sources use — community TMDB key).
let TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
try {
  const { TMDB_PRIMARY } = require('../utils/site-secrets.cjs');
  if (TMDB_PRIMARY) TMDB_API_KEY = TMDB_PRIMARY;
} catch { /* standalone/dev path — keep the in-repo default */ }

// Task 84: 12s → 25s. The upstream answers 17-21s on fresh lookups; anything
// below ~22s is a guaranteed zero. Stays under the wrapper's 26s
// withRetryOnEmpty budget so the retry ladder (not a raw timeout) decides.
const FETCH_TIMEOUT = 25000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function log(msg) { console.log(`[${PROVIDER_NAME}] ${msg}`); }
function err(msg) { console.error(`[${PROVIDER_NAME}] ${msg}`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, timeout = FETCH_TIMEOUT, retries = 0) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      err(`fetch failed: ${url} -> ${e?.message || e}`);
      if (attempt < retries) await sleep(1500);
    }
  }
  return null;
}

async function getTMDBDetails(tmdbId, mediaType) {
  const isTV = mediaType === 'tv' || mediaType === 'series';
  const type = isTV ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
  const data = await fetchJson(url, 8000);
  if (!data) return { title: 'PersianStremio Title', year: '', imdbId: null };
  return {
    title: (isTV ? data.name : data.title) || 'PersianStremio Title',
    year: String((isTV ? (data.first_air_date || '') : (data.release_date || '')) || '').split('-')[0],
    imdbId: data.imdb_id || (data.external_ids && data.external_ids.imdb_id) || null,
  };
}

// Quality label inferred from the Stremio stream's title+name+url text.
function pickQuality(text) {
  const s = text.toLowerCase();
  if (s.includes('2160') || s.includes('4k')) return '2160p';
  if (s.includes('1080')) return '1080p';
  if (s.includes('720')) return '720p';
  if (s.includes('480')) return '480p';
  return '1080p';
}

function qualityRank(name) {
  const s = String(name || '').toLowerCase();
  if (s.includes('2160p')) return 2160;
  if (s.includes('1080p')) return 1080;
  if (s.includes('720p')) return 720;
  if (s.includes('480p')) return 480;
  return 0;
}

// Dropdown metadata string — same structure the original module rendered
// (title/year/season → quality → source → HDR/codec/container → audio).
function buildDropdownMetadata(meta, quality, isTV, season, episode, stream) {
  const title = meta.title || 'PersianStremio Title';
  const year = meta.year || '';
  const blob = `${stream.title || ''} ${stream.name || ''} ${stream.url || ''}`.toLowerCase();

  let line = '📜 ' + title;
  if (year) line += ' 🔹 ' + year;
  if (isTV && season != null && episode != null) line += ` 🔹 S${season}E${episode}`;

  const qIcon = quality.includes('2160') || quality.includes('4k') ? '✨ ' : '💎 ';
  let source = 'WEB-DL';
  if (blob.includes('web-rip') || blob.includes('webrip')) source = 'WEB-Rip';
  else if (blob.includes('bluray') || blob.includes('blu-ray')) source = 'Blu-Ray';

  let hdr = 'SDR';
  if (blob.includes('hdr10+')) hdr = 'HDR10+';
  else if (blob.includes('hdr10')) hdr = 'HDR10';
  else if (blob.includes('hdr')) hdr = 'HDR';

  let bit = '';
  if (blob.includes('10bit') || blob.includes('10-bit')) bit = ' | 🌈 10Bit';

  let codec = 'x264';
  if (blob.includes('dv') || blob.includes('dovi') || blob.includes('dolby vision')) codec = 'DV';
  else if (blob.includes('hevc')) codec = 'HEVC';
  else if (blob.includes('x265') || blob.includes('h265')) codec = 'x265';

  const container = (stream.url || '').includes('.mp4') ? 'MP4' : 'MKV';

  let audio = 'AAC';
  if (blob.includes('ddp5.1') || blob.includes('ddp 5.1')) audio = 'DDP5.1';
  else if (blob.includes('dd5.1') || blob.includes('dd 5.1') || blob.includes('5.1')) audio = 'DD5.1';
  const extras = [];
  if (blob.includes('truehd')) extras.push('TrueHD');
  if (blob.includes('atmos')) extras.push('Atmos');

  return [
    line,
    `${qIcon}${quality} 🔹🌙 ${source}`,
    `✴️ ${hdr}${bit} 🔹🧿 ${codec} 🔹💠 ${container}`,
    `🌍 Dual-Audio - 🇺🇸 | 🇮🇷 🔹🎧 ${audio}${extras.length ? ' + ' + extras.join(' + ') : ''}`,
  ].join(' 🔹 ');
}

async function getStreams(tmdbId, mediaType, season, episode) {
  tmdbId = String(tmdbId);
  const isTV = mediaType === 'tv' || mediaType === 'series';
  log(`Request: tmdbId=${tmdbId} type=${mediaType} s=${season} e=${episode}`);

  const meta = await getTMDBDetails(tmdbId, isTV ? 'tv' : 'movie');
  const imdbId = meta.imdbId || tmdbId;

  const primaryUrl = isTV
    ? `${PERSIAN_BASE}/stream/series/${imdbId}:${season != null ? season : 1}:${episode != null ? episode : 1}.json`
    : `${PERSIAN_BASE}/stream/movie/${imdbId}.json`;
  log(`Fetching streams from: ${primaryUrl}`);
  let data = await fetchJson(primaryUrl);

  // Fallback: the addon also resolves raw TMDB ids on some deployments
  if ((!data || !data.streams || !data.streams.length) && meta.imdbId && imdbId !== tmdbId) {
    const fallbackUrl = isTV
      ? `${PERSIAN_BASE}/stream/series/${tmdbId}:${season != null ? season : 1}:${episode != null ? episode : 1}.json`
      : `${PERSIAN_BASE}/stream/movie/${tmdbId}.json`;
    log(`Retrying with fallback endpoint: ${fallbackUrl}`);
    data = await fetchJson(fallbackUrl);
  }

  if (!data || !data.streams || !data.streams.length) {
    log('No streams returned from PersianStremio');
    return [];
  }

  const out = [];
  const seen = new Set();
  for (const stream of data.streams) {
    const url = stream.url || stream.externalUrl;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const quality = pickQuality(`${stream.title || ''} ${stream.name || ''} ${url}`);
    const metaStr = buildDropdownMetadata(meta, quality, isTV, season, episode, stream);
    out.push({
      name: `🌸 ${PROVIDER_NAME} | ${quality} | Dual-Audio`,
      title: metaStr,
      size: metaStr,
      description: metaStr,
      url,
      quality: '',
      language: '',
      headers: { 'User-Agent': USER_AGENT, Referer: PERSIAN_BASE + '/' },
    });
  }

  out.sort((a, b) => qualityRank(b.name) - qualityRank(a.name));
  log(`Returning ${out.length} sorted streams`);
  return out;
}

module.exports = { getStreams, PROVIDER_NAME, PERSIAN_BASE };
