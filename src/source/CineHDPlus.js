// src/source/CineHDPlus.js
// Ported from research/webstreamr-mbg/src/source/CineHDPlus.ts
// 2025-09 re-fit to upstream changes:
//   - Site canonical domain is now cinehdplus.surf (biz serves same catalog)
//   - GET DLE search is dead server-side (returns a default listing regardless
//     of query) — switched to the working POST form search
//   - All titles (series included) now live under /peliculas/{id}-{slug}.html
//   - Per-episode players are vimeus.com embeds (view_key + tmdb id embedded in
//     the page JS) whose embeds[] resolve to vimeos.net packed-JW pages
//     (FileMoon-family, resolved by the FileMoon extractor)
//   - Legacy data-num/.mirrors[data-link] markup kept as a fallback path

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getImdbId, getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

// Accents/case-insensitive title comparison (TMDB "La casa del dragón" vs page "La Casa del Dragón")
const normalizeTitle = (s) => (s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export class CineHDPlus extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinehdplus';
    this.label = 'CineHDPlus';
    this.contentTypes = ['series'];
    this.countryCodes = [CountryCode.es, CountryCode.mx];
    this.baseUrl = 'https://cinehdplus.surf';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);

    let name, year;
    try {
      [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId, 'es');
    } catch {
      return [];
    }

    const seriesPageUrl = await this.fetchSeriesPageUrl(ctx, name);
    if (!seriesPageUrl) {
      return [];
    }

    const html = await this.fetcher.text(ctx, seriesPageUrl);

    const $ = cheerio.load(html);

    const countryCodes = [(($('.details__langs').html()) || '').includes('Latino') ? CountryCode.mx : CountryCode.es];

    const title = `${(($('meta[property="og:title"]').attr('content')) || name).trim()} ${TmdbId.formatSeasonAndEpisode(tmdbId)}`;

    const vidkingMeta = tmdbId.season ? null : { name, year, tmdbId: tmdbId.id };

    // ─── Primary: vimeus.com per-episode embeds (2025+ player) ───
    // Task 86: vimeus.com spent 2026-09-24 in a CF 522 (origin dead site-wide,
    // verified from a clean egress). Cap its fetch so the two fallbacks below
    // still fit the request budget when it hangs.
    const vimeusResults = await this.fetchVimeusEmbeds(ctx, html, seriesPageUrl, tmdbId, title, countryCodes, vidkingMeta);
    if (vimeusResults.length > 0) return vimeusResults;

    // ─── Fallback 1: verhdlink.cam serial player ───
    // The site's OWN player script defaults to this when vimeus fails:
    //   useVerhdlink() → fetch('https://verhdlink.cam/serial/' + imdb)
    //     → non-"not found" → iframe.src = that URL.
    // The serial page carries the same ._player-mirrors latino/castellano
    // data-link blocks as the VerHdLink /movie/ pages — parse them the same way.
    const serialResults = await this.fetchVerhdlinkSerial(ctx, tmdbId, title);
    if (serialResults.length > 0) return serialResults;

    // ─── Fallback 2: the page's static dr0pstream switcher ───
    // Last rung on the site (useDropstream()): a fixed iframe embed baked into
    // the page JS. The addon's Dropload/EmbedResolver chain resolves these
    // server-side (same class as MeineCloud's dr0pstream cards).
    const drop = html.match(/iframe\.src\s*=\s*'(https:\/\/dr0pstream\.com\/e\/[a-z0-9]+)'/);
    if (drop) {
      console.log(`[cinehdplus] vimeus down — shipping static dr0pstream embed ${drop[1]}`);
      try { return [{ url: new URL(drop[1]), meta: { countryCodes, referer: 'https://cinehdplus.surf/', title } }]; } catch { /* fall through */ }
    }

    // ─── Fallback: legacy data-num/.mirrors markup (kept for rollback safety) ───
    return Promise.all(
      $(`[data-num="${tmdbId.season}x${tmdbId.episode}"]`)
        .siblings('.mirrors')
        .children('[data-link]')
        .map((_i, el) => new URL(($(el).attr('data-link')).replace(/^(https:)?\/\//, 'https://')))
        .toArray()
        .filter(url => !url.host.match(/cinehdplus/))
        .map(url => ({ url, meta: { countryCodes, referer: seriesPageUrl.href, title, ...(vidkingMeta && { vidking: vidkingMeta }) } })),
    );
  }

  // Fetch the vimeus.com episode embed page and return vimeos.net embed URLs.
  // Page JS template (verified 2025-09):
  //   function vimeusUrl(se, ep) {
  //     var url = 'https://vimeus.com/e/serie?tmdb=' + tmdb
  //       + '&view_key=5yXx8bsITsFlRG-...' + '&title=' + encodeURIComponent(title) + '&theme=minimal';
  //     if (se) { url += '&se=' + se; } if (ep) { url += '&ep=' + ep; }
  // The vimeus page embeds a JSON blob: {"embeds":[{"url":"https://vimeos.net/embed-x.html","lang":"Latino",...}]}
  async fetchVimeusEmbeds(ctx, html, seriesPageUrl, tmdbId, title, countryCodes, vidkingMeta) {
    if (!tmdbId.season || !html.includes('vimeus.com')) return [];

    const viewKey = html.match(/view_key=([A-Za-z0-9_-]+)/)?.[1];
    // 2026-09 upstream template change: tmdbRaw is now '<id>-<slug>'
    // (e.g. var tmdbRaw = '1396-breaking-bad';) — capture the LEADING digits
    // instead of requiring a pure-number literal. Pure-digit form still matches.
    const showTmdb = html.match(/var\s+tmdb\s*=\s*['"](\d+)['"]/)?.[1]
      || html.match(/var\s+tmdbRaw\s*=\s*['"](\d+)[^'"]*['"]/)?.[1];
    if (!viewKey || !showTmdb) return [];

    const showTitle = html.match(/var\s+title\s*=\s*['"]([^'"]*)['"]/)?.[1] || title;
    const vimeusUrl = new URL('https://vimeus.com/e/serie');
    vimeusUrl.searchParams.set('tmdb', showTmdb);
    vimeusUrl.searchParams.set('view_key', viewKey);
    vimeusUrl.searchParams.set('title', showTitle);
    vimeusUrl.searchParams.set('theme', 'minimal');
    vimeusUrl.searchParams.set('se', String(tmdbId.season));
    vimeusUrl.searchParams.set('ep', String(tmdbId.episode || 1));

    let embedHtml;
    try {
      embedHtml = await this.fetcher.text(ctx, vimeusUrl, { headers: { Referer: seriesPageUrl.href }, timeout: 6000 });
    } catch {
      return [];
    }

    // Parse the embeds JSON array objects: {url, lang, quality, ...}
    const results = [];
    const seen = new Set();
    for (const m of embedHtml.matchAll(/\{[^{}]*"url"\s*:\s*"(https?:\/\/vimeos\.net\/embed-[^"]+)"[^{}]*\}/g)) {
      let url;
      try { url = new URL(m[1].replace(/\\u002F/g, '/')); } catch { continue; }
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      const lang = m[0].match(/"lang"\s*:\s*"([^"]*)"/)?.[1] || '';
      const quality = m[0].match(/"quality"\s*:\s*"([^"]*)"/)?.[1] || '';
      const codes = /latino/i.test(lang) ? [CountryCode.mx] : countryCodes;
      results.push({
        url,
        meta: {
          countryCodes: codes,
          referer: vimeusUrl.origin + '/',
          title: `${title}${lang ? ` · ${lang}` : ''}${quality ? ` · ${quality}` : ''}`,
          ...(vidkingMeta && { vidking: vidkingMeta }),
        },
      });
    }
    return results;
  }

  // Task 86: verhdlink.cam serial player — the site's default when vimeus is
  // down (verified in the live page JS 2026-09-24). Same mirror markup as the
  // VerHdLink source's /movie/ pages (._player-mirrors latino/castellano).
  async fetchVerhdlinkSerial(ctx, tmdbId, title) {
    let imdbId = '';
    try { imdbId = (await getImdbId(this.fetcher, ctx, tmdbId)).id || ''; } catch { return []; }
    if (!imdbId) return [];

    const pageUrl = new URL(`/serial/${imdbId}`, 'https://verhdlink.cam');
    let html;
    try {
      html = await this.fetcher.text(ctx, pageUrl);
    } catch (e) {
      console.log(`[cinehdplus] verhdlink serial fetch failed: ${String(e?.message || e).slice(0, 80)}`);
      return [];
    }

    const $ = cheerio.load(html);
    const out = [];
    $('._player-mirrors').each((_i, el) => {
      let codes;
      if ($(el).hasClass('latino')) codes = [CountryCode.mx];
      else if ($(el).hasClass('castellano')) codes = [CountryCode.es];
      else return;
      $('[data-link!=""]', el).each((_j, mEl) => {
        const raw = ($(mEl).attr('data-link') || '').replace(/^(https:)?\/\//, 'https://');
        if (!raw) return;
        try {
          const url = new URL(raw);
          if (/verhdlink/.test(url.host)) return;
          out.push({ url, meta: { countryCodes: codes, referer: 'https://verhdlink.cam/', title: `${title} · VerHdLink` } });
        } catch { /* invalid URL */ }
      });
    });
    console.log(`[cinehdplus] verhdlink serial: ${out.length} mirror(s) for ${imdbId}`);
    return out;
  }

  // Case-insensitive match handles TMDB/CineHDPlus capitalization differences (e.g. "La casa de dragón" vs "La Casa del Dragón")
  async fetchSeriesPageUrl(ctx, name) {
    // Task 86: production silently zeroed (cinehdplus series probes returned []
    // with no logs at all) because this function caught every failure invisibly.
    // Strategy chain with per-step logging: POST form search on .surf → legacy
    // GET search on .surf (was dead 2025-09, cheap to retry) → POST on the
    // mirror domain .biz (same DLE catalog, verified comment 2025-09).
    const attempts = [
      ['post-surf', 'https://cinehdplus.surf', 'POST'],
      ['get-surf', 'https://cinehdplus.surf', 'GET'],
      ['post-biz', 'https://cinehdplus.biz', 'POST'],
    ];
    for (const [tag, base, method] of attempts) {
      let html = '';
      try {
        if (method === 'POST') {
          html = await this.fetcher.textPost(
            ctx,
            new URL('/index.php?do=search&subaction=search', base),
            `story=${encodeURIComponent(name)}&do=search&subaction=search&search_start=0&full_search=0&result_from=1&result_num=50`,
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
          );
        } else {
          html = await this.fetcher.text(
            ctx,
            new URL(`/index.php?do=search&subaction=search&story=${encodeURIComponent(name)}`, base),
          );
        }
      } catch (e) {
        console.log(`[cinehdplus] search ${tag} fetch failed: ${String(e?.message || e).slice(0, 80)}`);
        continue;
      }
      if (!html || html.length < 500) {
        console.log(`[cinehdplus] search ${tag}: empty/tiny response (${html.length}B)`);
        continue;
      }
      const $ = cheerio.load(html);
      const wanted = normalizeTitle(name);
      const candidates = $('.card__title a[href]').toArray()
        .map(el => ({ href: $(el).attr('href'), text: normalizeTitle($(el).text()) }))
        .filter(c => c.href && c.text && c.text === wanted);
      if (candidates.length === 0) {
        console.log(`[cinehdplus] search ${tag}: ${html.length}B, no exact match for "${name}"`);
        continue;
      }
      // Prefer URLs under the current /peliculas/ path; fall back to first match
      const picked = candidates.find(c => /\/peliculas\//.test(c.href))?.href || candidates[0]?.href;
      console.log(`[cinehdplus] search ${tag}: matched "${name}" → ${picked}`);
      return new URL(picked);
    }
    console.log(`[cinehdplus] search: all ${attempts.length} strategies exhausted for "${name}"`);
    return null;
  }
}
