// src/extractor/Pahe.js
// Pahe extractor — marks teknoasian.com download URLs as external.
//
// The teknoasian.com URLs from pahe.ink are encrypted redirectors that require
// browser JavaScript execution to resolve to actual file host URLs (Google Drive,
// MegaGo, 1Fichier, PixelDrain, GDFlix, SolidFiles). They CANNOT be resolved
// server-side — the page returns an HTML form that only works in a browser.
//
// This extractor claims URLs by meta.sourceId === 'pahe' and returns them as
// isExternal: true, so Stremio opens them in the user's browser where the JS
// redirect can execute and reach the actual download page.
//
// The streams still show enriched metadata (quality, size, host name) in the
// Stremio stream list — clicking them opens the download page in the browser.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

export class Pahe extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'pahe';
    this.label = 'Pahe';
    this.ttl = 3600000; // 1h
  }

  supports(_ctx, url, meta) {
    // Only claim URLs from the Pahe source (by sourceId)
    return meta?.sourceId === 'pahe';
  }

  async extractInternal(_ctx, url, meta) {
    // Return as external URL — Stremio opens it in the browser.
    // The teknoasian.com page requires JS execution to redirect to the
    // actual file host, which can only happen in a browser.
    return [{
      url,
      format: Format.unknown,
      isExternal: true,
      label: this.label,
      meta: { ...meta },
    }];
  }
}
