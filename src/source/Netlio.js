// src/source/Netlio.js
// netlio.vercel.app — movies, TV series, anime, K-drama with direct HLS streams
//
// Flow:
//   1. Movies: fetch HLS URL from GitHub API
//      https://raw.githubusercontent.com/Watchout2025/api/refs/heads/main/hls/movie/{tmdbId}
//      → returns direct HLS master URL (with Hindi + English audio tracks)
//
//   2. TV/Series: fetch episode HLS URL from GitHub JSON API
//      https://raw.githubusercontent.com/Watchout2025/api/refs/heads/main/hls/tv/{tmdbId}/S{season}.json
//      → returns JSON { "1": "https://...master.txt", "2": "https://...", ... }
//      → pick episode {episode} from the JSON
//
// All HLS URLs require Referer: https://netlio.vercel.app/ to play.
// The HLS master playlist contains multiple audio tracks (Hindi, English)
// and quality variants (480p, 720p, 1080p).

import { CountryCode, Format } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const API_BASE = 'https://raw.githubusercontent.com/Watchout2025/api/refs/heads/main/hls';
const REFERER = 'https://netlio.vercel.app/';

export class Netlio extends Source {
  constructor(fetcher) {
    super();
    this.id = 'netlio';
    this.label = 'Netlio';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.hi, CountryCode.en];
    this.baseUrl = 'https://netlio.vercel.app';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const results = [];

    if (tmdbId.season) {
      // TV series — fetch episode HLS URL from JSON API
      const seasonUrl = new URL(`${API_BASE}/tv/${tmdbId.id}/S${tmdbId.season}.json`);
      try {
        const json = await this.fetcher.json(ctx, seasonUrl, { timeout: 10000 });
        if (json && typeof json === 'object') {
          const episodeKey = String(tmdbId.episode || 1);
          const hlsUrl = json[episodeKey];
          if (hlsUrl) {
            let parsed;
            try { parsed = new URL(hlsUrl); } catch { /* invalid */ }
            if (parsed) {
              results.push({
                url: parsed,
                format: Format.hls,
                meta: {
                  countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
                  title: `${title} (Hindi + English)`,
                  sourceId: this.id,
                  sourceLabel: this.label,
                },
                requestHeaders: { Referer: REFERER },
              });
            }
          }
        }
      } catch { /* season not available */ }
    } else {
      // Movie — fetch direct HLS URL
      const movieUrl = new URL(`${API_BASE}/movie/${tmdbId.id}`);
      try {
        const hlsUrl = await this.fetcher.text(ctx, movieUrl, { timeout: 10000 });
        if (hlsUrl && !hlsUrl.includes('404')) {
          let parsed;
          try { parsed = new URL(hlsUrl.trim()); } catch { /* invalid */ }
          if (parsed) {
            results.push({
              url: parsed,
              format: Format.hls,
              meta: {
                countryCodes: [CountryCode.multi, CountryCode.hi, CountryCode.en],
                title: `${title} (Hindi + English)`,
                sourceId: this.id,
                sourceLabel: this.label,
              },
              requestHeaders: { Referer: REFERER },
            });
          }
        }
      } catch { /* movie not available */ }
    }

    return results;
  }
}
