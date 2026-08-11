// src/source/Movie4kTo.js
// movie4kto.pro — TMDB-based movie/TV streaming site
//
// React SPA that uses TMDB IDs and embeds from multiple sources.
// We ONLY keep embed URLs that have a dedicated extractor:
//   - vidsrc-embed.ru  → VidSrc extractor  (host matches /vidsrc|vsrc|vsembed/)
//   - player.vidzee.wtf → Vidzee extractor (host matches *.vidzee.wtf)
//   - vidsrc.to        → VidSrc extractor  (host matches /vidsrc|vsrc|vsembed/)
//
// We do NOT pass meta.vidking (speedracelight fallback) because the
// speedracelight API uses fuzzy title matching and returns wrong content
// for certain TMDB IDs (e.g. "The Last House" instead of "Minions & Monsters").
// We also drop embed sources that have no dedicated extractor (moviesapi.club,
// vidlink.pro, player.videasy.net, 111movies.com) because without vidking they
// produce 0 streams anyway, and with vidking they produce WRONG movies.

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

// Embed sources used by movie4kto.pro that have a dedicated extractor.
// Each URL is TMDB-ID-keyed, so it always resolves to the correct content.
const EMBED_SOURCES = [
  { label: 'VidSrc',   movie: 'https://vidsrc-embed.ru/embed/movie/{id}', tv: 'https://vidsrc-embed.ru/embed/tv/{id}/{s}/{e}' },
  { label: 'VidZee',   movie: 'https://player.vidzee.wtf/embed/movie/{id}', tv: 'https://player.vidzee.wtf/embed/tv/{id}?season={s}&episode={e}' },
  { label: 'VidSrcTo', movie: 'https://vidsrc.to/embed/movie/{id}',       tv: 'https://vidsrc.to/embed/tv/{id}/{s}/{e}' },
];

export class Movie4kTo extends Source {
  constructor(fetcher) {
    super();
    this.id = 'movie4kto';
    this.label = 'Movie4kTo';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://movie4kto.pro';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const results = [];
    for (const source of EMBED_SOURCES) {
      const url = tmdbId.season
        ? source.tv.replace('{id}', tmdbId.id).replace('{s}', tmdbId.season).replace('{e}', tmdbId.episode)
        : source.movie.replace('{id}', tmdbId.id);

      results.push({
        url: new URL(url),
        meta: {
          countryCodes: [CountryCode.multi],
          title: `${title} (${source.label})`,
          sourceId: this.id,
          sourceLabel: this.label,
        },
      });
    }

    return results;
  }
}
