// src/source/HiAnime.js
// hianime.at — anime with sub+dub HLS streams
//
// Flow (verified live, pure Node.js — no Playwright):
//   1. Search: GET /search?keyword={query} → anime slug+ID
//   2. Episodes: GET /api/theme/episode/list/{animeId} → episode IDs
//   3. Servers: GET /api/theme/episode/servers?episodeId={id} → sub+sub server list
//   4. Stream page: GET {decoded hash URL} → extract window.__P
//   5. Deobfuscate: base64decode → XOR("otaku-embed-v1") → JSON → {src: m3u8}
//   6. Play m3u8 with Referer: https://zokoanime.video/
//
// Both SUB (Japanese audio) and DUB (English audio) supported.

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import * as cheerio from 'cheerio';

const BASE = 'https://hianime.at';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const OBF_KEY = 'otaku-embed-v1';
const REFERER = 'https://zokoanime.video/';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

function deobfuscate(p) {
  const padded = p + '='.repeat((4 - (p.length % 4)) % 4);
  const raw = Buffer.from(padded, 'base64');
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw[i] ^ OBF_KEY.charCodeAt(i % OBF_KEY.length);
  }
  return JSON.parse(out.toString('utf-8'));
}

async function fetchText(url, referer) {
  const res = await gotScraping.get(url, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'User-Agent': UA, 'Accept': 'text/html,*/*', ...(referer && { Referer: referer }) },
    timeout: { request: 12000 }, throwHttpErrors: false, http2: true,
  });
  return res.statusCode === 200 ? res.body : null;
}

async function fetchJson(url, referer) {
  const res = await gotScraping.get(url, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'User-Agent': UA, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(referer && { Referer: referer }) },
    timeout: { request: 12000 }, throwHttpErrors: false, http2: true,
  });
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

export class HiAnime extends Source {
  constructor(fetcher) {
    super();
    this.id = 'hianime';
    this.label = 'HiAnime';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja, CountryCode.en];
    this.baseUrl = BASE;
    this.fetcher = fetcher;
    this.ttl = 10 * 60 * 1000; // 10min
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    const titleBase = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Step 1: Search by title
    const searchUrl = `${BASE}/search?keyword=${encodeURIComponent(name)}`;
    const searchHtml = await fetchText(searchUrl, `${BASE}/`);
    if (!searchHtml) return [];

    const $ = cheerio.load(searchHtml);
    const results = [];
    const seen = new Set();
    $('.film-name a').each((_, el) => {
      const link = $(el).attr('href') || '';
      const title = $(el).text().trim();
      const m = link.match(/\/([^/]+)-(\d+)$/);
      if (m && !seen.has(m[2])) {
        seen.add(m[2]);
        results.push({ title, url: link, id: parseInt(m[2]), slug: m[1] });
      }
    });
    if (!results.length) {
      $('a').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/watch\/([^/]+)-(\d+)$/);
        if (m && !seen.has(m[2])) {
          seen.add(m[2]);
          results.push({ title: $(el).text().trim() || m[1].replace(/-/g, ' '), url: href, id: parseInt(m[2]), slug: m[1] });
        }
      });
    }
    if (!results.length) return [];

    // Pick best match — require fuzzy score >= 60 to avoid false matches
    // (e.g., searching "Supergirl" must not return "One-Punch Man")
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const nameNorm = normalize(name);
    let bestAnime = null;
    let bestScore = 0;
    for (const r of results) {
      const tNorm = normalize(r.title);
      if (!tNorm) continue;
      let score = 0;
      if (tNorm === nameNorm) score = 100;
      else if (tNorm.includes(nameNorm) || nameNorm.includes(tNorm)) {
        score = Math.min(tNorm.length, nameNorm.length) / Math.max(tNorm.length, nameNorm.length) * 90;
      }
      if (score > bestScore) { bestScore = score; bestAnime = r; }
    }
    if (!bestAnime || bestScore < 60) return [];

    // Step 2: Get episodes
    const episodesData = await fetchJson(`${BASE}/api/theme/episode/list/${bestAnime.id}`, `${BASE}/watch/`);
    if (!episodesData?.html) return [];

    const epHtml = episodesData.html;
    const $ep = cheerio.load(epHtml);
    const episodes = [];
    $ep('.ssl-item').each((_, el) => {
      const eid = $ep(el).attr('data-id');
      const num = parseInt($ep(el).attr('data-number') || '0');
      if (eid) episodes.push({ id: parseInt(eid), number: num });
    });
    if (!episodes.length) {
      const matches = [...epHtml.matchAll(/data-number="(\d+)"[^>]*data-id="(\d+)"/g)];
      for (const m of matches) episodes.push({ id: parseInt(m[2]), number: parseInt(m[1]) });
    }
    if (!episodes.length) return [];
    episodes.sort((a, b) => a.number - b.number);

    // Step 3: Find target episode
    const targetEp = tmdbId.season ? tmdbId.episode : 1;
    const ep = episodes.find(e => e.number === targetEp) || episodes[0];
    if (!ep) return [];

    // Step 4: Get servers for episode (both sub and dub)
    const serversData = await fetchJson(`${BASE}/api/theme/episode/servers?episodeId=${ep.id}`, `${BASE}/watch/`);
    if (!serversData?.html) return [];

    const $srv = cheerio.load(serversData.html);
    const servers = [];
    $srv('.server-item').each((_, el) => {
      const type = $srv(el).attr('data-type') || 'sub';
      const serverName = $srv(el).attr('data-server-name') || 'unknown';
      const hash = $srv(el).attr('data-hash') || '';
      let url = '';
      try { url = Buffer.from(hash, 'base64').toString('utf-8'); } catch {}
      if (url) servers.push({ type, name: serverName, url });
    });
    if (!servers.length) return [];

    // Step 5: Fetch streams from both sub and dub servers
    const results2 = [];
    const seenUrls = new Set();

    for (const category of ['sub', 'dub']) {
      const categoryServers = servers.filter(s => s.type === category);
      // Limit to first 2 servers per category to avoid timeout
      for (const server of categoryServers.slice(0, 2)) {
        try {
          const streamHtml = await fetchText(server.url, `${BASE}/`);
          if (!streamHtml) continue;

          const m = streamHtml.match(/window\.__P="([^"]+)"/);
          if (!m) continue;

          const data = deobfuscate(m[1]);
          if (!data?.src) continue;

          // Dedup by URL
          if (seenUrls.has(data.src)) continue;
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
              title: `${titleBase} (HiAnime ${server.name} ${audioLabel})`,
              sourceId: this.id,
              sourceLabel: this.label,
              height: 1080, // HiAnime streams are typically 1080p
            },
          });
        } catch { /* skip failed server */ }
      }
    }

    return results2;
  }
}
