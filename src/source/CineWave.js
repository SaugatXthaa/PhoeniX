// src/source/CineWave.js
// NOTE: The HdHub API (hdhub.thevolecitor.qzz.io) is now donation-gated.
// It only returns "Donation needed" streams without a donation key.
// The streams it used to provide are the SAME HubCloud streams that
// 4KHDHub already provides via hubcloud.ist. This source is kept for
// when the API becomes available again.
// watch.cinewave.qzz.io — movies/series/anime via hdhub.thevolecitor.qzz.io API
// API: GET https://hdhub.thevolecitor.qzz.io/{config_base64}/stream/{movie|series}/{tmdb_id}.json
// Returns Stremio-format streams JSON with direct CDN URLs (workers.dev, pixeldrain, etc.)

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId, findCountryCodes } from '../utils/index.js';
import { Source } from './Source.js';

const CINEWAVE_API_BASE = 'https://hdhub.thevolecitor.qzz.io';
const CINEWAVE_CONFIG = Buffer.from(JSON.stringify({
  torbox: 'unset',
  qualities: '2160p,1080p,720p',
  sort: 'desc',
})).toString('base64');

export class CineWave extends Source {
  constructor(fetcher) {
    super();
    this.id = 'cinewave';
    this.label = 'CineWave';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://watch.cinewave.qzz.io';
    this.priority = 1;
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const mediaType = tmdbId.season ? 'series' : 'movie';
    const apiUrl = new URL(`/${CINEWAVE_CONFIG}/stream/${mediaType}/${tmdbId.id}.json`, CINEWAVE_API_BASE);

    let response;
    try {
      response = await this.fetcher.json(ctx, apiUrl, {
        headers: {
          'Referer': 'https://watch.cinewave.qzz.io/',
          'Accept': 'application/json',
        },
        timeout: 15000,
      });
    } catch {
      return [];
    }

    if (!response || !response.streams || !Array.isArray(response.streams)) {
      return [];
    }

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // CineWave returns Stremio-format streams directly — extract URL/externalUrl
    const results = [];
    for (const stream of response.streams) {
      // Skip donation streams
      if (stream.name && /donation|donate/i.test(stream.name)) continue;
      if (stream.title && /donation|donate/i.test(stream.title)) continue;

      const url = stream.url || stream.externalUrl;
      if (!url) continue;

      // Extract height from stream name/title
      const nameTitle = `${stream.name || ''} ${stream.title || ''}`;
      const heightMatch = nameTitle.match(/(\d{3,})p/i);
      const height = heightMatch ? parseInt(heightMatch[1]) : undefined;

      // Extract size from title
      const sizeMatch = nameTitle.match(/([\d.]+)\s*(GB|MB)/i);
      let fileSize = undefined;
      if (sizeMatch) {
        const val = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        fileSize = unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
      }

      results.push({
        url: new URL(url),
        meta: {
          countryCodes: [CountryCode.multi, ...findCountryCodes(nameTitle)],
          title: stream.title || title,
          ...(height && { height }),
          ...(stream.behaviorHints?.videoSize && { bytes: stream.behaviorHints.videoSize }),
          ...(fileSize && { bytes: fileSize }),
        },
      });
    }

    return results;
  }
}

