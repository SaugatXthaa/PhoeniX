// src/extractor/index.js
// Ported from research/webstreamr-mbg/src/extractor/index.ts
// Added non-MediaFlowProxy extractors for Voe, Mixdrop, LuluStream, FileMoon, DoodStream, Streamtape

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
import { Mixdrop } from './Mixdrop.js';
import { MovieBox } from './MovieBox.js';
import { SaveFiles } from './SaveFiles.js';
import { StreamEmbed } from './StreamEmbed.js';
import { Streamtape } from './Streamtape.js';
import { SuperVideo } from './SuperVideo.js';
import { Vidara } from './Vidara.js';
import { Vidsonic } from './Vidsonic.js';
import { VidSrc } from './VidSrc.js';
import { Vidzee } from './Vidzee.js';
import { VixSrc } from './VixSrc.js';
import { VidKing } from './VidKing.js';
import { Voe } from './Voe.js';
// Cinepro-org/core ports (additive — no existing extractor modified)
import { Fshare } from './Fshare.js';
// AcerMovies — passthrough for direct GDrive CDN URLs
import { AcerMovies } from './AcerMovies.js';
// DirectStream — passthrough for direct playable CDN URLs (CineWave HdHub, Fmovies)
import { DirectStream } from './DirectStream.js';
// HDHub4uNew and Cinejoy extractors removed — sources no longer exist
// Netlio — passthrough for direct HLS URLs from netlio.vercel.app
import { Netlio } from './Netlio.js';
// AnimeDirect — passthrough for anime HLS/MP4 URLs (AniDB, AniNeko, HiAnime, etc.)
import { AnimeDirect } from './AnimeDirect.js';
// Megaplay — megaplay.buzz / vidtube.site embed pages (Anikoto, StreamXTV anime)
import { Megaplay } from './Megaplay.js';
// ZXCStream — passthrough for ZXCStream direct CDN URLs (must come before Netlio
// so it claims *.workers.dev URLs from ZXCStream source, preserving correct format)
import { ZXCStream as ZXCStreamExtractor } from './ZXCStream.js';
// HDGharTV — passthrough for streamraiwind.stream HLS URLs
import { HDGharTV as HDGharTVExtractor } from './HDGharTV.js';
// AniPriv8 — routes anipriv8.online HLS through /proxy for m3u8 URL rewriting
import { AniPriv8 as AniPriv8Extractor } from './AniPriv8.js';
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
// (matches by meta.sourceId for: cineby, desiflix, goated, hindmoviez,
// movieblast, movies4u, dahmermovies, dahmermovies4k, playimdb, animezey)
import { NuvioExtractor } from './NuvioExtractor.js';
// Pahe — marks teknoasian.com download URLs as external (browser-openable)
import { Pahe as PaheExtractor } from './Pahe.js';

export { Extractor } from './Extractor.js';
export { ExtractorRegistry } from './ExtractorRegistry.js';

export const createExtractors = (fetcher, logger) => {
  const disabledExtractors = (process.env.DISABLED_EXTRACTORS || '').split(',').filter(Boolean);

  const hubExtractor = new HubExtractor(fetcher, logger);

  return [
    // ZXCStream — must come BEFORE Netlio to claim *.workers.dev URLs from
    // ZXCStream source (Netlio would otherwise force them to HLS format)
    new ZXCStreamExtractor(fetcher, logger),
    // HDGharTV — passthrough for streamraiwind.stream HLS URLs
    new HDGharTVExtractor(fetcher, logger),
    // AniPriv8 — routes anipriv8.online HLS through /proxy for m3u8 URL rewriting
    new AniPriv8Extractor(fetcher, logger),
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
    // (must come before Netlio/DirectStream/ExternalUrl so it claims Nuvio URLs
    // by meta.sourceId — matches: cineby, desiflix, goated, hindmoviez,
    // movieblast, movies4u, dahmermovies, dahmermovies4k, playimdb, animezey)
    new NuvioExtractor(fetcher, logger),
    // Netlio — passthrough for direct HLS URLs (claim before ExternalUrl)
    new Netlio(fetcher, logger),
    // AnimeDirect — passthrough for anime HLS/MP4 URLs
    new AnimeDirect(fetcher, logger),
    // Megaplay — megaplay.buzz / vidtube.site embed pages (Anikoto, StreamXTV anime)
    new Megaplay(fetcher, logger),
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
    new Mixdrop(fetcher, logger),
    new MovieBox(fetcher, logger),
    new SaveFiles(fetcher, logger),
    new StreamEmbed(fetcher, logger),
    new Streamtape(fetcher, logger),
    new SuperVideo(fetcher, logger),
    new Vidara(fetcher, logger),
    new Vidsonic(fetcher, logger),
    new Vidzee(fetcher, logger),
    new Voe(fetcher, logger),

    // Embed page extractors (extract m3u8 from player pages)
    new VidSrc(fetcher, logger, [ // https://vidsrc.domains/
      'vidsrcme.ru',
      'vidsrcme.su',
      'vidsrc-me.ru',
      'vidsrc-me.su',
      'vsembed.ru',
      'vsembed.su',
      'vsrc.su',
    ]),
    new VixSrc(fetcher, logger),
    new VidKing(fetcher, logger),

    // Cinepro-org/core ports (additive — placed before fallback)
    new Fshare(fetcher, logger),
    // AcerMovies — passthrough for direct GDrive CDN URLs
    new AcerMovies(fetcher, logger),
    // DirectStream — passthrough for direct playable CDN URLs
    new DirectStream(fetcher, logger),
    // Pahe — marks teknoasian.com download URLs as external (browser-openable)
    // Must come before ExternalUrl fallback so it claims pahe URLs by sourceId
    new PaheExtractor(fetcher, logger),

    // Fallback — must come last
    new ExternalUrl(fetcher, logger),
  ].filter(extractor => !disabledExtractors.includes(extractor.id));
};
