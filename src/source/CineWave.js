// src/source/CineWave.js
// CineWave (watch.cinewave.qzz.io) — movies/series/anime/K-drama
//
// Two layers of stream resolution:
//   1. HdHub API (hdhub.thevolecitor.qzz.io) — FREE, no auth required.
//      Uses IMDB IDs (tt...). Returns direct CDN URLs from:
//      - FSL/FSL2 (fileshub.jiocloud3.workers.dev, files.jiomovies.workers.dev)
//      - Pixeldrain (pixeldrain.dev)
//      - Cloudflare R2 (*.r2.cloudflarestorage.com, *.r2.dev)
//      - HubCDN (video-downloads.googleusercontent.com — GDrive proxy)
//      - Jio workers (index.jioservers.workers.dev, etc.)
//      The "🌟 Donation needed." stream is just 1 of ~35 streams — skip it.
//      DO NOT use TMDB IDs with this API — it returns only the donation stream.
//
//   2. Embed sources (16 fallback embeds) — resolved via VidKing extractor's
//      speedracelight API fallback (meta.vidking).

import { CountryCode } from '../types.js';
import { getImdbId, getTmdbId, getTmdbNameAndYear, TmdbId, findCountryCodes } from '../utils/index.js';
import { Source } from './Source.js';

// HdHub API (Stremio addon format) — FREE, no auth
const CINEWAVE_API_BASE = 'https://hdhub.thevolecitor.qzz.io';
const CINEWAVE_CONFIG = Buffer.from(JSON.stringify({
  torbox: 'unset',
  qualities: '2160p,1080p,720p',
  sort: 'desc',
})).toString('base64');

