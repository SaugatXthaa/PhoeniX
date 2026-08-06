// src/utils/StreamResolver.js

import bytes from 'bytes';
import { Format } from '../types.js';
import { getClosestResolution } from './resolution.js';
import { flagFromCountryCode } from './language.js';

export class StreamResolver {
  constructor(logger, extractorRegistry) {
    this.logger = logger;
    this.extractorRegistry = extractorRegistry;
  }

  async resolve(ctx, sources, type, id) {
    if (sources.length === 0) {
      return { streams: [{ name: 'PhoeniX', title: '⚠️ No sources found', externalUrl: ctx.hostUrl.href }] };
    }

    const streams = [];
    const urlResults = [];
    let sourceErrorCount = 0;

    // Per-source timeout — ensures one slow source can't make Stremio's entire
    // request hang. Sources that haven't returned within SOURCE_TIMEOUT_MS are
    // abandoned (their partial results, if any, are still collected).
    const SOURCE_TIMEOUT_MS = 20_000;

    const withTimeout = (promise, ms, sourceId) => {
      let timer;
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`source ${sourceId} timed out after ${ms}ms`)), ms);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };

    const handleSource = async (source) => {
      try {
        const sourceResults = await withTimeout(source.handle(ctx, type, id), SOURCE_TIMEOUT_MS, source.id);
        this.logger.info(`Source ${source.id} returned ${sourceResults.length} results`);
        // Extractor phase — also bounded by the same timeout (reset per source)
        const sourceUrlResults = await Promise.all(
          sourceResults.map(({ url, meta }) =>
            this.extractorRegistry.handle(ctx, url, { sourceLabel: source.label, sourceId: source.id, priority: source.priority, ...meta }, true)
              .catch(e => {
                this.logger.warn(`Extractor for ${source.id} ${url.href} error: ${e.message}`);
                return [];
              })
          )
        );
        urlResults.push(...sourceUrlResults.flat());
      } catch (error) {
        sourceErrorCount++;
        this.logger.warn(`Source ${source.id} error: ${error.message}`);
      }
    };

    // Run all sources in parallel — total wall time bounded by SOURCE_TIMEOUT_MS
    await Promise.all(sources.map(s => handleSource(s)));

    // Sort: errors first, then by height desc, then bytes desc, then priority
    urlResults.sort((a, b) => {
      if (a.error || b.error) return a.error ? -1 : 1;
      if (a.isExternal || b.isExternal) return a.isExternal ? 1 : -1;
      const h = (b.meta?.height ?? 0) - (a.meta?.height ?? 0);
      if (h !== 0) return h;
      const bs = (b.meta?.bytes ?? 0) - (a.meta?.bytes ?? 0);
      if (bs !== 0) return bs;
      return (b.meta?.priority ?? 0) - (a.meta?.priority ?? 0);
    });

    // Build streams
    const seen = new Set();
    for (const urlResult of urlResults) {
      if (urlResult.error) continue;

      const urlKey = urlResult.url.href;
      if (seen.has(urlKey)) continue;
      seen.add(urlKey);

      const stream = {
        ...this.buildUrl(urlResult),
        name: this.buildName(urlResult),
        title: this.buildTitle(urlResult),
        behaviorHints: {
          bingeGroup: `phoenix-${urlResult.meta?.sourceId}-${urlResult.meta?.extractorId}`,
          ...(urlResult.format !== Format.mp4 && urlResult.notWebReady !== false && { notWebReady: true }),
          ...(urlResult.requestHeaders && {
            notWebReady: true,
            proxyHeaders: { request: urlResult.requestHeaders },
          }),
          ...(urlResult.meta?.bytes && { videoSize: urlResult.meta.bytes }),
        },
      };
      streams.push(stream);
    }

    this.logger.info(`Returning ${streams.length} streams`);

    return { streams };
  }

  buildUrl(urlResult) {
    if (urlResult.isExternal) return { externalUrl: urlResult.url.href };
    return { url: urlResult.url.href };
  }

  buildName(urlResult) {
    const lines = ['PhoeniX'];
    const flags = urlResult.meta?.countryCodes?.map(cc => flagFromCountryCode(cc)).join(' ');
    if (flags) lines.push(flags);
    if (urlResult.meta?.height) lines.push(getClosestResolution(urlResult.meta.height));
    if (urlResult.isExternal) lines.push('⚠️ external');
    return lines.join('\n');
  }

  buildTitle(urlResult) {
    const titleLines = [];
    if (urlResult.meta?.title) titleLines.push(urlResult.meta.title);
    if (urlResult.meta?.bytes) titleLines.push(`💾 ${bytes.format(urlResult.meta.bytes)}`);
    const sl = urlResult.meta?.sourceLabel;
    if (sl && sl !== urlResult.label) titleLines.push(`🔗 ${urlResult.label} from ${sl}`);
    else titleLines.push(`🔗 ${urlResult.label}`);
    return titleLines.join('\n');
  }
}
