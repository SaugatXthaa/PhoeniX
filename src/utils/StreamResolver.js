// src/utils/StreamResolver.js

import bytes from 'bytes';
import { Format } from '../types.js';
import { getClosestResolution } from './resolution.js';
import { flagFromCountryCode, languageFromCountryCode } from './language.js';

// Parse metadata from stream title and URL when the source doesn't provide it.
// This enriches the display without modifying any source files or stream URLs.
// Only fills in MISSING fields — never overwrites existing meta values.
function enrichMeta(urlResult) {
  const meta = { ...urlResult.meta };
  const title = meta.title || '';
  const url = urlResult.url?.href || '';
  const titleLower = title.toLowerCase();
  const urlLower = url.toLowerCase();

  // 1. Parse height from title if not in meta
  if (!meta.height) {
    if (/4k|2160p|uhd/i.test(title)) meta.height = 2160;
    else if (/1080p/i.test(title)) meta.height = 1080;
    else if (/720p/i.test(title)) meta.height = 720;
    else if (/480p/i.test(title)) meta.height = 480;
    else if (/360p/i.test(title)) meta.height = 360;
    else {
      const m = title.match(/(\d{3,4})p/i);
      if (m) meta.height = parseInt(m[1]);
    }
  }

  // 2. Parse codec from title if not in meta
  if (!meta.codec && !meta.codecs) {
    if (/hevc|x265|h\.?265/i.test(title)) meta.codec = 'HEVC';
    else if (/x264|h264|avc/i.test(title)) meta.codec = 'AVC';
  }

  // 3. Parse file size from title if not in meta
  if (!meta.bytes) {
    // Match patterns like "6.7 GB", "900 MB", "1.2GB", "[410 MB]"
    const sizeMatch = title.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
    if (sizeMatch) {
      const val = parseFloat(sizeMatch[1]);
      meta.bytes = sizeMatch[2].toUpperCase() === 'GB'
        ? val * 1024 * 1024 * 1024
        : val * 1024 * 1024;
    }
  }

  // 4. Infer format from URL if not set
  if (!urlResult.format || urlResult.format === Format.unknown) {
    if (urlLower.includes('.m3u8') || urlLower.includes('/m3u8/') ||
        urlLower.includes('/hls/') || urlLower.includes('/playlist/')) {
      urlResult.format = Format.hls;
    } else if (urlLower.includes('.mp4') || urlLower.includes('.mkv')) {
      urlResult.format = Format.mp4;
    }
  }

  // 5. Parse audio languages from title if countryCodes is minimal
  // Only add if we don't already have specific language codes
  // Use word-boundary matching to avoid false positives (e.g., "rus" in "Icarus")
  if (!meta.countryCodes || meta.countryCodes.length <= 1) {
    const codes = new Set(meta.countryCodes || []);
    if (/\bhindi\b/i.test(titleLower)) codes.add('hi');
    if (/\benglish\b/i.test(titleLower)) codes.add('en');
    if (/\bjapanese\b/i.test(titleLower)) codes.add('ja');
    if (/\bkorean\b/i.test(titleLower)) codes.add('ko');
    if (/\bspanish\b/i.test(titleLower)) codes.add('es');
    if (/\bfrench\b/i.test(titleLower)) codes.add('fr');
    if (/\btamil\b/i.test(titleLower)) codes.add('ta');
    if (/\btelugu\b/i.test(titleLower)) codes.add('te');
    if (/\bchinese\b|\bmandarin\b/i.test(titleLower)) codes.add('zh');
    if (/\brussian\b/i.test(titleLower)) codes.add('ru');
    if (codes.size > 0) meta.countryCodes = [...codes];
  }

  // 6. Parse sub-source name from URL hostname
  // Skip if URL is a proxy URL (localhost or addon's own host)
  if (!meta.serverName && !meta.subSource) {
    try {
      const hostname = new URL(url).hostname;
      // Skip localhost/proxy URLs — they don't indicate the actual provider
      if (hostname !== 'localhost' && !hostname.includes('127.0.0.1') &&
          !urlLower.includes('/proxy?')) {
        const shortName = hostname.replace(/^www\./, '').split('.')[0];
        if (shortName && shortName.length > 2 && shortName !== meta.sourceLabel?.toLowerCase()) {
          meta.subSource = shortName.charAt(0).toUpperCase() + shortName.slice(1);
        }
      }
    } catch { /* not a valid URL */ }
  }

  urlResult.meta = meta;
  return urlResult;
}

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
    // 30s matches Stremio's default request timeout — gives sources maximum
    // time on Render's free tier while still returning before Stremio gives up.
    const SOURCE_TIMEOUT_MS = 30_000;

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
          sourceResults.map(({ url, meta, requestHeaders }) =>
            this.extractorRegistry.handle(ctx, url, { sourceLabel: source.label, sourceId: source.id, priority: source.priority, ...(requestHeaders && { requestHeaders }), ...meta }, true)
              .catch(e => {
                const msg = e?.message || e?.constructor?.name || String(e);
                this.logger.warn(`Extractor for ${source.id} ${url.href} error: ${msg}`);
                return [];
              })
          )
        );
        urlResults.push(...sourceUrlResults.flat());
      } catch (error) {
        sourceErrorCount++;
        // Some errors (NotFoundError, etc.) have empty .message — include constructor name for diagnostics
        const msg = error?.message || error?.constructor?.name || String(error);
        this.logger.warn(`Source ${source.id} error: ${msg}`);
      }
    };

    // Run all sources in parallel — total wall time bounded by SOURCE_TIMEOUT_MS
    await Promise.all(sources.map(s => handleSource(s)));

    // Enrich metadata for all results (parse from title/URL — no source changes)
    for (const r of urlResults) {
      if (!r.error) enrichMeta(r);
    }

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
    const meta = urlResult.meta || {};
    const parts = ['PhoeniX'];

    // Quality emoji + resolution label
    const height = meta.height;
    if (height >= 2160) parts.push('❄️ 4K');
    else if (height >= 1080) parts.push('🧊 1080p');
    else if (height >= 720) parts.push('720p');
    else if (height >= 480) parts.push('480p');
    else if (height > 0) parts.push(getClosestResolution(height));

    // Source label + subsource (server name, provider, etc.)
    if (meta.sourceLabel) {
      const subSource = meta.serverName || meta.provider || meta.subSource;
      if (subSource && subSource !== meta.sourceLabel) {
        parts.push(`${meta.sourceLabel} · ${subSource}`);
      } else {
        parts.push(meta.sourceLabel);
      }
    }

    // Download indicator for file-hosting sources
    if (['4khdhub', 'moviesdrive'].includes(meta.sourceId)) {
      parts.push('📥');
    }

    if (urlResult.isExternal) parts.push('⚠️ external');

    return parts.join(' · ');
  }

  buildTitle(urlResult) {
    const meta = urlResult.meta || {};
    const titleLines = [];

    // Line 1: Movie/show title (from source meta)
    if (meta.title) titleLines.push(meta.title);

    // Line 2: Technical specs — Quality · Codec · Format · Bitrate
    const specs = [];
    const height = meta.height;
    if (height >= 2160) specs.push('4K');
    else if (height >= 1080) specs.push('1080p');
    else if (height >= 720) specs.push('720p');
    else if (height >= 480) specs.push('480p');
    else if (height > 0) specs.push(getClosestResolution(height));

    // Codec info (HEVC, AVC, etc.)
    if (meta.codec) specs.push(meta.codec);
    else if (meta.codecs) {
      // Parse codecs string from HLS manifest (e.g., "mp4a.40.2,avc1.64001f")
      const codecStr = meta.codecs;
      if (codecStr.includes('avc1')) specs.push('AVC');
      else if (codecStr.includes('hvc1') || codecStr.includes('hev1')) specs.push('HEVC');
    }

    // Container/stream format
    if (urlResult.format === Format.hls) specs.push('HLS');
    else if (urlResult.format === Format.mp4) specs.push('MP4');

    // Bitrate (if available from HLS manifest)
    if (meta.bandwidth) {
      const Mbps = (meta.bandwidth / 1000000).toFixed(1);
      specs.push(`~${Mbps} Mbps`);
    }

    if (specs.length > 0) titleLines.push(specs.join(' · '));

    // Line 3: File size
    if (meta.bytes) titleLines.push(`💾 ${bytes.format(meta.bytes)}`);

    // Line 4: Audio languages
    if (meta.countryCodes && meta.countryCodes.length > 0) {
      const langs = meta.countryCodes
        .filter(cc => cc !== 'multi')
        .map(cc => languageFromCountryCode(cc))
        .filter(l => l && l !== 'Multi');
      if (langs.length > 0) {
        titleLines.push(`Audio: ${langs.join(', ')}`);
      }
    }

    // Line 5: Source link
    const sl = meta.sourceLabel;
    if (sl && sl !== urlResult.label) {
      titleLines.push(`🔗 ${urlResult.label} from ${sl}`);
    } else {
      titleLines.push(`🔗 ${urlResult.label}`);
    }

    return titleLines.join('\n');
  }
}
