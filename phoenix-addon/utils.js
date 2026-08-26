/**
 * PhoeniX Addon - Shared utility functions
 * ID parsing, quality detection, filename cleaning, URL validation.
 */

const logger = require('./logger');

/**
 * Parse the inbound Stremio ID into structured parts.
 * Supports:
 *   - tt1234567          (movie)
 *   - tt1234567:1:1      (series S01E01)
 *   - tt1234567:1        (series season - all episodes)
 */
function parseId(id) {
  if (!id || typeof id !== 'string') return null;
  const parts = id.split(':');
  const imdbId = parts[0];
  if (!/^tt\d+$/.test(imdbId)) return null;
  const out = {
    imdb: imdbId,
    season: parts[1] ? parseInt(parts[1], 10) : null,
    episode: parts[2] ? parseInt(parts[2], 10) : null,
    isSeries: parts.length > 1,
    raw: id,
  };
  return out;
}

/**
 * Detect common video file quality from a filename or label.
 */
function detectQuality(text = '') {
  const t = text.toLowerCase();
  if (/4k|2160p|uhd/.test(t)) return '4K';
  if (/1080p|fhd|1080/.test(t)) return '1080p';
  if (/720p|hd720|hdrip/.test(t)) return '720p';
  if (/480p|sd/.test(t)) return '480p';
  return 'HD';
}

/**
 * Detect the codec / container hint.
 */
function detectContainer(text = '') {
  const t = text.toLowerCase();
  if (t.endsWith('.mkv') || t.includes('mkv')) return 'MKV';
  if (t.endsWith('.mp4') || t.includes('mp4')) return 'MP4';
  if (t.includes('.m3u8') || t.includes('hls')) return 'HLS';
  if (t.includes('webm')) return 'WEBM';
  return '';
}

/**
 * Detect language hint from a filename or label.
 */
function detectLanguage(text = '') {
  const t = text.toLowerCase();
  const map = [
    ['dual', 'Dual'],
    ['hindi', 'Hindi'],
    ['tamil', 'Tamil'],
    ['telugu', 'Telugu'],
    ['malayalam', 'Malayalam'],
    ['kannada', 'Kannada'],
    ['bengali', 'Bengali'],
    ['chinese', 'Chinese'],
    ['mandarin', 'Mandarin'],
    ['cantonese', 'Cantonese'],
    ['japanese', 'Japanese'],
    ['korean', 'Korean'],
    ['spanish', 'Spanish'],
    ['french', 'French'],
    ['german', 'German'],
    ['italian', 'Italian'],
    ['russian', 'Russian'],
    ['arabic', 'Arabic'],
    ['english', 'English'],
  ];
  for (const [k, v] of map) {
    if (t.includes(k)) return v;
  }
  return '';
}

/**
 * Strict URL validator for direct playable streams.
 * Only HTTP(S) allowed - no magnet, no ipfs, no udp, no ftp.
 */
function isPlayableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (!u.hostname || u.hostname.length < 3) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Strip HTML tags from a string (cheap sanitizer).
 */
function stripHtml(html = '') {
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a Stremio-compliant stream object.
 * @param {Object} p
 * @param {string} p.sourceTag - e.g. "Streamex", "4KHDHub"
 * @param {string} p.title - file name / resolution / audio info
 * @param {string} p.url - direct playable URL
 * @param {string} [p.quality] - override detected quality
 */
function buildStream({ sourceTag, title, url, quality }) {
  if (!isPlayableUrl(url)) return null;
  const q = quality || detectQuality(title || url);
  const name = `${sourceTag}\n${q}`;
  return {
    name,
    title: title || `${sourceTag} Stream ${q}`,
    url,
  };
}

/**
 * Convert IMDB id into a numeric TMDB-ish query used by many sources.
 * Some sources accept the raw IMDB id; others want a title. This is a fallback
 * numeric helper that strips "tt" and parses an integer.
 */
function imdbNumeric(id) {
  if (!id) return null;
  return parseInt(String(id).replace(/^tt/, ''), 10);
}

/**
 * Tiny delay helper.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  parseId,
  detectQuality,
  detectContainer,
  detectLanguage,
  isPlayableUrl,
  stripHtml,
  buildStream,
  imdbNumeric,
  sleep,
};
