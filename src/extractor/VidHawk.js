// src/extractor/VidHawk.js
// vidhawk.buzz — anime HLS embed provider with sub+dub multi-audio + subtitles
//
// Used by:
//   - Itachi source (itachi.tv) — wraps vidhawk.buzz/embed/ani/{alId}/{ep}/{sub|dub}
//
// Flow (verified live):
//   1. GET /api/stream/resolve?anilistId={alId}&episode={ep}&server={srv}&variant={sub|dub}&skipMapper=1&parentHost=itachi.tv
//      → returns { ticket, server, defaultAudio, servers: [...] }
//   2. GET /api/play?t={ticket}
//      → returns { tracks: [{id:"sub",src:"..."}, {id:"dub",src:"..."}], captions: {sub:[...], dub:[...]}, intro, outro }
//   3. The HLS stream URL on edge.vidhawk.buzz works WITHOUT Referer — public CDN
//      (Cloudflare CDN, plays directly in Stremio with Range support)
//
// Subtitles: VTT format on edge.vidhawk.buzz/sub.vtt?t=... — also public.
//
// This extractor is a fallback for direct vidhawk.buzz/embed URLs. The Itachi
// source normally resolves the HLS URLs itself (in-source) so the metadata
// (serverName, audioLabel, subtitles) is attached to each stream entry.
// If the Itachi source emits a raw embed URL (e.g. as a last-resort), this
// extractor claims it and resolves to the default audio's HLS.

import { Format } from '../types.js';
import { Extractor } from './Extractor.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const VIDHAWK_BASE = 'https://vidhawk.buzz';

async function gotGet(url, headers = {}) {
  const { gotScraping } = await import('got-scraping');
  return gotScraping.get(url, {
    headers: { 'User-Agent': UA, ...headers },
    timeout: { request: 12000 },
    throwHttpErrors: false,
    followRedirect: true,
  });
}

async function gotJson(url, headers = {}) {
  const res = await gotGet(url, headers);
  if (res.statusCode !== 200) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

function isVidHawk(url) {
  return url.hostname === 'vidhawk.buzz' || url.hostname === 'edge.vidhawk.buzz';
}

export class VidHawk extends Extractor {
  constructor(fetcher, logger) {
    super(fetcher, logger);
    this.id = 'vidhawk';
    this.label = 'VidHawk';
    this.ttl = 1800000; // 30min — tickets may expire
  }

  supports(_ctx, url) {
    return isVidHawk(url);
  }

  async extractInternal(ctx, url, meta) {
    // If the URL is already a direct HLS stream (edge.vidhawk.buzz/hls.m3u8?t=...),
    // pass it through directly — these are public CDN URLs that need no Referer.
    if (url.hostname === 'edge.vidhawk.buzz') {
      // Detect HLS vs subtitle
      const isHls = url.pathname.endsWith('.m3u8') || url.pathname.includes('.m3u8');
      const isVtt = url.pathname.endsWith('.vtt') || url.pathname.includes('.vtt');
      if (isHls) {
        return [{
          url,
          format: Format.hls,
          label: this.label,
          meta: { ...meta },
        }];
      }
      if (isVtt) {
        // Subtitle URL — shouldn't reach extractor, but pass through just in case
        return [];
      }
    }

    // Embed page (vidhawk.buzz/embed/ani/{alId}/{ep}/{sub|dub})
    // Parse anilistId + episode + variant from URL path
    // Path: /embed/ani/20/1/sub
    const m = url.pathname.match(/\/embed\/ani\/(\d+)\/(\d+)\/(sub|dub)/i);
    if (!m) return [];

    const anilistId = parseInt(m[1], 10);
    const episode = parseInt(m[2], 10);
    const variant = (m[3] || 'sub').toLowerCase();

    // Step 1: Resolve a ticket (use default server "kari")
    const resolveUrl = `${VIDHAWK_BASE}/api/stream/resolve?anilistId=${anilistId}&episode=${episode}&variant=${variant}&skipMapper=1&parentHost=itachi.tv`;
    const resolveData = await gotJson(resolveUrl, { Referer: `${VIDHAWK_BASE}/` });
    if (!resolveData?.ticket) return [];

    // Step 2: Fetch play data (tracks + captions)
    const playUrl = `${VIDHAWK_BASE}/api/play?t=${encodeURIComponent(resolveData.ticket)}`;
    const playData = await gotJson(playUrl, { Referer: `${VIDHAWK_BASE}/` });
    if (!playData?.tracks) return [];

    // Step 3: Build streams for each audio track
    const results = [];
    for (const track of playData.tracks) {
      if (!track?.src) continue;
      let trackUrl;
      try { trackUrl = new URL(track.src); } catch { continue; }

      // Find matching subtitle for this audio variant
      const captions = (playData.captions?.[track.id] || []).map(c => ({
        id: c.lang || c.label || track.id,
        url: c.src,
        lang: c.lang || 'en',
        label: c.label || 'English',
      })).filter(c => {
        try { new URL(c.url); return true; } catch { return false; }
      });

      const audioLabel = track.id === 'dub' ? 'DUB' : 'SUB';
      const countryCodes = track.id === 'dub'
        ? ['multi', 'en']
        : ['multi', 'ja'];

      results.push({
        url: trackUrl,
        format: Format.hls,
        label: this.label,
        meta: {
          ...meta,
          countryCodes,
          audioLabel,
          ...(captions.length > 0 && { subtitles: captions }),
        },
      });
    }

    return results;
  }
}
