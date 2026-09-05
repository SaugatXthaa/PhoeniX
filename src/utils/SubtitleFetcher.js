// src/utils/SubtitleFetcher.js
// Universal subtitle fetcher — fetches subtitles for any movie/TV show
// by IMDB ID using the OpenSubtitles XML-RPC API.
//
// API: https://api.opensubtitles.org/xml-rpc
//   - LogIn (anonymous, no user/pass needed for read-only search)
//   - SearchSubtitles by IMDB ID + language
//
// This endpoint is publicly accessible (anonymous login allowed).
// Each subtitle entry has a `SubDownloadLink` pointing to a gzipped .srt
// file. Stremio can decode gzip + .srt natively when the URL is passed
// in the `subtitles` array of the stream object.
//
// Usage:
//   const subs = await SubtitleFetcher.fetchByImdbId(fetcher, ctx, tmdbIdObj, 1, 1);
//   // Returns: [{ id, url, lang }, ...]
//
// Cache:
//   Subtitles are cached by TMDB ID + season + episode for 6 hours.
//   The XML-RPC session token is cached for 15 minutes (1800s server-side).
//   A maximum of 8 languages are returned per movie/episode (top by
//   download count, prioritizing English).
//
// Failure modes:
//   - Network timeout → returns [] (no subtitles)
//   - HTTP error → returns []
//   - Invalid XML → returns []
//   - Empty result → returns []
//   The caller MUST treat the result as best-effort — never let subtitle
//   fetching break the stream pipeline.

import { getImdbIdFromTmdbId } from './tmdb.js';

const OPENSUBS_XMLRPC_URL = 'https://api.opensubtitles.org/xml-rpc';
const USER_AGENT = 'PhoeniXStremio v1.0';

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
// Max subtitles per movie/episode. Increased from 8 → 15 to provide broader
// multi-language coverage. Stremio's UI handles 15+ subtitle tracks fine —
// users get more language choices (English, Spanish, French, German, Italian,
// Portuguese, Russian, Dutch, Polish, Turkish, Arabic, Hindi, Chinese,
// Japanese, Korean) instead of being capped at 8.
const MAX_SUBTITLES = 15;
const FETCH_TIMEOUT_MS = 9000;
const TOKEN_TTL = 12 * 60 * 1000; // 12 min (server-side tokens last 15 min)

// Concurrency limit for OpenSubtitles API calls.
// OpenSubtitles anonymous rate limit: 5 req/s. We limit to 4 concurrent
// calls to stay safely under the limit even when multiple stream requests
// are in flight simultaneously.
const MAX_CONCURRENT_API_CALLS = 4;
let _activeApiCalls = 0;
const _apiCallQueue = [];

async function withRateLimit(fn) {
  if (_activeApiCalls >= MAX_CONCURRENT_API_CALLS) {
    await new Promise(resolve => _apiCallQueue.push(resolve));
  }
  _activeApiCalls++;
  try {
    return await fn();
  } finally {
    _activeApiCalls--;
    const next = _apiCallQueue.shift();
    if (next) next();
  }
}

const subtitleCache = new Map();
let _sessionToken = null;
let _sessionTokenTs = 0;

// Languages we request (priority order). OpenSubtitles uses ISO 639-2/B.
// We fetch all languages in ONE SearchSubtitles call (comma-separated),
// then sort by priority client-side. This minimizes API round-trips.
const ALL_LANGUAGES = 'eng,spa,fre,ger,ita,por,rus,dut,pol,tur,ara,hin,chi,jpn,kor,rum,bul,swe,nor,dan,fin,cze,gre,heb,hrv,hun,ind,srp,slo,slv,tha,ukr,vie';

