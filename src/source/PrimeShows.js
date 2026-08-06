// src/source/PrimeShows.js
// primeshows.gd — TMDB-based streaming site with multiple embed servers
// Watch page: /watch/movie/{tmdb_id} or /watch/tv/{tmdb_id}/season/{s}/episode/{e}?server={name}
// Each server returns a different embed iframe URL (vidsrc.mov, vidsrc.fyi, etc.)

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const SERVERS = [
  { key: 'vidsrcto', label: 'VidSrc' },
  { key: 'vidsrcfyi', label: 'VidSrc.fyi' },
  { key: 'vidnest', label: 'Vidnest' },
  { key: 'vidlink', label: 'VidLink' },
  { key: 'vidfast', label: 'VidFast' },
  { key: '2embed', label: '2Embed' },
];

export class PrimeShows extends Source {
  constructor(fetcher) {
    super();
    this.id = 'primeshows';
    this.label = 'PrimeShows';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://primeshows.gd';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const mediaType = tmdbId.season ? 'tv' : 'movie';
    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Build watch URLs for each server
    const watchPath = mediaType === 'tv'
      ? `/watch/tv/${tmdbId.id}/season/${tmdbId.season || 1}/episode/${tmdbId.episode || 1}`
      : `/watch/movie/${tmdbId.id}`;

    const results = [];
    const vidkingMeta = {
      name,
      year,
      tmdbId: tmdbId.id,
      ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
    };

    for (const server of SERVERS) {
      const watchUrl = new URL(`${watchPath}?server=${server.key}`, this.baseUrl);
      try {
        const html = await this.fetcher.text(ctx, watchUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          timeout: 8000,
        });
        const iframeMatch = html.match(/<iframe[^>]*id="playerFrame"[^>]*src="([^"]+)"/i);
        if (iframeMatch && iframeMatch[1]) {
          results.push({
            url: new URL(iframeMatch[1].replace(/&amp;/g, '&')),
            meta: {
              countryCodes: [CountryCode.multi],
              title: `${title} (${server.label})`,
              vidking: vidkingMeta,
            },
          });
        }
      } catch { /* skip failed server */ }
    }

    return results;
  }
}
