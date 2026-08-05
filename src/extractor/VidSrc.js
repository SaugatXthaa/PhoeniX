// src/extractor/VidSrc.js
// Ported from research/webstreamr-mbg/src/extractor/VidSrc.ts

import * as cheerio from 'cheerio';
import { BlockedError, NotFoundError, TooManyRequestsError } from '../error/index.js';
import { Format } from '../types.js';
import { guessHeightFromPlaylist } from '../utils/index.js';
import { Extractor } from './Extractor.js';

export class VidSrc extends Extractor {
  constructor(fetcher, logger, domains) {
    super(fetcher, logger);
    this.id = 'vidsrc';
    this.label = 'VidSrc';
    this.ttl = 10800000; // 3h
    this.domains = domains;
  }

  supports(_ctx, url) {
    return null !== url.host.match(/vidsrc|vsrc|vsembed/);
  }

  async extractInternal(ctx, url, meta) {
    const randomIp = `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
    const newCtx = { ...ctx, ip: randomIp };

    return this.extractUsingRandomDomain(newCtx, url, meta, [...this.domains]);
  }

  async extractUsingRandomDomain(ctx, url, meta, domains) {
    const domainIndex = Math.floor(Math.random() * domains.length);
    const [domain] = domains.splice(domainIndex, 1);

    const newUrl = new URL(url);
    newUrl.hostname = domain;

    let html;
    try {
      html = await this.fetcher.text(ctx, newUrl, { queueLimit: 1 });
    } catch (error) {
      if (domains.length && (error instanceof TooManyRequestsError || error instanceof BlockedError)) {
        return this.extractUsingRandomDomain(ctx, url, meta, domains);
      }

      throw error;
    }

    const $ = cheerio.load(html.replace(/<!--/g, '').replace(/-->/g, ''));

    const iframeUrl = new URL(($('#player_iframe').attr('src')).replace(/^\/\//, 'https://'));
    const title = $('title').text().trim();

    return Promise.all(
      $('.server')
        .map((_i, el) => ({ serverName: $(el).text(), dataHash: $(el).data('hash') }))
        .toArray()
        .filter(({ serverName }) => serverName === 'CloudStream Pro')
        .map(async ({ serverName, dataHash }) => {
          const rcpUrl = new URL(`/rcp/${dataHash}`, iframeUrl.origin);
          const iframeHtml = await this.fetcher.text(ctx, rcpUrl, { headers: { Referer: newUrl.origin } });
          const srcMatch = iframeHtml.match(`src:\\s?'(.*)'`);
          if (!srcMatch) throw new NotFoundError();

          const srcPath = srcMatch[1];
          const playerHtml = await this.fetcher.text(ctx, new URL(srcPath, iframeUrl.origin), { headers: { Referer: rcpUrl.href } });
          const fileMatch = playerHtml.match(`(https:\\/\\/.*?{v\\d}.*?) or`);
          if (!fileMatch) throw new NotFoundError();

          const fileUrl = fileMatch[1];
          const m3u8Url = new URL(fileUrl.replace(/{v\d}/, iframeUrl.host));

          return {
            url: m3u8Url,
            format: Format.hls,
            label: serverName,
            meta: {
              ...meta,
              height: await guessHeightFromPlaylist(ctx, this.fetcher, m3u8Url, { headers: { Referer: iframeUrl.href } }),
              title,
            },
          };
        }),
    );
  }
}
