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
const MAX_SUBTITLES = 8; // Per movie/episode
const FETCH_TIMEOUT_MS = 9000;
const TOKEN_TTL = 12 * 60 * 1000; // 12 min (server-side tokens last 15 min)

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

// Convert OpenSubtitles SearchSubtitles data items to Stremio subtitle format
function parseSubtitles(items) {
  if (!Array.isArray(items) || items.length === 0) return [];

  // Group by language — keep only the highest-rated subtitle per language
  // (sorted by download count above). This gives the user one track per
  // language rather than 8 English tracks for a popular movie.
  const byLanguage = new Map();
  const sorted = items
    .filter(item => item && item.SubLanguageID && item.SubDownloadLink)
    .sort((a, b) => (parseInt(b.SubDownloadsCnt, 10) || 0) - (parseInt(a.SubDownloadsCnt, 10) || 0));

  for (const item of sorted) {
    const lang3 = String(item.SubLanguageID).toLowerCase();
    if (byLanguage.has(lang3)) continue; // already have one for this language
    const lang2 = ISO_639_2B_TO_1[lang3] || lang3;
    const langName = LANG_NAMES[lang3] || item.LanguageName || lang3;

    byLanguage.set(lang3, {
      id: lang2,
      url: item.SubDownloadLink, // gzipped .srt URL — Stremio decodes
      lang: langName,
    });

    if (byLanguage.size >= MAX_SUBTITLES) break;
  }

  const parsed = [...byLanguage.values()];

  // Sort by language priority (English first, etc.)
  parsed.sort((a, b) => {
    const aPriority = LANG_PRIORITY.indexOf(Object.keys(ISO_639_2B_TO_1).find(k => ISO_639_2B_TO_1[k] === a.id));
    const bPriority = LANG_PRIORITY.indexOf(Object.keys(ISO_639_2B_TO_1).find(k => ISO_639_2B_TO_1[k] === b.id));
    if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
    if (aPriority !== -1) return -1;
    if (bPriority !== -1) return 1;
    return 0;
  });

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
   * @returns {Promise<Array>} Array of { id, url, lang } — Stremio format
   */
  async fetchByTmdbId(fetcher, ctx, tmdbIdOrObj, type, season, episode) {
    if (!tmdbIdOrObj) return [];
    const mediaType = type === 'tv' || type === 'series' ? 'tv' : 'movie';

    // Normalize to TmdbId object
    const tmdbIdObj = typeof tmdbIdOrObj === 'object'
      ? tmdbIdOrObj
      : { id: parseInt(String(tmdbIdOrObj), 10), season, episode };
    const tmdbIdNum = tmdbIdObj.id;
    const s = tmdbIdObj.season || season;
    const e = tmdbIdObj.episode || episode;

    const cacheKey = `${tmdbIdNum}_${mediaType}_${s || 0}_${e || 0}`;

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

      // Step 3: SearchSubtitles by IMDB ID, one language at a time, in parallel.
      // We can't pass all languages in one query because OpenSubtitles returns
      // 50 most-popular subtitles sorted by download count — for popular movies
      // these are all English, so other languages are never returned. By
      // querying each language separately with limit=1, we guarantee one
      // subtitle per language.
      const langList = ALL_LANGUAGES.split(',');
      const results = await Promise.all(langList.map(async (lang3) => {
        try {
          const r = await xmlRpcCall('SearchSubtitles', [
            token,
            [{ imdbid: imdbNum, sublanguageid: lang3 }],
            { limit: 1 },
          ]);
          const data = r?.data;
          if (Array.isArray(data) && data.length > 0 && data[0].SubDownloadLink) {
            return { lang3, item: data[0] };
          }
        } catch { /* best-effort */ }
        return null;
      }));

      const validItems = results.filter(r => r !== null).map(r => r.item);
      if (process.env.DEBUG_SUBTITLES) {
        console.error(`[subtitles] got ${validItems.length} items from ${langList.length} lang queries`);
        if (validItems.length > 0) {
          console.error(`[subtitles] langs: ${validItems.map(i => i.SubLanguageID).join(',')}`);
        }
      }

      let subs_list = parseSubtitles(validItems);

      // For TV episodes, we may want to filter by season/episode, but
      // OpenSubtitles already matches by IMDB ID + season/episode when
      // we pass the show's IMDB ID. The SeriesSeason/SeriesEpisode
      // fields in the result confirm the match.
      if (mediaType === 'tv' && s && e) {
        subs_list = subs_list.filter(sub => {
          // Keep all subs — OpenSubtitles already filtered by episode
          return true;
        });
      }
      subs = subs_list;
    } catch (e) {
      // Silent failure — subtitles are best-effort
      // Invalidate token on auth error so next call re-logs in
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
