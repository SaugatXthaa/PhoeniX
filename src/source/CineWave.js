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
// Matches the server list in the CineWave UI (Server Hub):
// VE, VCC, 2EM, VF, VC, RIVE, ZEE, AIR, SYNC, ROCK, HEXA, ORA, PEACH,
// MAP, KING, TOU, VSE, 111M, FM, COS, LUX, HDH
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
  { label: 'ZoroStream', movie: 'https://zorostream.com/embed/movie/{id}', tv: 'https://zorostream.com/embed/tv/{id}/{s}/{e}' },
  { label: 'VidSrcMe', movie: 'https://vidsrc.me/embed/movie?tmdb={id}', tv: 'https://vidsrc.me/embed/tv?tmdb={id}&season={s}&episode={e}' },
  { label: 'EmbedSu', movie: 'https://embed.su/embed/movie/{id}', tv: 'https://embed.su/embed/tv/{id}/{s}/{e}' },
  { label: 'MultiEmbed', movie: 'https://multiembed.mov/?video_id={id}&tmdb=1', tv: 'https://multiembed.mov/?video_id={id}&tmdb=1&s={s}&e={e}' },
  { label: 'SuperFlix', movie: 'https://superflixapi.co/filme/{id}', tv: 'https://superflixapi.co/serie/{id}/{s}/{e}' },
  { label: 'MoviesApi', movie: 'https://moviesapi.club/movie/{id}', tv: 'https://moviesapi.club/tv/{id}-{s}-{e}' },
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

          // Filter out streams that belong to a different movie.
          // The CineWave/HdHub API returns ALL movies matching the search term,
          // so we must verify the stream's title matches the requested movie.
          // Strategy: the movie name must appear as a COMPLETE PHRASE in the
          // stream text, not just as a substring of a longer word.
          // "Mutiny" should NOT match "The.Caine.Mutiny.Court.Martial" because
          // "Mutiny" is part of a longer title, not the movie name itself.
          const streamText = (nameTitle + ' ' + (stream.title || '')).toLowerCase();
          const nameLower = name.toLowerCase();
          const nameNormalized = nameLower.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
          const streamNormalized = streamText.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

          if (nameNormalized.length > 3 && streamNormalized.length > 30) {
            // Check that the movie name appears as a word boundary phrase.
            // Use word-boundary regex to ensure "mutiny" matches only when
            // it's a complete word, not when it's part of "mutinycourtmartial"
            // (after normalization, dots become spaces so "the caine mutiny
            // court martial" → "the caine mutiny court martial" which contains
            // "mutiny" as a word but it's NOT the movie title).
            //
            // The real fix: check that the stream text, when stripped of quality/
            // codec/size info, STARTS WITH the movie name or IS the movie name.
            // Extract just the title portion (before quality info like "1080p")
            const titlePart = streamNormalized.split(/\d{3,}p|\d{3,} gb|\d{3,} mb|\d+\.\d+ gb|\d+\.\d+ mb/i)[0].trim();
            if (!titlePart.startsWith(nameNormalized) && titlePart !== nameNormalized) {
              // Also check if the title part is short enough to be the movie name
              // (some streams have server label prefix like "vm fsl" before the title)
              // Check the last N words of the title part
              const nameWords = nameNormalized.split(' ');
              const titleWords = titlePart.split(' ');
              // If the title part ends with the movie name, it's a match
              // (e.g. "vm fsl the caine mutiny court martial" → ends with "mutiny"? NO)
              const endsWithName = titleWords.slice(-nameWords.length).join(' ') === nameNormalized;
              if (!endsWithName) {
                continue;
              }
            }
          }

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

          // Clean "HdHub" branding from the title — these are CineWave streams
          let cleanTitle = stream.title || nameTitle.trim() || title;
          cleanTitle = cleanTitle.replace(/^HdHub\s+/i, '').replace(/^HdHub\s*\/\s*VM\s+/i, '');

          results.push({
            url: new URL(url),
            meta: {
              countryCodes: [CountryCode.multi, ...findCountryCodes(nameTitle)],
              title: cleanTitle,
              ...(height && { height }),
              ...(fileSize && { bytes: fileSize }),
              sourceId: 'cinewave',
              sourceLabel: 'CineWave',
            },
          });
        }
      }
    } catch { /* HdHub API failed — continue to embed sources */ }

    // === Layer 2: Embed sources (fallback) ===
    // Only pass meta.vidking for MOVIES — the speedracelight API returns
    // wrong content for series/anime (fuzzy title matching issue).
    const vidkingMeta = tmdbId.season ? null : {
      name,
      year,
      tmdbId: tmdbId.id,
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
          sourceId: 'cinewave',
          sourceLabel: 'CineWave',
          ...(vidkingMeta && { vidking: vidkingMeta }),
        },
      });
    }

    return results;
  }
}
