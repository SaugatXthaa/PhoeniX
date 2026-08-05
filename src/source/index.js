// src/source/index.js
// Ported from research/webstreamr-mbg/src/source/index.ts

import { CineHDPlus } from './CineHDPlus.js';
import { CineWave } from './CineWave.js';
import { AnimeFlix } from './AnimeFlix.js';
import { Cuevana } from './Cuevana.js';
import { Einschalten } from './Einschalten.js';
import { Eurostreaming } from './Eurostreaming.js';
import { FilmpalastTO } from './FilmpalastTO.js';
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
import { MovieBox } from './MovieBox.js';
import { Movix } from './Movix.js';
import { NineAnime } from './NineAnime.js';
import { PrimeShows } from './PrimeShows.js';
import { VerHdLink } from './VerHdLink.js';
import { VidSrc } from './VidSrc.js';
import { Vidzee } from './Vidzee.js';
import { VixSrc } from './VixSrc.js';

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
    new CineWave(fetcher),
    new PrimeShows(fetcher),
    // anime
    new NineAnime(fetcher),
    new HiAnime(fetcher),
    new AnimeFlix(fetcher),
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
    // IT
    new Eurostreaming(fetcher),
    new MostraGuarda(fetcher),
  ].filter(source => !disabledSources.includes(source.id));
};
