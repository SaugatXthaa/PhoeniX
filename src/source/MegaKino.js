// src/source/MegaKino.js
// Ported from research/webstreamr-mbg/src/source/MegaKino.ts

import * as cheerio from 'cheerio';
import { Cookie } from 'tough-cookie';
import { CountryCode } from '../types.js';
import { getImdbId } from '../utils/index.js';
import { Source } from './Source.js';

export class MegaKino extends Source {
  constructor(fetcher) {
    super();
    this.id = 'megakino';
    this.label = 'MegaKino';
    this.contentTypes = ['movie'];
    this.countryCodes = [CountryCode.de];
    this.baseUrl = 'https://megakino2.biz/';
    this.fetcher = fetcher;

    // Simple in-memory memoization (1h TTL) replacing memoizee
    this._baseUrlCache = null;
    this._baseUrlCacheTs = 0;
  }

  async handleInternal(ctx, _type, id) {
    const imdbId = await getImdbId(this.fetcher, ctx, id);

    const tokenResponse = await this.fetcher.fetch(ctx, new URL('/?yg=token', await this.getBaseUrl(ctx)), { method: 'HEAD' });

    const setCookieHeader = tokenResponse.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
    const cookie = cookieStr ? Cookie.parse(cookieStr) : null;
    if (!cookie) return [];

    const pageUrl = await this.fetchPageUrl(ctx, imdbId, cookie);
    if (!pageUrl) {
      return [];
    }

    const html = await this.fetcher.text(ctx, pageUrl, { headers: { Cookie: cookie.cookieString() } });
    const $ = cheerio.load(html);
    const title = $('meta[property="og:title"]').attr('content')?.trim();

    return $('.pmovie__player .tabs-block__content iframe')
      .map((_i, el) => {
        const src = $(el).attr('data-src') ?? $(el).attr('src');
        if (!src || src.trim() === '' || src.includes('about:blank')) {
          return null;
        }
        try {
          return new URL(src.trim());
        } catch {
          return null;
        }
      })
      .get()
      .filter((url) => url !== null)
      .map(url => ({
        url,
        meta: {
          countryCodes: [CountryCode.de],
          referer: pageUrl.href,
          title,
        },
      }));
  }

  async fetchPageUrl(ctx, imdbId, cookie) {
    const form = new URLSearchParams();
    form.append('do', 'search');
    form.append('subaction', 'search');
    form.append('story', `${imdbId.id}`);

    const postUrl = await this.getBaseUrl(ctx);

    const html = await this.fetcher.textPost(
      ctx,
      postUrl,
      form.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': postUrl.origin,
          'Cookie': cookie.cookieString(),
        },
      },
    );

    const $ = cheerio.load(html);
    return $('#dle-content a[href].poster:first')
      .map(async (_i, el) => new URL($(el).attr('href'), await this.getBaseUrl(ctx)))
      .get(0);
  }

  async getBaseUrl(ctx) {
    if (this._baseUrlCache && Date.now() - this._baseUrlCacheTs < 3600000) {
      return this._baseUrlCache;
    }
    const url = await this.fetcher.getFinalRedirectUrl(ctx, new URL(this.baseUrl));
    this._baseUrlCache = url;
    this._baseUrlCacheTs = Date.now();
    return url;
  }
}
