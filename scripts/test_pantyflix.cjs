/**
 * Pantyflix Scraper — 100% Pure Node.js (NO Playwright)
 * ======================================================
 * Pantyflix.org is a Next.js frontend that aggregates:
 *   - Embed players (vidnest.fun, vidlink.pro, vidfast.vc, etc.) for streaming
 *   - /api/streamrip/download for direct download links (Bollyflix, UHDMovies, etc.)
 *   - TMDB for all metadata
 *
 * This scraper provides BOTH:
 *   1. Download streams (via /api/streamrip/download) — direct MP4/MKV URLs
 *   2. Embed stream URLs (via vidnest.fun, vidlink.pro) — HLS players
 *
 * All streams include rich metadata: quality, size, server, source, audio language.
 *
 * Install: npm install axios
 * Usage:   node pantyflix_scraper.js movie 693134
 *          node pantyflix_scraper.js tv 90228 1 1
 */

'use strict';

const axios = require('axios');
const { execSync } = require('child_process');

const BASE = 'https://pantyflix.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Embed player servers (from PLAYBACK_SERVERS in the bundle)
const EMBED_SERVERS = [
  { id: 'vidnest',   name: 'VidNest',   domain: 'https://vidnest.fun' },
  { id: 'vidlink',   name: 'VidLink',   domain: 'https://vidlink.pro' },
  { id: 'vidfast',   name: 'VidFast',   domain: 'https://vidfast.vc' },
  { id: 'vidrock',   name: 'VidRock',   domain: 'https://vidrock.net' },
  { id: 'vidbolt',   name: 'VidBolt',   domain: 'https://vidbolt.xyz' },
  { id: 'vidsuper',  name: 'VidSuper',  domain: 'https://vidsuper.net' },
  { id: 'peachify',  name: 'Peachify',  domain: 'https://peachify.top' },
  { id: 'cinezo',    name: 'CineZo',    domain: 'https://player.cinezo.live' },
  { id: 'cinesrc',   name: 'CineSrc',   domain: 'https://cinesrc.st' },
  { id: 'vidvault',  name: 'VidVault',  domain: 'https://vidvault.ru' },
];

