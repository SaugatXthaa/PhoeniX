// src/source/Vidzee.js
// Ported from research/webstreamr-mbg/src/source/Vidzee.ts

import { CountryCode } from '../types.js';
import { getTmdbId } from '../utils/index.js';
import { Source } from './Source.js';

const VIDZEE_SERVERS = [
  { sr: '3', flag: 'US', name: 'Achilles', countryCode: CountryCode.en },
  { sr: '5', flag: 'US', name: 'Drag', countryCode: CountryCode.en },
  { sr: '6', flag: 'VN', name: 'Viet', countryCode: CountryCode.vi },
  { sr: '7', flag: 'IN', name: 'Hindi', countryCode: CountryCode.hi },
  { sr: '8', flag: 'IN', name: 'Bengali', countryCode: CountryCode.hi },
  { sr: '9', flag: 'IN', name: 'Tamil', countryCode: CountryCode.ta },
  { sr: '10', flag: 'IN', name: 'Telugu', countryCode: CountryCode.te },
  { sr: '11', flag: 'IN', name: 'Malayalam', countryCode: CountryCode.ml },
];

export class Vidzee extends Source {
  constructor(fetcher) {
    super();
    this.id = 'vidzee';
    this.label = 'VidZee';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi];
    this.baseUrl = 'https://player.vidzee.wtf';
    this.fetcher = fetcher;
  }

  async handleInternal(ctx, _type, id) {
    const tmdbId = await getTmdbId(this.fetcher, ctx, id);

    const servers = VIDZEE_SERVERS.filter(server =>
      server.countryCode === CountryCode.en || server.countryCode === CountryCode.multi,
    );

    return servers.map((server) => {
      let url;
      if (tmdbId.season) {
        url = new URL(`/v2/embed/tv/${tmdbId.id}/${tmdbId.season}/${tmdbId.episode}`, this.baseUrl);
      } else {
        url = new URL(`/v2/embed/movie/${tmdbId.id}`, this.baseUrl);
      }
      url.searchParams.set('sr', server.sr);

      return {
        url,
        meta: {
          countryCodes: [server.countryCode],
          title: `${server.name} (${server.flag})`,
        },
      };
    });
  }
}