// ISO 639-2/B → ISO 639-1 (for Stremio display)
const ISO_639_2B_TO_1 = {
  eng: 'en', spa: 'es', fre: 'fr', ger: 'de', ita: 'it', por: 'pt', rus: 'ru',
  dut: 'nl', pol: 'pl', tur: 'tr', ara: 'ar', hin: 'hi', chi: 'zh', jpn: 'ja', kor: 'ko',
  rum: 'ro', bul: 'bg', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', cze: 'cs', gre: 'el',
  heb: 'he', hrv: 'hr', hun: 'hu', ind: 'id', srp: 'sr', slo: 'sk', slv: 'sl',
  tha: 'th', ukr: 'uk', vie: 'vi',
};

// Full language names for Stremio display
const LANG_NAMES = {
  eng: 'English', spa: 'Spanish', fre: 'French', ger: 'German', ita: 'Italian',
  por: 'Portuguese', rus: 'Russian', dut: 'Dutch', pol: 'Polish', tur: 'Turkish',
  ara: 'Arabic', hin: 'Hindi', chi: 'Chinese', jpn: 'Japanese', kor: 'Korean',
  rum: 'Romanian', bul: 'Bulgarian', swe: 'Swedish', nor: 'Norwegian', dan: 'Danish',
  fin: 'Finnish', cze: 'Czech', gre: 'Greek', heb: 'Hebrew', hrv: 'Croatian',
  hun: 'Hungarian', ind: 'Indonesian', srp: 'Serbian', slo: 'Slovak', slv: 'Slovenian',
  tha: 'Thai', ukr: 'Ukrainian', vie: 'Vietnamese',
};

// Language priority — for sorting (English first, then Spanish, French, etc.)
const LANG_PRIORITY = ['eng', 'spa', 'fre', 'ger', 'ita', 'por', 'rus', 'dut', 'pol', 'tur', 'ara', 'hin', 'chi', 'jpn', 'kor'];

function evictExpired() {
  const now = Date.now();
  for (const [key, val] of subtitleCache) {
    if (now - val.ts > CACHE_TTL) subtitleCache.delete(key);
  }
  // Hard cap at 200 entries to prevent OOM
  if (subtitleCache.size > 200) {
    const entries = [...subtitleCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < 50; i++) subtitleCache.delete(entries[i][0]);
  }
}

// Build XML-RPC method call body
function buildXmlRpcCall(methodName, params) {
  let xml = '<?xml version="1.0"?><methodCall><methodName>' + methodName + '</methodName><params>';
  for (const p of params) {
    xml += '<param><value>' + xmlRpcValue(p) + '</value></param>';
  }
  xml += '</params></methodCall>';
  return xml;
}

function xmlRpcValue(v) {
  if (v === null || v === undefined) return '<string></string>';
  if (typeof v === 'string') {
    // XML-escape special chars
    return '<string>' + v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') + '</string>';
  }
  if (typeof v === 'number') return '<int>' + v + '</int>';
  if (typeof v === 'boolean') return '<boolean>' + (v ? 1 : 0) + '</boolean>';
  if (Array.isArray(v)) {
    let s = '<array><data>';
    for (const item of v) s += '<value>' + xmlRpcValue(item) + '</value>';
    return s + '</data></array>';
  }
  if (typeof v === 'object') {
    let s = '<struct>';
    for (const [k, val] of Object.entries(v)) {
      s += '<member><name>' + k + '</name><value>' + xmlRpcValue(val) + '</value></member>';
    }
    return s + '</struct>';
  }
  return '<string>' + String(v) + '</string>';
}

async function xmlRpcCall(methodName, params) {
  return withRateLimit(async () => {
    const body = buildXmlRpcCall(methodName, params);
    // Use got-scraping (Chrome TLS fingerprint) — OpenSubtitles is behind
    // Cloudflare and rejects native Node.js fetch with "Just a moment..."
    // challenge page. got-scraping's TLS fingerprint bypasses this.
    const { gotScraping } = await import('got-scraping');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await gotScraping.post(OPENSUBS_XMLRPC_URL, {
        headers: {
          'Content-Type': 'text/xml',
          'User-Agent': USER_AGENT,
          'Accept': 'text/xml',
        },
        body,
        timeout: { request: FETCH_TIMEOUT_MS },
        throwHttpErrors: false,
        http2: false,
      });
      if (res.statusCode !== 200) {
        throw new Error(`XML-RPC HTTP ${res.statusCode}`);
      }
      return parseXmlRpcResponse(res.body);
    } finally {
      clearTimeout(timer);
    }
  });
}

