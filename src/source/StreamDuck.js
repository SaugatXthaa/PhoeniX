// src/source/StreamDuck.js
// streamduck.site — TMDB-based movie/TV/anime/kdrama streaming aggregator
//
// StreamDuck is a thin SPA shell that uses TMDB for catalog/metadata and
// embeds third-party players keyed by TMDB ID. Two "server" choices:
//   - vidsrc.me/embed/movie?tmdb={id}  → 301 → vidsrcme.ru (CloudOrchestra player)
//   - vidsrc.to/embed/movie/{id}        → vsembed.ru (CF-protected inner iframe)
//
// Both URLs are claimable by the existing VidSrc extractor (matches
// `vidsrc|vsrc|vsembed` hostnames). The vidsrc.me path resolves through
// the VidSrc extractor's multi-domain rotation (vidsrcme.ru, vidsrcme.su,
// vsembed.ru, vsembed.su, vsrc.su) to extract HLS streams.
//
// For movies, we also pass meta.vidking for the VidKing extractor fallback
// (resolves via speedracelight's TMDB-based API). Series rely on the
// VidSrc extractor's own embed-page parsing.
//
// Same pattern as Movie4kTo/VidSrcSbs — TMDB ID is the only lookup key,
// so no search step is needed. Anime and kdrama are covered because they
// are normal TMDB TV/movie entries (Stremio resolves kitsu/anilist IDs
// to TMDB via cinemeta).

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

// StreamDuck's two "server" choices (from app.js analysis)
const EMBED_SOURCES = [
  { label: 'VidSrcMe', movie: 'https://vidsrc.me/embed/movie?tmdb={id}',  tv: 'https://vidsrc.me/embed/tv?tmdb={id}&season={s}&episode={e}' },
  { label: 'VidSrcTo', movie: 'https://vidsrc.to/embed/movie/{id}',         tv: 'https://vidsrc.to/embed/tv/{id}/{s}/{e}' },
];

export class StreamDuck extends Source {
  constructor(fetcher) {
    super();
    this.id = 'streamduck';
    this.label = 'StreamDuck';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://streamduck.site';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Pass meta.vidking for movies only — speedracelight returns wrong content
    // for series/anime (see VidSrc.js / Movie4kTo.js comments).
    const vidkingMeta = tmdbId.season ? null : {
      name,
      year,
      tmdbId: tmdbId.id,
    };

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
          ...(vidkingMeta && { vidking: vidkingMeta }),
        },
      });
    }

    return results;
  }
}
