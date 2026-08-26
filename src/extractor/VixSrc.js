// src/extractor/VixSrc.js
// Ported from research/webstreamr-mbg/src/extractor/VixSrc.ts

import { NotFoundError } from '../error/index.js';
import { CountryCode, Format } from '../types.js';
import {
  guessHeightFromPlaylist,
  hasMultiEnabled,
  iso639FromCountryCode,
  supportsMediaFlowProxy,
} from '../utils/index.js';
import { Extractor } from './Extractor.js';

export class VixSrc extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'vixsrc';
    this.label = 'VixSrc';
    this.ttl = 21600000; // 6h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/vixsrc/);
  }

  async extractInternal(ctx, url, meta) {
    const headers = {
      'Referer': 'https://vixsrc.to/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };

    // MediaFlowProxy is always disabled in our port — local extraction only.
    if (supportsMediaFlowProxy(ctx)) {
      const countryCodes = meta.countryCodes ?? [CountryCode.multi];
      if (!hasMultiEnabled(ctx.config) && !countryCodes.some(countryCode => countryCode in ctx.config)) {
        return [];
      }
      // unreachable in our setup, but keep parity with original code
      const streamUrl = new URL('/extractor/video', `https://${(ctx.config.mediaFlowProxyUrl || '').replace(/^https?:\/\//, '')}`);
      streamUrl.searchParams.append('host', 'VixCloud');
      streamUrl.searchParams.append('d', url.href);
      for (const headerKey in headers) {
        streamUrl.searchParams.set('h_' + headerKey.toLowerCase(), headers[headerKey]);
      }
      return [
        {
          url: streamUrl,
          format: Format.hls,
          notWebReady: false,
          meta: {
            ...meta,
            countryCodes,
            height: meta.height ?? 1080,
          },
        },
      ];
    }

    // Non-MediaFlow path: local extraction for Stremio desktop
    const apiUrl = new URL(`/api${url.pathname}`, 'https://vixsrc.to');
    const apiJson = await this.fetcher.json(ctx, apiUrl, { headers });
    const embedUrl = new URL(apiJson.src, 'https://vixsrc.to');
    const html = await this.fetcher.text(ctx, embedUrl, { headers });
    const tokenMatch = html.match(/['"]token['"]:\s?['"]([^'"]*)['"]/);
    const expiresMatch = html.match(/['"]expires['"]:\s?['"]([^'"]*)['"]/);
    const urlMatch = html.match(/url:\s?['"]([^'"]*)['"]/);
    if (!tokenMatch || !expiresMatch || !urlMatch) throw new NotFoundError();
    const token = tokenMatch[1];
    const expires = expiresMatch[1];
    const urlValue = urlMatch[1];
    const baseUrl = new URL(urlValue);
    const playlistUrl = new URL(`${baseUrl.origin}${baseUrl.pathname}.m3u8?${baseUrl.searchParams}`);
    playlistUrl.searchParams.append('token', token);
    playlistUrl.searchParams.append('expires', expires);
    playlistUrl.searchParams.append('h', '1');
    const countryCodes = meta.countryCodes ?? [CountryCode.multi, ...(await this.determineCountryCodesFromPlaylist(ctx, playlistUrl, { headers }))];
    if (!hasMultiEnabled(ctx.config) && !countryCodes.some(countryCode => countryCode in ctx.config)) {
      return [];
    }
    const tokenTtl = Math.max(900000, Number(expires) * 1000 - Date.now() - 120000);

    return [
      {
        url: playlistUrl,
        format: Format.hls,
        ttl: Math.min(tokenTtl, this.ttl),
        meta: {
          ...meta,
          countryCodes,
          height: meta.height ?? await guessHeightFromPlaylist(ctx, this.fetcher, playlistUrl, { headers }),
        },
      },
    ];
  }

  async determineCountryCodesFromPlaylist(ctx, playlistUrl, init) {
    const playlist = await this.fetcher.text(ctx, playlistUrl, init);
    const countryCodes = [];
    (Object.keys(CountryCode)).forEach((countryCode) => {
      const iso639 = iso639FromCountryCode(countryCode);
      if (!countryCodes.includes(countryCode) && iso639 && (new RegExp(`#EXT-X-MEDIA:TYPE=AUDIO.*LANGUAGE="${iso639}"`)).test(playlist)) {
        countryCodes.push(countryCode);
      }
    });
    return countryCodes;
  }
}