// Minimal XML-RPC response parser — extracts the single return value
// Supports: string, int, double, boolean, array, struct (nested arbitrarily)
//
// Uses a position-based recursive descent parser because nested structs
// (the response contains a struct with members whose values are themselves
// structs containing arrays of structs) break regex-based parsing.
function parseXmlRpcResponse(xml) {
  const valueStart = xml.indexOf('<params>');
  if (valueStart === -1) {
    const faultStart = xml.indexOf('<fault>');
    if (faultStart !== -1) {
      const v = parseValueAt(xml, xml.indexOf('<value>', faultStart) + 7);
      throw new Error('XML-RPC fault: ' + JSON.stringify(v.result));
    }
    throw new Error('Invalid XML-RPC response: no <params>');
  }
  // Find <value> inside <params><param>...<value>...</value></param></params>
  const innerValueStart = xml.indexOf('<value>', valueStart) + 7;
  const parsed = parseValueAt(xml, innerValueStart);
  return parsed.result;
}

// Recursive parser — returns { result, nextPos }
// startPos points to the character right after the opening `<value>` tag
// (i.e. the character after `<value>`).
//
// The returned nextPos points to the character right after `</value>`
// (the wrapping value close tag), so callers can immediately check for
// the next sibling tag (e.g. `</member>`, `</data>`, or another `<value>`).
function parseValueAt(xml, startPos) {
  // Skip whitespace
  let i = startPos;
  while (i < xml.length && /\s/.test(xml[i])) i++;

  // <string>...</string>
  if (xml.slice(i, i + 8) === '<string>') {
    const end = xml.indexOf('</string>', i + 8);
    if (end === -1) throw new Error('Unterminated <string>');
    // Skip past </string></value>
    const valueClose = xml.indexOf('</value>', end + 9);
    if (valueClose === -1) throw new Error('Unterminated <value> (string)');
    return { result: xmlDecode(xml.slice(i + 8, end)), nextPos: valueClose + 8 };
  }
  // <int>123</int> or <i4>123</i4>
  const intMatch = xml.slice(i).match(/^<(int|i4)>(-?\d+)<\/\1>/);
  if (intMatch) {
    const after = i + intMatch[0].length;
    const valueClose = xml.indexOf('</value>', after);
    return { result: parseInt(intMatch[2], 10), nextPos: valueClose + 8 };
  }
  // <double>1.5</double>
  const dblMatch = xml.slice(i).match(/^<double>(-?[\d.]+)<\/double>/);
  if (dblMatch) {
    const after = i + dblMatch[0].length;
    const valueClose = xml.indexOf('</value>', after);
    return { result: parseFloat(dblMatch[1]), nextPos: valueClose + 8 };
  }
  // <boolean>0|1</boolean>
  const boolMatch = xml.slice(i).match(/^<boolean>(0|1)<\/boolean>/);
  if (boolMatch) {
    const after = i + boolMatch[0].length;
    const valueClose = xml.indexOf('</value>', after);
    return { result: boolMatch[1] === '1', nextPos: valueClose + 8 };
  }
  // <array><data><value>...</value>...</data></array>
  // Note: `<array><data>` is 13 characters — slice(i, i + 13), not 12.
  if (xml.slice(i, i + 13) === '<array><data>') {
    let pos = i + 13;
    const items = [];
    // Skip whitespace
    while (pos < xml.length && /\s/.test(xml[pos])) pos++;
    // Parse <value>...</value> items until we hit </data>
    while (xml.slice(pos, pos + 7) === '<value>') {
      const inner = parseValueAt(xml, pos + 7);
      items.push(inner.result);
      pos = inner.nextPos;
      // Skip whitespace
      while (pos < xml.length && /\s/.test(xml[pos])) pos++;
    }
    // Find </data></array> and the wrapping </value>
    const dataClose = xml.indexOf('</data></array>', pos);
    if (dataClose === -1) throw new Error('Unterminated <array>');
    const afterArray = dataClose + 14;
    const valueClose = xml.indexOf('</value>', afterArray);
    if (valueClose === -1) throw new Error('Unterminated <value> (array)');
    return { result: items, nextPos: valueClose + 8 };
  }
  // <struct><member><name>k</name><value>v</value></member>...</struct>
  if (xml.slice(i, i + 8) === '<struct>') {
    let pos = i + 8;
    const obj = {};
    // Skip whitespace
    while (pos < xml.length && /\s/.test(xml[pos])) pos++;
    // Parse <member>...</member> until </struct>
    while (xml.slice(pos, pos + 8) === '<member>') {
      pos += 8;
      // Skip whitespace
      while (pos < xml.length && /\s/.test(xml[pos])) pos++;
      // Expect <name>...</name>
      if (xml.slice(pos, pos + 6) !== '<name>') {
        throw new Error('Expected <name> in <member>');
      }
      const nameEnd = xml.indexOf('</name>', pos + 6);
      if (nameEnd === -1) throw new Error('Unterminated <name>');
      const name = xmlDecode(xml.slice(pos + 6, nameEnd));
      pos = nameEnd + 7;
      // Skip whitespace
      while (pos < xml.length && /\s/.test(xml[pos])) pos++;
      // Expect <value>...</value>
      if (xml.slice(pos, pos + 7) !== '<value>') {
        throw new Error('Expected <value> after <name> in <member>');
      }
      const inner = parseValueAt(xml, pos + 7);
      obj[name] = inner.result;
      pos = inner.nextPos; // pos is now AFTER the wrapping </value>
      // Skip whitespace
      while (pos < xml.length && /\s/.test(xml[pos])) pos++;
      // Expect </member>
      if (xml.slice(pos, pos + 9) === '</member>') {
        pos += 9;
      } else {
        // Member close not found — bail out
        break;
      }
      // Skip whitespace before next <member>
      while (pos < xml.length && /\s/.test(xml[pos])) pos++;
    }
    // Expect </struct>
    if (xml.slice(pos, pos + 9) === '</struct>') {
      // Find the wrapping </value> after </struct>
      const valueClose = xml.indexOf('</value>', pos + 9);
      if (valueClose === -1) throw new Error('Unterminated <value> (struct)');
      return { result: obj, nextPos: valueClose + 8 };
    }
    throw new Error('Unterminated <struct>');
  }
  // Bare value (no wrapping tag) — treat as string up to next </value>
  const endValue = xml.indexOf('</value>', i);
  if (endValue === -1) throw new Error('Unterminated <value>');
  return { result: xmlDecode(xml.slice(i, endValue).trim()), nextPos: endValue + 8 };
}

