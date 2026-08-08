// src/source/index.js
// Ported from research/webstreamr-mbg/src/source/index.ts

import { CineHDPlus } from './CineHDPlus.js';
import { CineWave } from './CineWave.js';
import { AnimeFlix } from './AnimeFlix.js';
import { AniDB } from './AniDB.js';
import { AniNeko } from './AniNeko.js';
import { AcerMovies } from './AcerMovies.js';
import { Cuevana } from './Cuevana.js';
import { Einschalten } from './Einschalten.js';
import { Eurostreaming } from './Eurostreaming.js';
import { FilmpalastTO } from './FilmpalastTO.js';
import { Fmovies } from './Fmovies.js';
import { FourKHDHub } from './FourKHDHub.js';
import { Frembed } from './Frembed.js';
import { FrenchCloud } from './FrenchCloud.js';
import { HDHub4u } from './HDHub4u.js';
import { HiAnime } from './HiAnime.js';
import { HomeCine } from './HomeCine.js';
import { KinoGer } from './KinoGer.js';
import { Kokoshka } from './Kokoshka.js';
import { MegaKino } from './MegaKino.js';
import { MeineCloud } from './MeineCloud.js';
import { MostraGuarda } from './MostraGuarda.js';
import { MoviesDrive } from './MoviesDrive.js';
import { MoviesHunt } from './MoviesHunt.js';
import { MovieBox } from './MovieBox.js';
import { Movie4kTo } from './Movie4kTo.js';
import { Necro } from './Necro.js';
import { Movix } from './Movix.js';
import { NineAnime } from './NineAnime.js';
import { PrimeShows } from './PrimeShows.js';
import { VerHdLink } from './VerHdLink.js';
import { VidSrc } from './VidSrc.js';
import { VidSrcSbs } from './VidSrcSbs.js';
import { WatchSeries } from './WatchSeries.js';
import { ZinkMovies } from './ZinkMovies.js';
import { VidKing } from './VidKing.js';
import { VidFast } from './VidFast.js';
import { VidLink } from './VidLink.js';
import { VidSrcTo } from './VidSrcTo.js';
import { VegaMovies } from './VegaMovies.js';
import { Vidzee } from './Vidzee.js';
import { VixSrc } from './VixSrc.js';
// Cinepro-org/core ports (additive — no existing source modified)
import { CineSu } from './CineSu.js';
import { Fshare } from './Fshare.js';

export { Source } from './Source.js';

export const createSources = (fetcher) => {
  const disabledSources = (process.env.DISABLED_SOURCES || '').split(',').filter(Boolean);

  return [
    // multi
    new FourKHDHub(fetcher),
    new HDHub4u(fetcher),
    new VixSrc(fetcher),
    new VidSrc(),
    new Vidzee(fetcher),
    new MovieBox(fetcher),
    new Movie4kTo(fetcher),
    new Fmovies(fetcher),
    new CineWave(fetcher),
    new MoviesDrive(fetcher),
    new MoviesHunt(fetcher),
    new ZinkMovies(fetcher),
    new WatchSeries(fetcher),
    new Necro(fetcher),
    new VidSrcSbs(fetcher),
    new VidLink(fetcher),
    new VidSrcTo(fetcher),
    new VidKing(fetcher),
    new VidFast(fetcher),
    new VegaMovies(fetcher),
    new PrimeShows(fetcher),
    // cinepro-org/core ports (additive)
    new CineSu(fetcher),
    new Fshare(fetcher),
    // anime
    new NineAnime(fetcher),
    new HiAnime(fetcher),
    new AnimeFlix(fetcher),
    new AniDB(fetcher),
    new AniNeko(fetcher),
    // AL
    new Kokoshka(fetcher),
    // ES / MX
    new CineHDPlus(fetcher),
    new Cuevana(fetcher),
    new HomeCine(fetcher),
    new VerHdLink(fetcher),
    // DE
    new Einschalten(fetcher),
    new KinoGer(fetcher),
    new MegaKino(fetcher),
    new MeineCloud(fetcher),
    new FilmpalastTO(fetcher),
    // FR
    new Frembed(fetcher),
    new FrenchCloud(fetcher),
    new Movix(fetcher),
    // IT — Eurostreaming and MostraGuarda removed (DNS dead)
    // Multi-region (acermovies.fun API — GDrive CDN movies)
    new AcerMovies(fetcher),
  ].filter(source => !disabledSources.includes(source.id));
};
