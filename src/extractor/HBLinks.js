// src/extractor/HBLinks.js
// Ported from research/webstreamr-mbg/src/extractor/HBLinks.ts

import * as cheerio from 'cheerio';
import { findCountryCodes, findHeight, HUB_HOST_PATTERN } from '../utils/index.js';
import { Extractor } from './Extractor.js';
import { HubExtractor } from './HubExtractor.js';

export class HBLinks extends Extractor {
  constructor(fetcher, logger, hubExtractor) {
    super(fetcher, logger);
    this.id = 'hblinks';
    this.label = 'HUBLinks';
    this.lazyExtract = true;
    this.ttl = 120000; // 2 min
    this.cacheVersion = 2;
    this.hubExtractor = hubExtractor;
  }

  supports(_ctx, url) {
    return /hblinks/.test(url.host.toLowerCase());
  }

  async extractInternal(ctx, url, meta) {
    const headers = { Referer: meta.referer ?? url.href };

    let html;
    try {
      html = await this.fetcher.text(ctx, url, { headers });
    } catch (error) {
      this.logger.warn(`HBLinks page fetch failed for ${url.href}: ${error}`);
      return [];
    }

    const $ = cheerio.load(html);

    const pageTitle = $('title').text().trim();
    const countryCodes = [...new Set([...(meta.countryCodes ?? []), ...findCountryCodes(pageTitle)])];
    const height = meta.height ?? findHeight(pageTitle);
    const updatedMeta = { ...meta, countryCodes, height, title: pageTitle || meta.title };

    const hubLinks = this.extractHubLinks($, url);

    // Deduplicate by canonical URL — hubdrive and hubcloud may resolve to the same file
    const canonicalUrls = await Promise.all(
      hubLinks.map(hubUrl => this.hubExtractor.normalizeAsync(ctx, hubUrl)),
    );
    const seenCanonical = new Set();
    const uniqueLinks = [];
    for (let i = 0; i < hubLinks.length; i++) {
      const canonical = canonicalUrls[i];
      const hubUrl = hubLinks[i];
      if (!canonical || !hubUrl) continue;
      if (!seenCanonical.has(canonical.href)) {
        seenCanonical.add(canonical.href);
        uniqueLinks.push(hubUrl);
      }
    }

    const results = [];
    for (const hubUrl of uniqueLinks) {
      try {
        results.push(...await this.hubExtractor.extract(ctx, hubUrl, updatedMeta));
      } catch (error) {
        this.logger.warn(`HBLinks extraction failed for ${hubUrl.href}: ${error}`);
      }
    }

    return results;
  }

  // Extract all hub links (hubcdn, hubcloud, hubdrive), deduplicated by URL
  extractHubLinks($, pageUrl) {
    const links = [];
    const seen = new Set();

    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href');
      if (href && HUB_HOST_PATTERN.test(href.toLowerCase())) {
        try {
          const parsedUrl = new URL(href, pageUrl);
          const key = parsedUrl.href;
          if (!seen.has(key)) {
            seen.add(key);
            links.push(parsedUrl);
          }
        } catch {
          // skip invalid URL
        }
      }
    });

    return links;
  }
}