function xmlDecode(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function getSessionToken() {
  // Reuse cached token if still fresh
  if (_sessionToken && Date.now() - _sessionTokenTs < TOKEN_TTL) {
    return _sessionToken;
  }
  // Log in anonymously — OpenSubtitles allows read-only search without credentials
  const result = await xmlRpcCall('LogIn', ['', '', 'en', USER_AGENT]);
  const token = result?.token;
  if (!token) {
    throw new Error('XML-RPC LogIn did not return a token');
  }
  _sessionToken = token;
  _sessionTokenTs = Date.now();
  return token;
}

// ─── Release name sanitization ───────────────────────────────────────
//
// Extract a usable release name from a filename or URL.
// Returns "" if the name doesn't look like a valid release (too short,
// hash-like, generic names like "index.m3u8", etc.)
//
// Valid release names look like:
//   "Inception.2010.1080p.BluRay.x264-SPARKS"
//   "Dune.Part.Two.2024.1080p.AMZN.WEB-DL.DUAL.DDP5.1.ESubs"
//   "Breaking.Bad.S01E01.1080p.BluRay.x264-REWARD"
//
// Invalid (returns ""): hash strings, "index.m3u8", "master.m3u8",
//   "video.mp4", random 32-char alphanumeric strings, etc.
function sanitizeReleaseName(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';

  // Strip query string and hash fragment
  let name = rawName.split('?')[0].split('#')[0];
  // URL-decode
  try { name = decodeURIComponent(name); } catch { /* keep as-is */ }
  // Strip protocol/host if it's a URL — keep only the filename
  name = name.split('/').pop() || name;
  // Strip file extension (.mkv, .mp4, .m3u8, etc.)
  name = name.replace(/\.(mkv|mp4|m4v|avi|mov|webm|m3u8|ts|m2ts|srt|vtt)$/i, '');
  // Trim whitespace
  name = name.trim();
  // Replace spaces with dots (OpenSubtitles uses dots as separators)
  // But only if the name contains dots already — otherwise keep spaces
  // (some release names use spaces: "Inception 2010 1080p BluRay")

  // Validate: must be at least 10 chars, at most 200 chars
  if (name.length < 10 || name.length > 200) return '';

  // Reject hash-like strings (all alphanumeric, no dots/spaces, >20 chars)
  // e.g. "ADGPM2IzbD60Hu_XUAZoxoFP" → not a release name
  if (/^[a-zA-Z0-9_-]{20,}$/.test(name) && !name.includes('.') && !name.includes(' ')) return '';

  // Reject generic names
  const generic = /^(index|master|playlist|video|movie|stream|play|file|download|uc|content|watch|embed)$/i;
  if (generic.test(name)) return '';

  // Require either a year (19xx/20xx) or quality marker (1080p/720p/4K/2160p)
  // to ensure this looks like a real release name and not random text
  const hasYear = /(19|20)\d{2}/.test(name);
  const hasQuality = /\b(4k|2160p|1440p|1080p|720p|480p|360p|webrip|web-dl|webdl|bluray|bdrip|brrip|dvdrip|hdrip|cam|tc|ts)\b/i.test(name);
  const hasSeasonEp = /S\d{1,2}E\d{1,2}/i.test(name);
  if (!hasYear && !hasQuality && !hasSeasonEp) return '';

  // Limit length to 100 chars for the cache key and query
  if (name.length > 100) name = name.slice(0, 100);

  return name;
}

// ─── Quality scoring for subtitle sync ───────────────────────────────
//
// The #1 cause of out-of-sync subtitles is FPS MISMATCH. A 25fps subtitle
// played against a 23.976fps video drifts ~4% — after 25 minutes it's a
// full minute off. The #2 cause is wrong release (different studio logos,
// intro length, extended cuts). The #3 cause is bad encoding (CP1252 chars
// show as garbage in UTF-8 players).
//
// We score each subtitle and pick the best one per language:
//   +100  MatchedBy = "moviehash"            (perfect file match)
//   +80   MatchedBy = "moviereleasename"      (release name match)
//   +50   MovieFPS = "23.976"                (NTSC film — most common)
//   +30   MovieFPS = "24.000"                (digital cinema)
//   +20   SubFromTrusted = "1"               (trusted uploader)
//   +15   SubRating >= 7.0                   (high user rating)
//   +10   SubEncoding = "UTF-8"              (no encoding issues)
//   +5    SubHearingImpaired = "0"           (clean, no [SOUND] tags)
//   +5    SubAutoTranslation = "0"           (human-translated)
//   -200  SubBad = "1"                       (reported broken — auto-reject)
//   -50   MovieFPS = "25.000"                (PAL — drifts on NTSC video)
//   -50   MovieFPS = "29.970"                (NTSC interlaced — drifts)
//   -30   SubAutoTranslation = "1"           (machine-translated)
//   -20   SubHearingImpaired = "1"           (has [SOUND] tags)
//   -10   SubForeignPartsOnly = "1"          (only foreign parts)
//
// Then sort by score DESC, then SubDownloadsCnt DESC (popularity tiebreak).
function scoreSubtitle(item) {
  if (!item) return -1000;

  let score = 0;

  // Auto-reject bad subtitles
  if (String(item.SubBad || '0') === '1') return -1000;

  // Match quality (most important for sync)
  const matchedBy = String(item.MatchedBy || '').toLowerCase();
  if (matchedBy === 'moviehash') score += 100;
  else if (matchedBy === 'moviereleasename') score += 80;
  else if (matchedBy === 'imdbid') score += 10;
  else if (matchedBy === 'tag') score += 5;

  // FPS matching — CRITICAL for sync
  // 23.976 is the standard for modern movies/TV (NTSC film rate).
  // 24.000 is digital cinema.
  // 25.000 is PAL (European TV) — drifts ~4% on NTSC video.
  // 29.970 is NTSC interlaced — drifts on progressive video.
  const fps = String(item.MovieFPS || '').trim();
  if (fps === '23.976' || fps === '23.98' || fps === '23.976024') score += 50;
  else if (fps === '24.000' || fps === '24') score += 30;
  else if (fps === '25.000' || fps === '25') score -= 50; // PAL drifts
  else if (fps === '29.970' || fps === '30') score -= 50; // interlaced drifts
  // Unknown FPS — neutral (don't penalize, might be fine)

  // Trusted uploader
  if (String(item.SubFromTrusted || '0') === '1') score += 20;

  // User rating
  const rating = parseFloat(item.SubRating || '0');
  if (rating >= 7.0) score += 15;
  else if (rating >= 5.0) score += 5;
  else if (rating > 0 && rating < 3.0) score -= 10;

  // Encoding — UTF-8 is preferred (Stremio expects UTF-8)
  const encoding = String(item.SubEncoding || '').toUpperCase();
  if (encoding === 'UTF-8' || encoding === 'UTF8') score += 10;
  else if (encoding === 'ASCII') score += 5; // ASCII is UTF-8 safe
  else if (encoding.includes('1252') || encoding.includes('CP1252')) score -= 5; // might show wrong chars
  else if (encoding && encoding !== '') score -= 10; // unknown encoding

  // Hearing impaired — prefer non-HI (cleaner, no [SOUND] tags)
  if (String(item.SubHearingImpaired || '0') === '0') score += 5;
  else score -= 20; // HI subtitles have distracting [SOUND] tags

  // Auto-translation — prefer human-translated
  if (String(item.SubAutoTranslation || '0') === '0') score += 5;
  else score -= 30; // machine translation is often wrong

  // Foreign parts only — usually not what users want
  if (String(item.SubForeignPartsOnly || '0') === '1') score -= 10;

  return score;
}

// Convert OpenSubtitles SearchSubtitles data items to Stremio subtitle format.
// Picks the BEST subtitle per language using quality scoring (see scoreSubtitle).
//
// LANGUAGE PRIORITY: English is always included first (it's the most-requested
// language for Stremio users). Then Spanish, French, German, etc. We pick the
// top MAX_SUBTITLES languages by priority, and for each language, the
// highest-scored subtitle. This ensures English is never accidentally cut
// when other languages happen to have higher scores.
function parseSubtitles(items) {
  if (!Array.isArray(items) || items.length === 0) return [];

  // Step 1: Score every item
  const scored = items
    .filter(item => item && item.SubLanguageID && item.SubDownloadLink)
    .map(item => ({ item, score: scoreSubtitle(item) }))
    .filter(s => s.score > -500); // reject SubBad and very low-scored

  // Step 2: Group by language — for each language, keep only the BEST subtitle
  const byLanguage = new Map();
  for (const { item, score } of scored) {
    const lang3 = String(item.SubLanguageID).toLowerCase();
    const existing = byLanguage.get(lang3);
    if (!existing || score > existing.score) {
      byLanguage.set(lang3, { item, score });
    }
  }

  // Step 3: Convert to array and sort by LANGUAGE PRIORITY (English first,
  // then Spanish, French, German, etc.). Within each language, the best-
  // scored subtitle is already selected.
  const langEntries = [...byLanguage.values()].map(({ item, score }) => {
    const lang3 = String(item.SubLanguageID).toLowerCase();
    const lang2 = ISO_639_2B_TO_1[lang3] || lang3;
    const langName = LANG_NAMES[lang3] || item.LanguageName || lang3;
    const priority = LANG_PRIORITY.indexOf(lang3);
    return {
      id: lang2,
      url: item.SubDownloadLink,
      lang: langName,
      score,
      priority: priority !== -1 ? priority : 999, // unknown languages sort last
    };
  });

  // Sort: priority languages first (English=0, Spanish=1, ...), then by
  // score DESC as a tiebreaker, then alphabetically by language name
  langEntries.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (b.score !== a.score) return b.score - a.score;
    return a.lang.localeCompare(b.lang);
  });

  // Step 4: Limit to MAX_SUBTITLES — this preserves language priority
  // (English is always included if available)
  const parsed = langEntries.slice(0, MAX_SUBTITLES).map(({ id, url, lang }) => ({
    id, url, lang,
  }));

  return parsed;
}

