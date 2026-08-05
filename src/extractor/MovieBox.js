// src/extractor/MovieBox.js
// Ported from research/webstreamr-mbg/src/extractor/MovieBox.ts

import { CountryCode, Format } from '../types.js';
import { Extractor } from './Extractor.js';

const API_BASE_URL = 'https://h5-api.aoneroom.com';
const DOWNLOAD_PATH = '/wefeed-h5api-bff/subject/download';

export class MovieBox extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'moviebox';
    this.label = 'MovieBox';
    this.ttl = 10800000; // 3h
  }

  supports(_ctx, url) {
    return null !== url.host.match(/moviebox|aoneroom/);
  }

  async extractInternal(ctx, url, meta) {
    const subjectId = url.searchParams.get('subjectId');
    const se = url.searchParams.get('se') ?? '0';
    const ep = url.searchParams.get('ep') ?? '0';
    const detailPath = url.searchParams.get('detailPath');

    if (!subjectId) {
      return [];
    }

    const downloadUrl = new URL(`${API_BASE_URL}${DOWNLOAD_PATH}`);
    downloadUrl.searchParams.set('subjectId', subjectId);
    downloadUrl.searchParams.set('se', se);
    downloadUrl.searchParams.set('ep', ep);
    if (detailPath) {
      downloadUrl.searchParams.set('detailPath', detailPath);
    }

    const response = await this.fetcher.json(ctx, downloadUrl, {
      headers: this.getApiHeaders(),
    });

    if (response.code !== 0 || !response.data?.downloads?.length) {
      return [];
    }

    const results = [];
    const countryCodeArray = meta.countryCodes ?? [CountryCode.multi];

    for (const download of response.data.downloads) {
      const resolution = download.resolution || 0;
      const streamUrl = new URL(download.url);

      const isHls = streamUrl.href.includes('.m3u8');
      const formatUpper = download.format ? download.format.toUpperCase() : '';
      const isMp4 = streamUrl.href.includes('.mp4') || formatUpper === 'MP4';

      const format = isHls ? Format.hls : isMp4 ? Format.mp4 : Format.unknown;

      const sizeBytes = download.size ? parseInt(download.size, 10) : undefined;

      results.push({
        url: streamUrl,
        format,
        label: `${resolution}p`,
        requestHeaders: { Referer: 'https://videodownloader.site/' },
        meta: {
          ...meta,
          countryCodes: countryCodeArray,
          height: resolution || undefined,
          bytes: sizeBytes || undefined,
        },
      });
    }

    return results;
  }

  getApiHeaders() {
    return {
      'Accept': 'application/json',
      'X-Client-Info': '{"timezone":"UTC"}',
      'Referer': 'https://videodownloader.site/',
    };
  }
}
