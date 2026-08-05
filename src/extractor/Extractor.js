// src/extractor/Extractor.js

import { NotFoundError } from '../error/index.js';
import { Format } from '../types.js';

export class Extractor {
  constructor(fetcher, logger) {
    this.fetcher = fetcher;
    this.logger = logger || console;
    this.ttl = 900000; // 15m
    this.cacheVersion = undefined;
    this.lazyExtract = false;
  }

  supports(_ctx, _url) { return false; }
  normalize(url) { return url; }
  async normalizeAsync(_ctx, url) { return url; }

  async extract(ctx, url, meta) {
    try {
      const results = await this.extractInternal(ctx, url, meta);
      return results.map(r => ({
        ...r,
        label: r.label || this.label,
        ttl: r.ttl ?? this.ttl,
      }));
    } catch (error) {
      if (error instanceof NotFoundError) return [];
      return [{
        url, format: Format.unknown, isExternal: true, error,
        label: this.label, ttl: 0, meta,
      }];
    }
  }

  async extractInternal(_ctx, _url, _meta) { return []; }
}