export const SubtitleFetcher = {
  /**
   * Fetch subtitles by TMDB ID + type + (optional) season/episode.
   * Internally resolves IMDB ID via TMDB API, then queries OpenSubtitles.
   *
   * @param {Object} fetcher - PhoeniX Fetcher instance (for TMDB API access)
   * @param {Object} ctx     - Request context (for fetcher.json)
   * @param {number|string|object} tmdbIdOrObj - TMDB ID (numeric) or TmdbId object {id, season, episode}
   * @param {string} type   - 'movie' or 'tv' / 'series'
   * @param {number} [season] - TV season (1-indexed)
   * @param {number} [episode] - TV episode (1-indexed)
   * @param {string} [releaseName] - Optional release name for better sync matching
   *                                  (e.g. "Inception.2010.1080p.BluRay.x264-SPARKS").
   *                                  When provided, OpenSubtitles matches by
   *                                  MovieReleaseName → perfect sync.
   * @returns {Promise<Array>} Array of { id, url, lang } — Stremio format
   */
  async fetchByTmdbId(fetcher, ctx, tmdbIdOrObj, type, season, episode, releaseName) {
    if (!tmdbIdOrObj) return [];
    const mediaType = type === 'tv' || type === 'series' ? 'tv' : 'movie';

    // Normalize to TmdbId object
    const tmdbIdObj = typeof tmdbIdOrObj === 'object'
      ? tmdbIdOrObj
      : { id: parseInt(String(tmdbIdOrObj), 10), season, episode };
    const tmdbIdNum = tmdbIdObj.id;
    const s = tmdbIdObj.season || season;
    const e = tmdbIdObj.episode || episode;

    // Clean release name — strip file extension, query string, hashes
    const cleanRelease = releaseName ? sanitizeReleaseName(releaseName) : '';

    // Cache key includes release name so different releases get different subs
    const cacheKey = `${tmdbIdNum}_${mediaType}_${s || 0}_${e || 0}${cleanRelease ? '_' + cleanRelease : ''}`;

    evictExpired();
    const cached = subtitleCache.get(cacheKey);
    if (cached) return cached.subs;

    let subs = [];
    try {
      // Step 1: Resolve IMDB ID via TMDB
      const imdbIdObj = await getImdbIdFromTmdbId(fetcher, ctx, tmdbIdObj);
      const imdbIdStr = imdbIdObj?.id;
      if (!imdbIdStr || !/^tt(\d+)$/.test(imdbIdStr)) {
        subtitleCache.set(cacheKey, { subs: [], ts: Date.now() });
        return [];
      }
      // Strip "tt" prefix for OpenSubtitles search
      const imdbNum = imdbIdStr.replace(/^tt/, '');

      // Step 2: Get session token (cached)
      const token = await getSessionToken();

      // Step 3: Search OpenSubtitles
      //
      // Two strategies depending on whether we have a release name:
      //
      // A) WITH release name:
      //    Single query: imdbid + sublanguageid(all) + moviereleasename
      //    OpenSubtitles returns only subtitles matching the release name →
      //    MatchedBy = "moviereleasename" → PERFECT SYNC.
      //    One call instead of 8, because the release filter narrows results
      //    enough that we don't need per-language queries.
      //
      // B) WITHOUT release name:
      //    Per-language queries: imdbid + sublanguageid(single) + limit=1
      //    8 parallel calls. This is the fallback — less accurate sync but
      //    still works. Quality scoring (FPS, encoding, rating) picks the
      //    best subtitle from the IMDB-matched pool.
      let validItems = [];

      if (cleanRelease) {
        // Strategy A: release-name matching (BEST SYNC)
        try {
          const r = await xmlRpcCall('SearchSubtitles', [
            token,
            [{
              imdbid: imdbNum,
              sublanguageid: ALL_LANGUAGES,
              moviereleasename: cleanRelease,
            }],
            { limit: 100 },
          ]);
          const data = r?.data;
          if (Array.isArray(data) && data.length > 0) {
            validItems = data;
            if (process.env.DEBUG_SUBTITLES) {
              console.error(`[subtitles] release "${cleanRelease.slice(0, 40)}" matched ${data.length} items`);
            }
          }
        } catch { /* fall through to IMDB-only */ }
      }

      // If release-name matching returned nothing (or no release name was
      // provided), fall back to per-language IMDB-only queries.
      if (validItems.length === 0) {
        const langList = ALL_LANGUAGES.split(',');
        const results = await Promise.all(langList.map(async (lang3) => {
          try {
            const r = await xmlRpcCall('SearchSubtitles', [
              token,
              [{ imdbid: imdbNum, sublanguageid: lang3 }],
              { limit: 5 },
            ]);
            const data = r?.data;
            if (Array.isArray(data) && data.length > 0) {
              return data; // return ALL items (not just data[0]) so we can score them
            }
          } catch { /* best-effort */ }
          return [];
        }));
        validItems = results.flat();
        if (process.env.DEBUG_SUBTITLES) {
          console.error(`[subtitles] IMDB-only fallback got ${validItems.length} items from ${langList.length} lang queries`);
        }
      }

      // Score and pick best per language
      subs = parseSubtitles(validItems);
    } catch (e) {
      // Silent failure — subtitles are best-effort
      if (process.env.DEBUG_SUBTITLES) {
        console.error(`[subtitles] fetch error: ${e?.message || e}`);
      }
      if (String(e?.message || '').includes('401') || String(e?.message || '').includes('406')) {
        _sessionToken = null;
      }
      subs = [];
    }

    subtitleCache.set(cacheKey, { subs, ts: Date.now() });
    return subs;
  },

  /**
   * Clear the subtitle cache. Used by /debug endpoints for testing.
   */
  clearCache() {
    subtitleCache.clear();
    _sessionToken = null;
  },

  /**
   * Get cache stats for debugging.
   */
  getCacheStats() {
    return {
      size: subtitleCache.size,
      hasToken: !!_sessionToken,
      tokenAgeMs: _sessionToken ? Date.now() - _sessionTokenTs : 0,
    };
  },
};
