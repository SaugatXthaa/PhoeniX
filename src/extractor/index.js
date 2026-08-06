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

export { Extractor } from './Extractor.js';
export { ExtractorRegistry } from './ExtractorRegistry.js';

export const createExtractors = (fetcher, logger) => {
  const disabledExtractors = (process.env.DISABLED_EXTRACTORS || '').split(',').filter(Boolean);

  const hubExtractor = new HubExtractor(fetcher, logger);

  return [
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

    // Fallback — must come last
    new ExternalUrl(fetcher, logger),
  ].filter(extractor => !disabledExtractors.includes(extractor.id));
};
