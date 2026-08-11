// src/source/AnimeKai.js
// animekai.at — anime with sub+dub HLS streams
//
// Flow (verified live, pure Node.js — no Playwright):
//   1. Search: GET /?s={query} via curl → /watch/{slug}/
//   2. Watch page: GET /watch/{slug}/ via curl → extract POST_ID, MAL_ID, SUB_COUNT, DUB_COUNT
//   3. Stream: GET https://zokoanime.video/stream/mal/{MAL_ID}/{ep}/{sub|dub}
//   4. Deobfuscate: base64decode(window.__P) → XOR("otaku-embed-v1") → JSON → {src: m3u8}
//   5. Play m3u8 with Referer: https://zokoanime.video/
//
// Both SUB (Japanese audio) and DUB (English audio) supported.
// animekai.at uses CF JS Detection — requires system curl for search/info fetch.
// zokoanime.video is accessible via got-scraping.

import { execSync } from 'child_process';
import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import * as cheerio from 'cheerio';

const BASE = 'https://animekai.at';
const ZOKO = 'https://zokoanime.video';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const OBF_KEY = 'otaku-embed-v1';
const REFERER = 'https://zokoanime.video/';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

// Use system curl for CF-protected pages (animekai.at has CF JS Detection)
function curlGet(url, referer) {
  try {
    const refHeader = referer ? ` -H "Referer: ${referer}"` : '';
    return execSync(
      `curl -sS -L --max-time 10 -A "${UA}"${refHeader} "${url}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 12000 }
    );
  } catch { return null; }
}

function deobfuscate(p) {
  const padded = p + '='.repeat((4 - (p.length % 4)) % 4);
  const raw = Buffer.from(padded, 'base64');
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw[i] ^ OBF_KEY.charCodeAt(i % OBF_KEY.length);
  }
  return JSON.parse(out.toString('utf-8'));
}

// Fetch stream URL from zokoanime.video
async function getStream(malId, episode, type) {
  const streamUrl = `${ZOKO}/stream/mal/${malId}/${episode}/${type}`;
  const res = await gotScraping.get(streamUrl, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Referer': `${BASE}/` },
    timeout: { request: 12000 }, throwHttpErrors: false, http2: true,
  });
  if (res.statusCode !== 200) return null;
  const m = res.body.match(/window\.__P="([^"]+)"/);
  if (!m) return null;
  try { return deobfuscate(m[1]); } catch { return null; }
}

export class AnimeKai extends Source {
  constructor(fetcher) {
    super();
    this.id = 'animekai';
    this.label = 'AnimeKai';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = BASE;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const titleBase = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search via curl (animekai.at has CF JS Detection)
    const searchHtml = curlGet(`${BASE}/?s=${encodeURIComponent(name)}`);
    if (!searchHtml) return [];

    const $ = cheerio.load(searchHtml);
    const results = [];
    const seen = new Set();
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/\/watch\/([^/]+)\/?$/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        results.push({ title: $(el).text().trim() || m[1].replace(/-/g, ' '), slug: m[1] });
      }
    });
    if (!results.length) return [];

    // Pick best match
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const nameNorm = normalize(name);
    let best = results[0];
    for (const r of results) {
      if (normalize(r.title) === nameNorm) { best = r; break; }
    }

    // Step 2: Get anime info (POST_ID, MAL_ID) via curl
    const watchUrl = `${BASE}/watch/${best.slug}/`;
    const watchHtml = curlGet(watchUrl, `${BASE}/`);
    if (!watchHtml) return [];

    const malId = watchHtml.match(/MAL_ID\s*=\s*["'](\d+)["']/)?.[1];
    if (!malId) return [];

    // Step 3: Fetch streams for both sub and dub via zokoanime.video
    const epNum = tmdbId.season ? (tmdbId.episode || 1) : 1;
    const results2 = [];
    const seenUrls = new Set();

    for (const category of ['sub', 'dub']) {
      try {
        const data = await getStream(malId, epNum, category);
        if (!data?.src || seenUrls.has(data.src)) continue;
        seenUrls.add(data.src);

        let parsed;
        try { parsed = new URL(data.src); } catch { continue; }

        const audioLabel = category === 'dub' ? 'DUB' : 'SUB';
        const countryCodes = category === 'dub'
          ? [CountryCode.multi, CountryCode.en]
          : [CountryCode.multi, CountryCode.ja];

        results2.push({
          url: parsed,
          format: Format.hls,
          meta: {
            countryCodes,
            title: `${titleBase} (AnimeKai ${audioLabel})`,
            sourceId: this.id,
            sourceLabel: this.label,
            height: 1080,
          },
        });
      } catch { /* skip */ }
    }

    return results2;
  }
}