// All embed sources used by CineWave (from JS bundle analysis)
const EMBED_SOURCES = [
  { label: 'VidSrc', movie: 'https://vidsrc-embed.ru/embed/movie/{id}', tv: 'https://vidsrc-embed.ru/embed/tv/{id}/{s}/{e}' },
  { label: '2Embed', movie: 'https://2embed.cc/embed/movie/{id}', tv: 'https://2embed.cc/embed/tv/{id}&s={s}&e={e}' },
  { label: 'Vidzee', movie: 'https://player.vidzee.wtf/embed/movie/{id}', tv: 'https://player.vidzee.wtf/embed/tv/{id}?season={s}&episode={e}' },
  { label: 'VidFast', movie: 'https://vidfast.pro/movie/{id}', tv: 'https://vidfast.pro/tv/{id}/{s}/{e}' },
  { label: 'Videasy', movie: 'https://player.videasy.net/movie/{id}', tv: 'https://player.videasy.net/tv/{id}/{s}/{e}' },
  { label: 'Peachify', movie: 'https://peachify.top/embed/movie/{id}', tv: 'https://peachify.top/embed/tv/{id}?season={s}&episode={e}' },
  { label: 'CinemaOS', movie: 'https://cinemaos.tech/embed/movie/{id}', tv: 'https://cinemaos.tech/embed/tv/{id}?s={s}&e={e}' },
  { label: 'VidCore', movie: 'https://vidcore.net/embed/movie/{id}', tv: 'https://vidcore.net/embed/tv/{id}/{s}/{e}' },
  { label: 'VidKing', movie: 'https://vidking.net/embed/movie/{id}', tv: 'https://vidking.net/embed/tv/{id}/{s}/{e}' },
  { label: 'VidLux', movie: 'https://vidlux.xyz/embed/movie/{id}', tv: 'https://vidlux.xyz/embed/tv/{id}/{s}/{e}' },
  { label: 'Hexa', movie: 'https://hexa.su/embed/movie/{id}', tv: 'https://hexa.su/embed/tv/{id}/{s}/{e}' },
  { label: 'MappleTV', movie: 'https://mappletv.uk/embed/movie/{id}', tv: 'https://mappletv.uk/embed/tv/{id}/{s}/{e}' },
  { label: 'RiveStream', movie: 'https://rivestream.org/embed?type=movie&id={id}', tv: 'https://rivestream.org/embed?type=tv&id={id}&season={s}&episode={e}' },
  { label: 'AirFlix', movie: 'https://airflix1.com/movie/{id}', tv: 'https://airflix1.com/tv/{id}/{s}/{e}' },
  { label: 'FMovies', movie: 'https://fmovies.gd/movie/{id}', tv: 'https://fmovies.gd/tv/{id}?s={s}&e={e}' },
  { label: '111Movies', movie: 'https://111movies.net/movie/{id}', tv: 'https://111movies.net/tv/{id}?s={s}&e={e}' },
];

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
    const imdbId = await getImdbId(this.fetcher, ctx, tmdbId);

    const title = name + (tmdbId.season ? ` ${TmdbId.formatSeasonAndEpisode(tmdbId)}` : ` (${year})`);

    const results = [];

    // === Layer 1: HdHub API (IMDB IDs) ===
    // FREE, no auth. Returns ~35 direct CDN streams (FSL, Pixeldrain, R2, HubCDN).
    // Skip the single "Donation needed" stream — it's just 1 of many.
    try {
      const imdbStreamId = tmdbId.season
        ? `${imdbId.id}:${tmdbId.season}:${tmdbId.episode}`
        : imdbId.id;
      const mediaType = tmdbId.season ? 'series' : 'movie';
      const apiUrl = new URL(`/${CINEWAVE_CONFIG}/stream/${mediaType}/${imdbStreamId}.json`, CINEWAVE_API_BASE);

      const response = await this.fetcher.json(ctx, apiUrl, {
        headers: {
          'Referer': 'https://watch.cinewave.qzz.io/',
          'Accept': 'application/json',
        },
        timeout: 10000,
      });

      if (response && response.streams && Array.isArray(response.streams)) {
        for (const stream of response.streams) {
          // Skip donation streams — they're not real content
          if (stream.name && /donation|donate/i.test(stream.name)) continue;
          if (stream.description && /donation|donate/i.test(stream.description)) continue;

          const url = stream.url || stream.externalUrl;
          if (!url) continue;

          const nameTitle = `${stream.name || ''} ${stream.description || ''}`;
          const heightMatch = nameTitle.match(/(\d{3,})p/i);
          const height = heightMatch ? parseInt(heightMatch[1]) : undefined;

          let fileSize = undefined;
          if (stream.behaviorHints?.videoSize) {
            fileSize = stream.behaviorHints.videoSize;
          } else {
            const sizeMatch = nameTitle.match(/([\d.]+)\s*(GB|MB)/i);
            if (sizeMatch) {
              const val = parseFloat(sizeMatch[1]);
              const unit = sizeMatch[2].toUpperCase();
              fileSize = unit === 'GB' ? val * 1024 * 1024 * 1024 : val * 1024 * 1024;
            }
          }

          results.push({
            url: new URL(url),
            meta: {
              countryCodes: [CountryCode.multi, ...findCountryCodes(nameTitle)],
              title: stream.title || nameTitle.trim() || title,
              ...(height && { height }),
              ...(fileSize && { bytes: fileSize }),
              // Tag as HdHub source so download label is applied
              sourceId: 'cinewave',
              sourceLabel: 'CineWave',
            },
          });
        }
      }
    } catch { /* HdHub API failed — continue to embed sources */ }

    // === Layer 2: Embed sources (fallback) ===
    // Pass meta.vidking for ALL content (movies + series + anime).
    // The speedracelight API returns correct stream URLs for series/anime.
    // The VidKing extractor uses preloaded.name for the title display.
    const vidkingMeta = {
      name,
      year,
      tmdbId: tmdbId.id,
      ...(tmdbId.season && { season: tmdbId.season, episode: tmdbId.episode }),
    };

    for (const source of EMBED_SOURCES) {
      const url = tmdbId.season
        ? source.tv.replace('{id}', tmdbId.id).replace('{s}', tmdbId.season).replace('{e}', tmdbId.episode)
        : source.movie.replace('{id}', tmdbId.id);

      results.push({
        url: new URL(url),
        meta: {
          countryCodes: [CountryCode.multi],
          title: `${title} (${source.label})`,
          vidking: vidkingMeta,
        },
      });
    }

    return results;
  }
}
