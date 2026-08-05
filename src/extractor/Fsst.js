// src/extractor/Fsst.js
// Ported from research/webstreamr-mbg/src/extractor/Fsst.ts

import * as cheerio from 'cheerio';
import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class Fsst extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'fsst';
    this.label = 'Fsst';
    this.ttl = 10800000; // 3h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/fsst/);
  }

  async extractInternal(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    const html = await this.fetcher.text(ctx, url, { headers, noProxyHeaders: true });

    const $ = cheerio.load(html);
    const title = $('title').text().trim();

    const filesMatch = html.match(/file:"(.*)"/);

    const lastFile = (filesMatch[1]).split(',').pop();

    const heightAndUrlMatch = lastFile.match(/\[?([\d]*)p?]?(.*)/);
    const fileHref = heightAndUrlMatch[2];

    return [{
      url: await this.fetcher.getFinalRedirectUrl(ctx, new URL(fileHref), { headers, noProxyHeaders: true }, 1),
      format: Format.mp4,
      meta: {
        ...meta,
        height: parseInt(heightAndUrlMatch[1]),
        title,
      },
    }];
  }
}
