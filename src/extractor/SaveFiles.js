// src/extractor/SaveFiles.js
// Ported from research/webstreamr-mbg/src/extractor/SaveFiles.ts

import * as cheerio from 'cheerio';
import { NotFoundError } from '../error/index.js';
import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class SaveFiles extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'savefiles';
    this.label = 'SaveFiles';
    this.ttl = 21600000; // 6h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/savefiles|streamhls/);
  }

  normalize(url) {
    return new URL(url.href.replace('/e/', '/').replace('/d/', '/'));
  }

  async extractInternal(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    const html = await this.fetcher.text(ctx, url, { headers });

    if (/file was locked|file was deleted/i.test(html)) {
      throw new NotFoundError();
    }

    const fileMatch = html.match(/file:"(.*?)"/);
    const sizeMatch = html.match(/\[\d{3,}x(\d{3,})/);

    const $ = cheerio.load(html);
    const title = $('.download-title').text().trim();

    return [
      {
        url: new URL(fileMatch[1]),
        format: Format.hls,
        meta: {
          ...meta,
          title,
          height: parseInt(sizeMatch[1]),
        },
      },
    ];
  }
}
