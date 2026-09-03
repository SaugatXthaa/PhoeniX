// src/extractor/index.js
// Ported from research/webstreamr-mbg/src/extractor/index.ts

import { DoodStream } from './DoodStream.js';
import { Dropload } from './Dropload.js';
import { ExternalUrl } from './ExternalUrl.js';
import { FileMoon } from './FileMoon.js';
import { Fsst } from './Fsst.js';
import { HBLinks } from './HBLinks.js';
import { HDStream4U } from './HDStream4U.js';
import { HubExtractor } from './HubExtractor.js';
import { KinoGer } from './KinoGer.js';
import { LuluStream } from './LuluStream.js';
import { MovieBox } from './MovieBox.js';
import { SaveFiles } from './SaveFiles.js';
import { StreamEmbed } from './StreamEmbed.js';
import { SuperVideo } from './SuperVideo.js';
import { Vidara } from './Vidara.js';
import { Vidsonic } from './Vidsonic.js';
import { VidKing } from './VidKing.js';
// AcerMovies — passthrough for direct GDrive CDN URLs
import { AcerMovies } from './AcerMovies.js';
// DirectStream — passthrough for direct playable CDN URLs (CineWave HdHub, Fmovies)
import { DirectStream } from './DirectStream.js';
import { EmbedResolver } from './EmbedResolver.js';
// Netlio — passthrough for direct HLS URLs from netlio.vercel.app
import { Netlio } from './Netlio.js';
// AnimeDirect — passthrough for anime HLS/MP4 URLs (AniDB, AniNeko, HiAnime, etc.)
import { AnimeDirect } from './AnimeDirect.js';
// Megaplay — megaplay.buzz / vidtube.site embed pages (Anikoto, StreamXTV anime)
import { Megaplay } from './Megaplay.js';
// VidHawk — vidhawk.buzz embed pages (Itachi source) — REST API → HLS + subs
import { VidHawk } from './VidHawk.js';
// Pantyflix — passthrough for direct MP4/MKV URLs (must come before Netlio
// to prevent Netlio from claiming *.workers.dev URLs from Pantyflix source)
import { Pantyflix as PantyflixExtractor } from './Pantyflix.js';
// AnimeGG — routes animegg.org MP4 through /proxy with Referer
import { AnimeGG as AnimeGGExtractor } from './AnimeGG.js';
// 2Peckle — passthrough for shegu.net direct MKV/HLS URLs
import { Peckle as PeckleExtractor } from './Peckle.js';
// HiAnime — routes aniwatchtv.uk HLS through /proxy with Referer
import { HiAnime as HiAnimeExtractor } from './HiAnime.js';
// AnimeKai — routes aniwatchtv.uk HLS through /proxy with Referer (same backend as HiAnime)
import { AnimeKai as AnimeKaiExtractor } from './AnimeKai.js';
// Nuvio — wraps Nuvio provider streams with /proxy when Referer is needed
import { NuvioExtractor } from './NuvioExtractor.js';

export { Extractor } from './Extractor.js';
export { ExtractorRegistry } from './ExtractorRegistry.js';

export const createExtractors = (fetcher, logger) => {
  const disabledExtractors = (process.env.DISABLED_EXTRACTORS || '').split(',').filter(Boolean);

  const hubExtractor = new HubExtractor(fetcher, logger);

  return [
    // Pantyflix — passthrough for direct MP4/MKV URLs (must come before Netlio)
    new PantyflixExtractor(fetcher, logger),
    // AnimeGG — routes animegg.org MP4 through /proxy with Referer
    new AnimeGGExtractor(fetcher, logger),
    // 2Peckle — passthrough for shegu.net direct MKV/HLS URLs
    new PeckleExtractor(fetcher, logger),
    // HiAnime — routes aniwatchtv.uk HLS through /proxy with Referer
    new HiAnimeExtractor(fetcher, logger),
    // AnimeKai — routes aniwatchtv.uk HLS through /proxy with Referer
    new AnimeKaiExtractor(fetcher, logger),
    // Nuvio — wraps Nuvio provider streams with /proxy when Referer is needed
    new NuvioExtractor(fetcher, logger),
    // Netlio — passthrough for direct HLS URLs (claim before ExternalUrl)
    new Netlio(fetcher, logger),
    // AnimeDirect — passthrough for anime HLS/MP4 URLs
    new AnimeDirect(fetcher, logger),
    // Megaplay — megaplay.buzz / vidtube.site embed pages (Anikoto, StreamXTV anime)
    new Megaplay(fetcher, logger),
    // VidHawk — vidhawk.buzz embed pages (Itachi source) — REST API → HLS + subs
    new VidHawk(fetcher, logger),
    // HubCloud extractors (must come first — handles hubcloud/hubdrive/hubcdn)
    hubExtractor,
    new HBLinks(fetcher, logger, hubExtractor),

    // Direct video host extractors (no MediaFlowProxy needed)
    new DoodStream(fetcher, logger),
    new Dropload(fetcher, logger),
    new FileMoon(fetcher, logger),
    new Fsst(fetcher, logger),
    new HDStream4U(fetcher, logger),
    new KinoGer(fetcher, logger),
    new LuluStream(fetcher, logger),
    new MovieBox(fetcher, logger),
    new SaveFiles(fetcher, logger),
    new StreamEmbed(fetcher, logger),
    new SuperVideo(fetcher, logger),
    new Vidara(fetcher, logger),
    new Vidsonic(fetcher, logger),

    // VidKing — speedracelight API fallback (TMDB-based)
    new VidKing(fetcher, logger),

    // Cinepro-org/core ports (additive — placed before fallback)
    // AcerMovies — passthrough for direct GDrive CDN URLs
    new AcerMovies(fetcher, logger),
    // DirectStream — passthrough for direct playable CDN URLs
    new DirectStream(fetcher, logger),
    // EmbedResolver — generic fallback for embed pages (vidsrc.to, vidzee, voe, etc.)
    new EmbedResolver(fetcher, logger),

    // Fallback — must come last
    new ExternalUrl(fetcher, logger),
  ].filter(extractor => !disabledExtractors.includes(extractor.id));
};
