// src/extractor/index.js
// Ported from research/webstreamr-mbg/src/extractor/index.ts

import { Dropload } from './Dropload.js';
import { ExternalUrl } from './ExternalUrl.js';
import { Fsst } from './Fsst.js';
import { HBLinks } from './HBLinks.js';
import { HDStream4U } from './HDStream4U.js';
import { HubExtractor } from './HubExtractor.js';
import { KinoGer } from './KinoGer.js';
import { MovieBox } from './MovieBox.js';
import { SaveFiles } from './SaveFiles.js';
import { StreamEmbed } from './StreamEmbed.js';
import { SuperVideo } from './SuperVideo.js';
import { Vidara } from './Vidara.js';
import { Vidsonic } from './Vidsonic.js';
import { VidSrc } from './VidSrc.js';
import { Vidzee } from './Vidzee.js';
import { VixSrc } from './VixSrc.js';

export { Extractor } from './Extractor.js';
export { ExtractorRegistry } from './ExtractorRegistry.js';

export const createExtractors = (fetcher, logger) => {
  const disabledExtractors = (process.env.DISABLED_EXTRACTORS || '').split(',').filter(Boolean);

  const hubExtractor = new HubExtractor(fetcher, logger);

  return [
    new Dropload(fetcher, logger),
    new Fsst(fetcher, logger),
    new HBLinks(fetcher, logger, hubExtractor),
    new HDStream4U(fetcher, logger),
    hubExtractor,
    new KinoGer(fetcher, logger),
    new MovieBox(fetcher, logger),
    new SaveFiles(fetcher, logger),
    new StreamEmbed(fetcher, logger),
    new SuperVideo(fetcher, logger),
    new Vidara(fetcher, logger),
    new Vidsonic(fetcher, logger),
    new Vidzee(fetcher, logger),
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
    new ExternalUrl(fetcher, logger), // fallback extractor which must come last
  ].filter(extractor => !disabledExtractors.includes(extractor.id));
};
