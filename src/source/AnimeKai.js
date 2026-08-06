// src/source/AnimeKai.js
// animekai.uno / animekai.cl — anime streaming with sub + dub
//
// AnimeKai watch pages embed https://megaplay.buzz/stream/mal/{malId}/{ep}/{sub|dub}
// The megaplay player's stream URLs are loaded by obfuscated client-side JS
// that can't be replicated server-side. We pass meta.vidking for the VidKing
// extractor to resolve via speedracelight's TMDB-based API, which has wide
// anime coverage (Blue Lock, Frieren, Dan Da Dan, Witch Hat Atelier, etc.).
//
// Both sub and dub audio types are included as separate stream entries.

import { CountryCode } from '../types.js';
import { getTmdbId, getTmdbNameAndYear, TmdbId } from '../utils/index.js';
import { Source } from './Source.js';

// AnimeKai mirror list — try .uno first, fall back to .cl
const MIRRORS = [
  'https://animekai.uno',
  'https://animekai.cl',
];

export class AnimeKai extends Source {
  constructor(fetcher) {
    super();
    this.id = 'animekai';
    this.label = 'AnimeKai';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.ja];
    this.baseUrl = MIRRORS[0];
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);
    const [name, year] = await getTmdbNameAndYear(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    // Build watch URLs for both sub and dub audio types
    // AnimeKai URL pattern: /watch/{slug}-episode-{N}
    // The slug is derived from the anime title — but since we can't reliably
    // predict it, we pass the TMDB-based vidking metadata for the VidKing
    // extractor to resolve via speedracelight.
    const vidkingMeta = {
      name,
      year,
      tmdbId: tmdbId.id,
      ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
    };

    const episodeNum = tmdbId.season ? (tmdbId.episode || 1) : 1;
    const results = [];

    // Sub and Dub variants — both as separate stream entries
    for (const audioType of ['sub', 'dub']) {
      const audioLabel = audioType === 'dub' ? 'Dub' : 'Sub';

      // Use megaplay.buzz embed URL (same as AnimeKai uses in its iframe)
      // with mal parameter — the VidKing extractor resolves via meta.vidking
      const megaplayUrl = new URL(`/stream/mal/${tmdbId.id}/${episodeNum}/${audioType}`, 'https://megaplay.buzz');

      results.push({
        url: megaplayUrl,
        meta: {
          countryCodes: [CountryCode.multi, CountryCode.ja],
          title: `${title} (${audioLabel})`,
          vidking: vidkingMeta,
        },
      });
    }

    return results;
  }
}
