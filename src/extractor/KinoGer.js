// src/extractor/KinoGer.js
// Ported from research/webstreamr-mbg/src/extractor/KinoGer.ts

import crypto from 'node:crypto';
import { NotFoundError } from '../error/index.js';
import { Format } from '../types.js';
import { guessHeightFromPlaylist } from '../utils/index.js';
import { Extractor } from './Extractor.js';

/** @see https://github.com/Gujal00/ResolveURL/blob/master/script.module.resolveurl/lib/resolveurl/plugins/kinoger.py */
export class KinoGer extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'kinoger';
    this.label = 'KinoGer';
    this.ttl = 10800000; // 3h
  }

  supports(_ctx, url) {
    return [
      'asianembed.cam',
      'disneycdn.net',
      'dzo.vidplayer.live',
      'filedecrypt.link',
      'filma365.strp2p.site',
      'flimmer.rpmvip.com',
      'flixfilmesonline.strp2p.site',
      'kinoger.p2pplay.pro',
      'kinoger.re',
      'moflix.rpmplay.xyz',
      'moflix.upns.xyz',
      'player.upn.one',
      'securecdn.shop',
      'shiid4u.upn.one',
      'srbe84.vidplayer.live',
      'strp2p.site',
      't1.p2pplay.pro',
      'tuktuk.rpmvid.com',
      'ultrastream.online',
      'videoland.cfd',
      'videoshar.uns.bio',
      'w1tv.xyz',
      'wasuytm.store',
    ].includes(url.host);
  }

  normalize(url) {
    return new URL(`${url.origin}/api/v1/video?id=${url.hash.slice(1)}`);
  }

  async extractInternal(ctx, url, meta) {
    const headers = {
      'Origin': url.origin,
      'Referer': url.origin + '/',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    };

    const hexData = await this.fetcher.text(ctx, url, { headers });

    const encrypted = Buffer.from(hexData.slice(0, -1), 'hex');
    const key = Buffer.from('6b69656d7469656e6d75613931316361', 'hex');
    const iv = Buffer.from('313233343536373839306f6975797472', 'hex');
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);

    let decrypted = '';
    try {
      decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString();
    } catch {
      throw new NotFoundError();
    }

    let source;
    let title;
    try {
      const parsed = JSON.parse(decrypted);
      source = parsed.source;
      title = parsed.title;
    } catch {
      throw new NotFoundError();
    }

    const m3u8Url = new URL(source);

    return [
      {
        url: m3u8Url,
        format: Format.hls,
        meta: {
          ...meta,
          height: meta.height ?? await guessHeightFromPlaylist(ctx, this.fetcher, m3u8Url, { headers }),
          title,
        },
        requestHeaders: headers,
      },
    ];
  }
}
