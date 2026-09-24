// src/source/VerHdLink.js
// Ported from research/webstreamr-mbg/src/source/VerHdLink.ts

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { getImdbId, getTmdbId, getTmdbNameAndYear } from '../utils/index.js';
import { Source } from './Source.js';

export class VerHdLink extends Source {
  constructor(fetcher) {
    super();
    this.id = 'verhdlink';
    this.label = 'VerHdLink';
    this.contentTypes = ['movie'];
    this.countryCodes = [CountryCode.es, CountryCode.mx];
    this.baseUrl = 'https://verhdlink.cam';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const imdbId = await getImdbId(this.fetcher, ctx, id);

    // Also resolve TMDB info for the VidKing fallback
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    let name, year;
    try {
      [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);
    } catch { /* best-effort */ }

    const vidkingMeta = {
      ...(name && { name }),
      ...(year && { year }),
      tmdbId: tmdbId.id,
      imdbId: imdbId.id,
    };

    const pageUrl = new URL(`/movie/${imdbId.id}`, this.baseUrl);
    // Task 86: the page fetch is CF-flapped upstream (403 interstitials land on
    // individual page GETs — verified: Inception passed while Dune2 403'd in the
    // same minute from the same egress). A thrown fetch used to bubble all the
    // way out of handleInternal (debug endpoint surfaced a bare "Error"). Now:
    // one retry absorbs the flap class, and failure degrades to [] instead.
    let html = '';
    for (let attempt = 0; attempt < 2 && !html; attempt++) {
      try {
        html = await this.fetcher.text(ctx, pageUrl);
      } catch (e) {
        console.log(`[verhdlink] page fetch ${attempt + 1}/2 failed: ${String(e?.message || e).slice(0, 80)}`);
      }
    }
    if (!html) return [];

    const $ = cheerio.load(html);

    const candidates = $('._player-mirrors')
      .map((_i, el) => {
        let countryCodes;
        if ($(el).hasClass('latino')) {
          countryCodes = [CountryCode.mx];
        } else if ($(el).hasClass('castellano')) {
          countryCodes = [CountryCode.es];
        } else {
          return [];
        }

        return $('[data-link!=""]', el)
          .map((_i, el) => new URL(($(el).attr('data-link')).replace(/^(https:)?\/\//, 'https://')))
          .toArray()
          .filter(url => !url.host.match(/verhdlink/))
          .map(url => ({ url, meta: { countryCodes, referer: this.baseUrl, ...(vidkingMeta && { vidking: vidkingMeta }) } }));
      }).toArray();

    // Liveness gate: the mirror hosts (hfs*.serversicuro.cc — vidmoly family)
    // now serve an HTML interstitial ("Loading...") on their token'd m3u8
    // paths when the token is expired or the edge is gated. Shipping those
    // raw is a guaranteed "[mpv] unrecognized file format" playback error.
    // Validate each m3u8 mirror returns an actual playlist before shipping;
    // non-playlist URLs (direct files) pass through untouched.
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const validated = await Promise.all(candidates.map(async (r) => {
      if (!/\.m3u8|\/hls\d?\//i.test(r.url.pathname)) return r;
      try {
        const res = await fetch(r.url, {
          headers: { 'User-Agent': UA, Referer: `${this.baseUrl}/` },
          redirect: 'follow',
          signal: AbortSignal.timeout(8000),
        });
        const head = (await res.text()).slice(0, 400);
        if (head.includes('#EXTM3U')) return r;
        console.log(`[verhdlink] mirror dropped (HTML gate, ${res.status}): ${r.url.host}${r.url.pathname.slice(0, 40)}`);
        return null;
      } catch (e) {
        console.log(`[verhdlink] mirror dropped (${e.message?.slice(0, 40)}): ${r.url.host}`);
        return null;
      }
    }));

    return validated.filter(Boolean);
  }
}