class PantyflixScraper {
  constructor() {
    this.client = axios.create({
      timeout: 12000,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': BASE + '/',
        'Origin': BASE,
      },
    });
  }

  /**
   * Resolve a fastdlserver URL to its direct playable URL.
   * Uses system curl (different TLS fingerprint than Node.js axios) to bypass
   * Cloudflare on gdflix.io.
   *
   * Chain: fastdlserver → gdflix.dev → new3.gdflix.io → /cflare/ → cloud-dl workers dev
   *
   * Returns the direct URL or null if resolution fails.
   */
  async _resolveFastDlServer(url) {
    try {
      // Use system curl to follow the full redirect chain (curl bypasses CF on gdflix.io)
      const html = execSync(
        `curl -sS -L --max-time 10 -A "${UA}" -H "Referer: ${BASE}/" "${url}"`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 12000 }
      );

      // Extract the /cflare/ link from the gdflix page
      const cflareMatch = html.match(/href="(\/cflare\/[^"]+)"/);
      if (!cflareMatch) {
        // Try direct cloud-dl URL (some pages have it directly)
        const directMatch = html.match(/https:\/\/cloud-dl[^"'\s<>]+/i);
        if (directMatch) return directMatch[0];
        return null;
      }

      // Fetch the cflare page to get the direct download URL
      const cflareUrl = `https://new3.gdflix.io${cflareMatch[1]}`;
      const html2 = execSync(
        `curl -sS -L --max-time 10 -A "${UA}" -H "Referer: https://new3.gdflix.io/" "${cflareUrl}"`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 12000 }
      );

      // Extract the cloud-dl workers.dev URL (direct MKV/MP4)
      const cloudDlMatch = html2.match(/https:\/\/cloud-dl[^"'\s<>]+/i);
      if (cloudDlMatch) return cloudDlMatch[0];

      // Also try busycdn URL (alternative direct download)
      const busyCdnMatch = html2.match(/https:\/\/instant\.busycdn\.xyz[^"'\s<>]+/i);
      if (busyCdnMatch) return busyCdnMatch[0];

      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get download links (direct MP4/MKV URLs) from /api/streamrip/download.
   * Resolves fastdlserver redirects to get direct playable URLs.
   * Returns array of streams with rich metadata.
   */
  async getDownloadStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
    const params = { type: mediaType, id: String(tmdbId) };
    if (mediaType === 'tv') {
      params.season = String(season || 1);
      params.episode = String(episode || 1);
    }

    const r = await this.client.get(`${BASE}/api/streamrip/download`, { params });
    const data = r.data;
    if (!data.ok || !data.downloads) return [];

    // Resolve all fastdlserver URLs in parallel
    const resolved = await Promise.all(
      data.downloads.map(async (d) => {
        let directUrl = d.url;

        // If it's a fastdlserver URL, resolve the redirect chain
        if (d.url.includes('fastdlserver')) {
          const resolved = await this._resolveFastDlServer(d.url);
          if (resolved) directUrl = resolved;
        }

        return {
          name: `Pantyflix\n${d.quality ? d.quality + 'p' : 'HD'} ${d.source || ''}`,
          title: data.title + (data.type === 'tv' && data.season ? ` S${data.season}E${data.episode}` : ''),
          url: directUrl,
          originalUrl: directUrl !== d.url ? d.url : null,
          quality: d.quality ? `${d.quality}p` : 'HD',
          behaviorHints: { notWebReady: true },
          meta: {
            provider: 'Pantyflix',
            source: d.source || d.server || 'Unknown',
            server: d.server || d.source || 'Unknown',
            quality: d.quality ? `${d.quality}p` : 'HD',
            size: d.size || null,
            type: 'mp4',
            audio: this._inferAudio(d.server || d.source || ''),
            language: this._inferLanguage(d.server || d.source || ''),
            tmdbId: tmdbId,
            mediaType: mediaType,
            season: data.season,
            episode: data.episode,
            resolved: directUrl !== d.url,
          },
        };
      })
    );

    return resolved;
  }

  /**
   * Get embed stream URLs from playback servers (vidnest, vidlink, etc.).
   * These are iframe URLs that contain HLS players.
   * Returns array of embed stream objects.
   */
  getEmbedStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
    const streams = [];
    for (const server of EMBED_SERVERS) {
      let url;
      if (mediaType === 'tv') {
        url = `${server.domain}/tv/${tmdbId}/${season || 1}/${episode || 1}`;
      } else {
        url = `${server.domain}/movie/${tmdbId}`;
      }

      // Add server-specific query params
      if (server.id === 'vidbolt') url += `?theme=00A8E1`;
      if (server.id === 'vidrock') url += `?autoplay=true&autonext=true`;
      if (server.id === 'vidlink') {
        const params = new URLSearchParams({
          primaryColor: '00A8E1',
          autoplay: 'true',
          nextbutton: mediaType === 'tv' ? 'true' : 'false',
        });
        url += `?${params}`;
      }

      streams.push({
        name: `Pantyflix\n${server.name}`,
        title: `${mediaType === 'tv' ? `S${season}E${episode}` : ''} ${server.name}`.trim(),
        url,
        quality: '1080p',
        behaviorHints: { notWebReady: true },
        meta: {
          provider: 'Pantyflix',
          source: server.name,
          server: server.name,
          quality: '1080p',
          size: null,
          type: 'hls',
          audio: 'multi',
          language: 'multi',
          tmdbId: tmdbId,
          mediaType: mediaType,
          season: season,
          episode: episode,
          embed: true,
        },
      });
    }
    return streams;
  }

  /**
   * Get ALL streams (downloads + embeds) for a movie or TV episode.
   */
  async getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
    const [downloads, embeds] = await Promise.all([
      this.getDownloadStreams(tmdbId, mediaType, season, episode).catch(() => []),
      Promise.resolve(this.getEmbedStreams(tmdbId, mediaType, season, episode)),
    ]);

    // Combine: downloads first (direct playable), then embeds
    const all = [...downloads, ...embeds];

    // Sort by quality (2160p first, then 1080p, etc.)
    const order = { '2160p': 0, '1080p': 1, '720p': 2, '480p': 3, '360p': 4, 'HD': 5 };
    all.sort((a, b) => (order[a.quality] ?? 9) - (order[b.quality] ?? 9));

    return all;
  }

  /** Infer audio language from server/source name. */
  _inferAudio(name) {
    const n = name.toLowerCase();
    if (n.includes('hindi') || n.includes('bolly')) return 'hindi-english';
    if (n.includes('english')) return 'english';
    if (n.includes('dual')) return 'multi';
    return 'unknown';
  }

  /** Infer language from server/source name. */
  _inferLanguage(name) {
    const n = name.toLowerCase();
    if (n.includes('hindi')) return ['hi', 'en'];
    if (n.includes('english')) return ['en'];
    if (n.includes('dual')) return ['en', 'hi'];
    return ['en'];
  }
}

// CLI
if (require.main === module) (async () => {
  const s = new PantyflixScraper();
  const mediaType = process.argv[2] || 'movie';
  const tmdbId = process.argv[3] || '693134';
  const season = mediaType === 'tv' ? parseInt(process.argv[4]) : null;
  const episode = mediaType === 'tv' ? parseInt(process.argv[5]) : null;

  console.log(`Pantyflix — ${mediaType} ${tmdbId}${season ? ' S'+season+'E'+episode : ''}`);
  const streams = await s.getStreams(tmdbId, mediaType, season, episode);

  console.log(`\n${streams.length} stream(s):\n`);
  for (const st of streams) {
    const m = st.meta;
    console.log(`  [${m.quality}] ${m.server} ${m.size || ''} ${m.type} audio=${m.audio}`);
    console.log(`    ${st.url.slice(0, 100)}...`);
    console.log();
  }

  // Verify playability of first 5 download streams (with Range header for partial content)
  console.log('=== Verifying playability ===');
  const downloadStreams = streams.filter(s => s.meta.type === 'mp4').slice(0, 5);
  for (const st of downloadStreams) {
    try {
      const r = await axios.get(st.url, {
        headers: { 'User-Agent': UA, Range: 'bytes=0-1024' },
        timeout: 8000, validateStatus: () => true, maxRedirects: 5,
        responseType: 'arraybuffer',
      });
      const ok = r.status === 200 || r.status === 206;
      const ct = r.headers['content-type'] || '';
      const size = st.meta.size || '';
      console.log(`  ${ok ? '✓' : '✗'} [${st.meta.quality}] ${st.meta.server} ${size}: HTTP ${r.status} ${ct} ${st.meta.resolved ? '(resolved)' : ''}`);
    } catch (e) {
      console.log(`  ✗ [${st.meta.quality}] ${st.meta.server}: ${e.message}`);
    }
  }
})();

module.exports = { PantyflixScraper };
