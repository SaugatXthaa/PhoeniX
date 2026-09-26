// src/utils/formatter.cjs
//
// Task 98 — STREAM NAME / DESCRIPTION TEMPLATE ENGINE (configure UI's
// "Custom formatter"). Task 100 — AIOStreams-compatible grammar.
//
// Template syntax (superset of the original Task 98 grammar, aligned with the
// AIOStreams community formatter so its shared templates render identically):
//
//   {stream.resolution}                        → value or ""
//   {'text'::upper}                            → quoted literal operand
//   {field::modifier1::modifier2}              → modifier chain
//   {field::exists["A"||"B"]}                  → conditional branches
//   {field["A"||"B"||"C"]}                     → boolean field; 3rd = absent
//   {a::exists::and::b::exists["A"||"B"]}      → and/or/xor condition chains
//   {?literal {field} more?}                   → optional group: renders only
//                                                when EVERY field inside is
//                                                present (not just non-empty
//                                                output)
//   {tools.newLine} / {tools.removeLine}       → layout directives (sentinels;
//                                                a removeLine line is dropped
//                                                from the finished text)
//   {addon.name} {config.addonName}            → addon identity
//   {metadata.*} {user.*} {service.*}          → request/config/service data
//
// COMPARATORS (return booleans; chainable with and/or/xor):
//   exists, istrue, isfalse, in('a','b'), =X, >X, >=X, <X, <=X,
//   $X (starts with), ^X (ends with), ~X (contains)
//
// MODIFIERS: upper, lower, title, trim, smallcaps, subscript, superscript,
//   translate('a','b'), replace('a','b'), remove(...), keep(...), truncate(n),
//   date('pattern'), length, reverse, base64, default('x'), string,
//   bytes/bytes10/bytes2/sbytes/rbytes/..., bitrate family, time('pattern'),
//   star/pstar, hex/octal/binary/comma, join('sep'), unique, slice, first,
//   last, random, sort/rsort/lsort, languageCode, languageEmoji, where(...),
//   pluck('f'), each("template") (object lists only)
//
// FIELDS: full registry below. A field with no data renders "" for modifiers
//   and "absent" for conditionals/branches — templates degrade gracefully.
//
// SAFETY: a template can only produce strings for the card's name/title.
// Render is length-capped (clean line-boundary cut), exception-guarded, and
// any unresolved token / engine error marker in the output falls back to the
// card's original text — a broken custom template can never crash /stream or
// put junk on a card.

const NEW_LINE_SENTINEL = '\u0011';
const REMOVE_LINE_SENTINEL = '\u0012';
const SENTINEL_PATTERN = /[\u0011\u0012]/g;
const MAX_RENDER_LENGTH = 8000;
const MAX_TEMPLATE_DEPTH = 5;
const MAX_EACH_RENDERS = 256;

const hasSentinel = (text) =>
  typeof text === 'string' && (text.includes(NEW_LINE_SENTINEL) || text.includes(REMOVE_LINE_SENTINEL));
const sanitise = (text) =>
  hasSentinel(text)
    ? text.split(NEW_LINE_SENTINEL).join('').split(REMOVE_LINE_SENTINEL).join('')
    : text;
const substituteTools = (text) =>
  String(text)
    .replaceAll('{tools.newLine}', NEW_LINE_SENTINEL)
    .replaceAll('{tools.removeLine}', REMOVE_LINE_SENTINEL);

// Post-pass: drop lines carrying a removeLine directive, then expand newLine
// sentinels into real newlines. Values can never forge these — they are
// stripped from stream data as it enters the render.
function applyTools(out) {
  if (!out || !hasSentinel(out)) return out;
  const lines = out.split('\n');
  const kept = lines.filter((line) => !line.includes(REMOVE_LINE_SENTINEL));
  return kept.join('\n').split(NEW_LINE_SENTINEL).join('\n');
}

// ── field registry (case-insensitive lookup; unknown fields stay literal) ──
const FIELD_REGISTRY = {
  config: ['addonName'],
  stream: [
    'filename', 'folderName', 'size', 'bitrate', 'folderSize', 'library',
    'quality', 'resolution', 'subbed', 'dubbed', 'languages',
    'mediaInfoQuality', 'uLanguages', 'subtitles', 'uSubtitles',
    'languageEmojis', 'uLanguageEmojis', 'subtitleEmojis', 'uSubtitleEmojis',
    'languageCodes', 'uLanguageCodes', 'subtitleCodes', 'uSubtitleCodes',
    'smallLanguageCodes', 'uSmallLanguageCodes', 'smallSubtitleCodes',
    'uSmallSubtitleCodes', 'visualTags', 'audioTags', 'audioTracks',
    'subtitleTracks', 'releaseGroup', 'regexMatched', 'rankedRegexMatched',
    'regexScore', 'nRegexScore', 'encode', 'audioChannels', 'edition',
    'editions', 'remastered', 'regraded', 'repack', 'proper', 'uncensored',
    'unrated', 'upscaled', 'hasChapters', 'network', 'site', 'container',
    'extension', 'indexer', 'year', 'title', 'country', 'episodeTitle',
    'date', 'folderSeasons', 'formattedFolderSeasons', 'seasons', 'season',
    'formattedSeasons', 'episodes', 'episode', 'formattedEpisodes',
    'folderEpisodes', 'formattedFolderEpisodes', 'seasonEpisode',
    'seasonPack', 'seeders', 'private', 'freeleech', 'age', 'ageHours',
    'duration', 'infoHash', 'type', 'message', 'proxied', 'seadex',
    'seadexBest', 'seScore', 'nSeScore', 'seMatched', 'rseMatched',
    'preloading', 'idMatched',
    // addon-specific extensions (kept for existing user templates):
    'provider', 'fullTitle', 'source', 'server', 'sizeReadable',
  ],
  metadata: [
    'queryType', 'type', 'isAnime', 'title', 'titles', 'year', 'yearEnd',
    'runtime', 'episodeRuntime', 'genres', 'originalLanguage', 'country',
    'season', 'episode', 'absoluteEpisode', 'relativeAbsoluteEpisode',
    'episodeTitle', 'episodeTitles', 'latestSeason', 'daysSinceRelease',
    'daysSinceFirstAired', 'daysSinceLastAired', 'hasNextEpisode',
    'daysUntilNextEpisode', 'anilistId', 'malId', 'hasSeaDex',
  ],
  user: [
    'languages', 'subtitles', 'resolutions', 'qualities', 'visualTags',
    'audioTags', 'audioChannels', 'encodes', 'streamTypes', 'releaseGroups',
    'keywords',
  ],
  track: [
    'lang', 'codec', 'tag', 'channels', 'title', 'default', 'forced',
    'commentary', 'dub', 'original', 'hearingImpaired', 'visualImpaired',
  ],
  service: ['id', 'shortName', 'name', 'cached'],
  addon: ['name', 'presetId', 'manifestUrl'],
  debug: ['json', 'jsonf'],
};

const CANONICAL_FIELDS = new Map(
  Object.entries(FIELD_REGISTRY).flatMap(([section, properties]) =>
    properties.map((property) => [
      `${section}.${property}`.toLowerCase(),
      [section, property],
    ])
  )
);
const canonicaliseField = (section, property) =>
  CANONICAL_FIELDS.get(`${section}.${property}`.toLowerCase());

// ── languages: code → display name / emoji (mirrors src/utils/language.js) ──
const LANGUAGE_MAP = {
  multi: ['Multi', '🌐'], sq: ['Albanian', '🇦🇱'], ar: ['Arabic', '🇸🇦'],
  bg: ['Bulgarian', '🇧🇬'], bn: ['Bengali', '🇧🇩'], cs: ['Czech', '🇨🇿'],
  da: ['Danish', '🇩🇰'], de: ['German', '🇩🇪'], el: ['Greek', '🇬🇷'],
  en: ['English', '🇺🇸'], es: ['Spanish', '🇪🇸'], et: ['Estonian', '🇪🇪'],
  fa: ['Persian', '🇮🇷'], fi: ['Finnish', '🇫🇮'], fr: ['French', '🇫🇷'],
  gu: ['Gujarati', '🇮🇳'], he: ['Hebrew', '🇮🇱'], hi: ['Hindi', '🇮🇳'],
  hr: ['Croatian', '🇭🇷'], hu: ['Hungarian', '🇭🇺'], id: ['Indonesian', '🇮🇩'],
  it: ['Italian', '🇮🇹'], ja: ['Japanese', '🇯🇵'], kn: ['Kannada', '🇮🇳'],
  ko: ['Korean', '🇰🇷'], lt: ['Lithuanian', '🇱🇹'], lv: ['Latvian', '🇱🇻'],
  ml: ['Malayalam', '🇮🇳'], mr: ['Marathi', '🇮🇳'], nl: ['Dutch', '🇳🇱'],
  no: ['Norwegian', '🇳🇴'], pa: ['Punjabi', '🇮🇳'], pl: ['Polish', '🇵🇱'],
  pt: ['Portuguese', '🇧🇷'], ro: ['Romanian', '🇷🇴'], ru: ['Russian', '🇷🇺'],
  sk: ['Slovak', '🇸🇰'], sl: ['Slovenian', '🇸🇮'], sr: ['Serbian', '🇷🇸'],
  sv: ['Swedish', '🇸🇪'], ta: ['Tamil', '🇮🇳'], te: ['Telugu', '🇮🇳'],
  th: ['Thai', '🇹🇭'], tr: ['Turkish', '🇹🇷'], uk: ['Ukrainian', '🇺🇦'],
  ur: ['Urdu', '🇵🇰'], vi: ['Vietnamese', '🇻🇳'], zh: ['Chinese', '🇨🇳'],
};

const regionalFlag = (code) => {
  const up = code.toUpperCase();
  return /^[A-Z]{2}$/.test(up)
    ? String.fromCodePoint(...[...up].map((c) => 0x1f1a5 + c.charCodeAt(0)))
    : '';
};

const normaliseLangCode = (code) => {
  const lower = String(code).toLowerCase().trim();
  const aliases = { fre: 'fr', ger: 'de', cze: 'cs', rum: 'ro', dut: 'nl', gre: 'el', chi: 'zh', may: 'ms', tib: 'bo', wel: 'cy' };
  const base = aliases[lower] ?? lower;
  return base.split('-')[0];
};

const languageName = (value) => {
  const code = normaliseLangCode(value);
  if (LANGUAGE_MAP[code]) return LANGUAGE_MAP[code][0];
  const byName = Object.values(LANGUAGE_MAP).find(([n]) => n.toLowerCase() === String(value).toLowerCase().trim());
  return byName ? byName[0] : String(value).toUpperCase();
};

const languageCode = (value) => {
  const code = normaliseLangCode(value);
  if (LANGUAGE_MAP[code]) return code.toUpperCase();
  const byName = Object.entries(LANGUAGE_MAP).find(([, [n]]) => n.toLowerCase() === String(value).toLowerCase().trim());
  return byName ? byName[0].toUpperCase() : String(value).toUpperCase();
};

const languageEmoji = (value) => {
  const code = normaliseLangCode(value);
  if (LANGUAGE_MAP[code]) return LANGUAGE_MAP[code][1];
  const byName = Object.entries(LANGUAGE_MAP).find(([, [n]]) => n.toLowerCase() === String(value).toLowerCase().trim());
  return byName ? byName[1][1] || byName[1] : regionalFlag(code);
};

// ── formatting helpers (byte/bitrate/duration/date/star/smallcaps) ──
function formatBytes(bytes, k, round = false) {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B';
  const sizes = k === 1024 ? ['B', 'KiB', 'MiB', 'GiB', 'TiB'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  let value = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
  if (round) value = Math.round(value);
  return `${value} ${sizes[i]}`;
}

function formatSmartBytes(bytes, k) {
  if (!Number.isFinite(bytes) || bytes === 0) return '0 B';
  const sizes = k === 1024 ? ['B', 'KiB', 'MiB', 'GiB', 'TiB'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const rawValue = bytes / Math.pow(k, i);
  const integerPart = Math.floor(rawValue);
  let formattedValue;
  if (integerPart >= 100) formattedValue = String(Math.round(rawValue));
  else if (integerPart >= 10) formattedValue = rawValue % 1 === 0 ? rawValue.toFixed(0) : rawValue.toFixed(1);
  else formattedValue = String(parseFloat(rawValue.toFixed(2)));
  return `${formattedValue} ${sizes[i]}`;
}

function formatBitrate(bitrate, round = false) {
  if (!Number.isFinite(bitrate) || bitrate <= 0) return '0 bps';
  const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(bitrate) / Math.log(1000))));
  let value = bitrate / Math.pow(1000, i);
  value = round ? Math.round(value) : parseFloat(value.toFixed(2));
  return `${value} ${sizes[i]}`;
}

function formatSmartBitrate(bitrate) {
  if (!Number.isFinite(bitrate) || bitrate <= 0) return '0 bps';
  const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
  const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(bitrate) / Math.log(1000))));
  const rawValue = bitrate / Math.pow(1000, i);
  const integerPart = Math.floor(rawValue);
  let formattedValue;
  if (integerPart >= 100) formattedValue = String(Math.round(rawValue));
  else if (integerPart >= 10) formattedValue = rawValue % 1 === 0 ? rawValue.toFixed(0) : rawValue.toFixed(1);
  else formattedValue = String(parseFloat(rawValue.toFixed(2)));
  return `${formattedValue} ${sizes[i]}`;
}

function formatDuration(durationInMs) {
  const seconds = Math.floor(durationInMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h:${minutes % 60}m:${seconds % 60}s`;
  if (seconds % 60 > 0) return `${minutes % 60}m:${seconds % 60}s`;
  return `${minutes % 60}m`;
}

// %token pattern renderer shared by date + duration patterns.
// [ ... ] marks an optional group dropped when every token inside is zero.
function renderPattern(pattern, resolve) {
  const stack = [{ text: '', zero: true, sawToken: false }];
  const closeGroup = () => {
    const group = stack.pop();
    const parent = stack[stack.length - 1];
    if (!group.sawToken || !group.zero) {
      parent.text += group.text;
      parent.sawToken = parent.sawToken || group.sawToken;
      if (!group.zero) parent.zero = false;
    }
  };
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const top = stack[stack.length - 1];
    if (char === '%') {
      const next = pattern[i + 1];
      if (next === undefined) { top.text += '%'; break; }
      if (next === '%' || next === '[' || next === ']') { top.text += next; i += 1; continue; }
      const token = next === '-' ? pattern.slice(i + 1, i + 3) : next;
      const resolved = resolve(token);
      if (resolved === undefined) top.text += `%${token}`;
      else {
        top.text += resolved.text;
        top.sawToken = true;
        if (!resolved.zero) top.zero = false;
      }
      i += token.length;
      continue;
    }
    if (char === '[') { stack.push({ text: '', zero: true, sawToken: false }); continue; }
    if (char === ']' && stack.length > 1) { closeGroup(); continue; }
    top.text += char;
  }
  while (stack.length > 1) closeGroup();
  return stack[0].text;
}

const DURATION_UNITS = ['H', 'M', 'S'];
const normaliseDuration = (duration) => {
  if (!Number.isFinite(duration) || duration < 0) return 0;
  return duration < 1000 ? duration * 60 * 1000 : duration;
};

function formatDurationPattern(durationInMs, pattern) {
  const units = new Set();
  renderPattern(pattern, (token) => {
    const unit = token.startsWith('-') ? token.slice(1) : token;
    if (!DURATION_UNITS.includes(unit)) return undefined;
    units.add(unit);
    return { text: '' };
  });
  const totalSeconds = Math.max(0, Math.floor(durationInMs / 1000));
  const totalMinutes = Math.floor(totalSeconds / 60);
  const values = {
    H: Math.floor(totalSeconds / 3600),
    M: units.has('H') ? totalMinutes % 60 : totalMinutes,
    S: units.has('H') || units.has('M') ? totalSeconds % 60 : totalSeconds,
  };
  return renderPattern(pattern, (token) => {
    const padded = !token.startsWith('-');
    const value = values[padded ? token : token.slice(1)];
    if (value === undefined) return undefined;
    return { text: padded ? String(value).padStart(2, '0') : String(value), zero: value === 0 };
  });
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ordinalise = (day) => {
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
};

function formatDatePattern(value, pattern) {
  const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(value).trim());
  if (!parts) return value;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])];
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return value;
  const tokens = {
    Y: String(year),
    y: String(year % 100).padStart(2, '0'),
    m: String(month + 1).padStart(2, '0'),
    '-m': String(month + 1),
    d: String(day).padStart(2, '0'),
    '-d': String(day),
    o: ordinalise(day),
    B: MONTH_NAMES[month],
    b: MONTH_NAMES[month].slice(0, 3),
    A: DAY_NAMES[date.getUTCDay()],
    a: DAY_NAMES[date.getUTCDay()].slice(0, 3),
  };
  return renderPattern(pattern, (token) => (tokens[token] !== undefined ? { text: tokens[token] } : undefined));
}

const SMALL_CAPS_MAP = { A: 'ᴀ', B: 'ʙ', C: 'ᴄ', D: 'ᴅ', E: 'ᴇ', F: 'ғ', G: 'ɢ', H: 'ʜ', I: 'ɪ', J: 'ᴊ', K: 'ᴋ', L: 'ʟ', M: 'ᴍ', N: 'ɴ', O: 'ᴏ', P: 'ᴘ', Q: 'ǫ', R: 'ʀ', S: 'ꜱ', T: 'ᴛ', U: 'ᴜ', V: 'ᴠ', W: 'ᴡ', X: 'x', Y: 'ʏ', Z: 'ᴢ' };
const makeSmall = (code) => String(code).split('').map((char) => SMALL_CAPS_MAP[char.toUpperCase()] || char).join('');

const stars = (padWithEmpty) => (value) => {
  const FULL = '★';
  const HALF = '⯪';
  const EMPTY = '☆';
  const full = Math.floor(value / 20);
  const half = value % 20 >= 10 ? 1 : 0;
  return FULL.repeat(full) + HALF.repeat(half) + (padWithEmpty ? EMPTY.repeat(5 - full - half) : '');
};

// ═══════════════════════════════ parser ═══════════════════════════════════
// Grammar:
//   template  := (text | group | tool | expression)*
//   group     := '{?' template '?}'                     (nested groups OK)
//   tool      := '{tools.newLine}' | '{tools.removeLine}'
//   expression:= '{' ws operand ('::' cmp '::' operand)* ws check? ws '}'
//   operand   := quoted-literal modifiers? | section.property modifiers?
//   cmp       := and | or | xor | neq | equal | left | right
//   check     := '[' '"'yes'"' '||' '"'no'"' ('||' '"'absent'"')? ']'
// Never throws: unparseable spans degrade to literal text (and clearly
// expression-shaped junk emits an invalid_expression marker the fail-open
// guard turns into the card's original text).

const COMPARATORS = ['and', 'or', 'xor', 'neq', 'equal', 'left', 'right'];
const isIdentChar = (c) => /[A-Za-z0-9_]/.test(c);

function parseOperand(src, pos) {
  // quoted literal stands in for a field
  let literal;
  let path;
  let p = pos;
  if (src[p] === "'" || src[p] === '"') {
    const quote = src[p];
    p += 1;
    const from = p;
    while (p < src.length && src[p] !== quote) p += 1;
    if (p >= src.length) return undefined;
    literal = src.slice(from, p);
    p += 1;
    pos = p;
  } else {
    const start = p;
    while (p < src.length && isIdentChar(src[p])) p += 1;
    const section = src.slice(start, p);
    if (!section || src[p] !== '.') return undefined;
    p += 1;
    const propStart = p;
    while (p < src.length && isIdentChar(src[p])) p += 1;
    const property = src.slice(propStart, p);
    if (!property) return undefined;
    const canonical = canonicaliseField(section, property);
    // an unknown property is not an expression at all → stays literal
    if (!canonical) return undefined;
    path = `${canonical[0]}.${canonical[1]}`;
    pos = p;
  }

  const modifiers = [];
  for (;;) {
    const q = skipWs(src, pos);
    if (!src.startsWith('::', q)) break;
    const save = q;
    const after = q + 2;
    // a comparator (and/or/…) ends this operand rather than extending it
    if (COMPARATORS.some((c) => src.startsWith(`${c}::`, after))) { break; }
    const mod = parseModifier(src, skipWs(src, after));
    if (mod === undefined) { pos = save; break; }
    modifiers.push(mod.source);
    pos = mod.end;
  }
  return { path, literal, modifiers, end: pos };
}

// name or name(args…). Modifier names are known (case-insensitive):
//   call modifiers   — `name(…)` with quote/paren-aware argument scanning
//   prefix operators — `=x` `>0` `>=x` `<x` `<=x` `$x` `^x` `~x` + ident check
//   plain modifiers  — bare known names with a boundary check
function parseModifier(src, pos) {
  const start = pos;
  for (const name of CALL_MODIFIER_NAMES) {
    const head = src.slice(pos, pos + name.length + 1);
    if (head.toLowerCase() !== `${name}(`) continue;
    let p = pos + name.length + 1;
    let depth = 1;
    let inStr = null;
    while (p < src.length && depth > 0) {
      const c = src[p];
      if (inStr) {
        if (c === '\\' && src[p + 1] === inStr) { p += 2; continue; }
        if (c === inStr) inStr = null;
      } else if (c === '"' || c === "'") inStr = c;
      else if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      p += 1;
    }
    if (depth !== 0) return undefined;
    return { source: src.slice(start, p), end: p };
  }
  for (const operator of PREFIX_OPERATORS_PARSE) {
    if (!src.startsWith(operator, pos)) continue;
    let p = pos + operator.length;
    while (p < src.length && isIdentChar(src[p])) p += 1;
    if (p === pos + operator.length) return undefined; // operator with no check value
    return { source: src.slice(start, p), end: p };
  }
  {
    let p = pos;
    while (p < src.length && isIdentChar(src[p])) p += 1;
    const name = src.slice(pos, p).toLowerCase();
    if (!name || !PLAIN_MODIFIER_NAMES.has(name)) return undefined;
    return { source: src.slice(start, p), end: p };
  }
}

// `["yes"||"no"]` — brace depth tracked so nested conditionals' quotes don't
// close the branch; \" escapes are honoured.
function parseCheck(src, pos) {
  const start = pos;
  if (src[pos] !== '[') return undefined;
  pos += 1;
  const branch = () => {
    if (src[pos] !== '"') return undefined;
    pos += 1;
    let text = '';
    let depth = 0;
    while (pos < src.length) {
      const c = src[pos];
      if (c === '\\' && src[pos + 1] === '"') { text += '"'; pos += 2; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') depth = Math.max(0, depth - 1);
      else if (c === '"' && depth === 0) { pos += 1; return text; }
      text += c;
      pos += 1;
    }
    return undefined;
  };
  const yes = branch();
  if (yes === undefined) return undefined;
  if (!src.startsWith('||', pos)) return undefined;
  pos += 2;
  const no = branch();
  if (no === undefined) return undefined;
  let absent;
  if (src.startsWith('||', pos)) {
    pos += 2;
    absent = branch();
    if (absent === undefined) return undefined;
  }
  if (src[pos] !== ']') return undefined;
  pos += 1;
  return { yes, no, absent, end: pos, start };
}

const skipWs = (src, pos) => { while (pos < src.length && /\s/.test(src[pos])) pos += 1; return pos; };
const skipWsBack = (src, pos) => { while (pos > 0 && /\s/.test(src[pos - 1])) pos -= 1; return pos; };

function parseExpression(src, pos) {
  const start = pos;
  if (src[pos] !== '{') return undefined;
  let p = skipWs(src, pos + 1);
  const first = parseOperand(src, p);
  if (!first) return undefined;
  p = first.end;
  const operands = [first];
  const comparators = [];
  for (;;) {
    const q = skipWs(src, p);
    if (!src.startsWith('::', q)) break;
    const after = q + 2;
    const cmp = COMPARATORS.find((c) => src.startsWith(`${c}::`, after));
    if (!cmp) break;
    const np = after + cmp.length + 2;
    const next = parseOperand(src, skipWs(src, np));
    if (!next) return undefined;
    comparators.push(cmp);
    operands.push(next);
    p = next.end;
  }
  let check;
  const beforeCheck = skipWsBack(src, p);
  if (src[beforeCheck] === '[') {
    check = parseCheck(src, beforeCheck);
    if (check) p = check.end;
  }
  p = skipWs(src, p);
  if (src[p] !== '}') return undefined;
  return {
    kind: 'expression',
    path: first.path,
    literal: first.literal,
    modifiers: first.modifiers,
    extraOperands: operands.slice(1).map((o) => ({ path: o.path, literal: o.literal, modifiers: o.modifiers })),
    comparators,
    check,
    end: p + 1,
    start,
  };
}

function parseGroupBody(src, pos) {
  if (!src.startsWith('{?', pos)) return undefined;
  const from = pos + 2;
  let p = from;
  let depth = 1;
  while (p < src.length) {
    if (src.startsWith('{?', p)) { depth += 1; p += 2; continue; }
    if (src.startsWith('?}', p)) {
      depth -= 1;
      if (depth === 0) return { body: src.slice(from, p), end: p + 2 };
      p += 2;
      continue;
    }
    p += 1;
  }
  return undefined;
}

function parseTool(src, pos) {
  const lower = src.slice(pos, pos + 18).toLowerCase();
  if (lower.startsWith('{tools.newline}')) return { kind: 'tool', tool: 'newLine', end: pos + 15 };
  if (lower.startsWith('{tools.removeline}')) return { kind: 'tool', tool: 'removeLine', end: pos + 18 };
  return undefined;
}

// text nodes: literal backslash-n becomes a real newline at render time
function parseTemplate(src) {
  const nodes = [];
  let i = 0;
  let text = '';
  const flush = () => { if (text) { nodes.push({ kind: 'text', text }); text = ''; } };
  while (i < src.length) {
    if (src[i] !== '{') { text += src[i]; i += 1; continue; }
    if (src.startsWith('{?', i)) {
      const group = parseGroupBody(src, i);
      if (group !== undefined) {
        flush();
        nodes.push({ kind: 'group', nodes: parseTemplate(group.body), start: i, end: group.end });
        i = group.end;
        continue;
      }
    }
    const tool = parseTool(src, i);
    if (tool) { flush(); nodes.push(tool); i = tool.end; continue; }
    const expr = parseExpression(src, i);
    if (expr) { flush(); nodes.push(expr); i = expr.end; continue; }
    // not an expression: "{prose" stays prose; clearly expression-shaped junk
    // (e.g. "{stream." with a broken tail) emits an engine-error marker so the
    // fail-open guard can ship the card's original text instead of junk
    const closing = src.indexOf('}', i);
    const inner = closing === -1 ? src.slice(i + 1) : src.slice(i + 1, closing);
    if (!inner.includes('{') && /^\s*(?:stream|addon|service|metadata|user|config|debug|tools)\./i.test(inner)) {
      flush();
      nodes.push({ kind: 'text', text: `{invalid_expression(${inner.trim()})}` });
      i = closing === -1 ? src.length : closing + 1;
      continue;
    }
    text += src[i];
    i += 1;
  }
  flush();
  return nodes;
}

// ═══════════════════════ modifier compilation ══════════════════════════════
const DIGITS = '0123456789+-=()';
const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎';
const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾';

function mapChars(value, from, to) {
  const table = new Map();
  const source = [...from];
  const target = [...to];
  for (let i = 0; i < source.length && i < target.length; i++) table.set(source[i], target[i]);
  return [...value].map((c) => table.get(c) ?? c).join('');
}

const isPresent = (value) => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return /\S/.test(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

const isObjectList = (value) => Array.isArray(value) && typeof value[0] === 'object' && value[0] !== null;
const isReplaceable = (value) => typeof value === 'string' || (Array.isArray(value) && !isObjectList(value));

// replaceAll bounded by MAX_RENDER_LENGTH (a modifier can multiply its input)
function boundedReplaceAll(value, search, replacement) {
  if (!search) return value;
  const growth = replacement.length - search.length;
  const worstCase = growth <= 0 ? value.length : value.length + Math.floor(value.length / search.length) * growth;
  if (worstCase <= MAX_RENDER_LENGTH) return value.split(search).join(replacement);
  let out = '';
  let from = 0;
  while (out.length < MAX_RENDER_LENGTH) {
    const at = value.indexOf(search, from);
    if (at === -1) { out += value.slice(from); break; }
    out += value.slice(from, at) + replacement;
    from = at + search.length;
  }
  return out.length > MAX_RENDER_LENGTH ? out.slice(0, MAX_RENDER_LENGTH) : out;
}

function replaceIn(value, search, replacement) {
  if (typeof value === 'string') return boundedReplaceAll(value, search, replacement);
  const target = search.toLowerCase();
  return value.map((item) => (String(item).toLowerCase() === target ? replacement : item));
}

const quotedArguments = (inner) => {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'/g;
  let m;
  while ((m = pattern.exec(inner)) !== null) args.push(m[1] ?? m[2] ?? '');
  return args;
};

const referenceArguments = (inner) => {
  const withoutQuoted = inner.replace(/"[^"]*"|'[^']*'/g, '');
  const found = new Set();
  const pattern = /\{\s*([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
  let m;
  while ((m = pattern.exec(withoutQuoted)) !== null) found.add(m[1]);
  return [...found];
};

const unquote = (arg) => {
  const q = arg ? arg[0] : undefined;
  return arg && arg.length >= 2 && (q === "'" || q === '"') && arg.endsWith(q) ? arg.slice(1, -1) : undefined;
};

// object-list filter for ::where('cond', …) — cond: field, field=a|b,
// field~a|b, !cond; case-insensitive
function compileObjectFilter(conditions) {
  const parsed = conditions.map((raw) => {
    let cond = raw;
    let negate = false;
    if (cond.startsWith('!')) { negate = true; cond = cond.slice(1); }
    const contains = /^([^~]+)~(.*)$/.exec(cond);
    const equals = /^([^=]+)=(.*)$/.exec(cond);
    if (contains) return { negate, field: contains[1], op: '~', values: contains[2].split('|').map((v) => v.toLowerCase()) };
    if (equals) return { negate, field: equals[1], op: '=', values: equals[2].split('|').map((v) => v.toLowerCase()) };
    return { negate, field: cond, op: 'set' };
  });
  return (item, resolveValues) => {
    const result = parsed.every(({ negate, field, op, values }) => {
      let val = item?.[field];
      if (op === 'set') {
        let ok = isPresent(val);
        if (!ok && resolveValues) {
          const extra = resolveValues(field);
          ok = Array.isArray(extra) && extra.length > 0;
        }
        return negate ? !ok : ok;
      }
      if (val === undefined || val === null) return false;
      const list = Array.isArray(val) ? val.map((v) => String(v).toLowerCase()) : [String(val).toLowerCase()];
      const hit = values.some((v) => (op === '~' ? list.some((item2) => item2.includes(v)) : list.includes(v)));
      return negate ? !hit : hit;
    });
    return result;
  };
}

// ── conditional modifiers (return booleans) ────────────────────────────────
const CONDITIONAL_EXACT = {
  istrue: (value) => value === true,
  isfalse: (value) => value === false,
  exists: isPresent,
};
const PREFIX_OPERATORS = ['>=', '<=', '>', '<', '$', '^', '~', '=']; // longest first
const PREFIX_OPS = {
  $: (v, c) => (typeof v === 'string' ? v.startsWith(c) : v?.[0] === c),
  '^': (v, c) => (typeof v === 'string' ? v.endsWith(c) : v?.[v.length - 1] === c),
  '~': (v, c) => v.includes(c),
  '=': (v, c) => v === c,
  '>=': (v, c) => v >= c,
  '>': (v, c) => v > c,
  '<=': (v, c) => v <= c,
  '<': (v, c) => v < c,
};

function compileConditional(lower) {
  const isExact = Object.prototype.hasOwnProperty.call(CONDITIONAL_EXACT, lower);
  const operator = !isExact ? PREFIX_OPERATORS.find((op) => lower.startsWith(op)) : undefined;
  if (!isExact && !operator) return undefined;
  const rawCheck = operator ? lower.slice(operator.length) : '';
  const arrayCapable = operator ? ['$', '^', '~'].includes(operator) : false;
  return (value) => {
    try {
      if (!isPresent(value)) return false; // absent values are false
      if (isExact) return CONDITIONAL_EXACT[lower](value);
      if (isObjectList(value)) return undefined;
      const arrayValue = Array.isArray(value) && value.every((i) => typeof i === 'string')
        ? value.map((i) => i.toLowerCase())
        : undefined;
      const stringValue = String(value).toLowerCase();
      const check = /\s/.test(stringValue) ? rawCheck : rawCheck.replace(/\s/g, '');
      const numericValue = Number(stringValue.replace(/,\s/g, ''));
      const numericCheck = Number(check.replace(/,\s/g, ''));
      const numericCapable = ['<', '<=', '>', '>=', '='].includes(operator);
      const numeric = numericCapable && !isNaN(numericValue) && !isNaN(numericCheck);
      return PREFIX_OPS[operator](
        numeric ? numericValue : ((arrayCapable ? arrayValue : undefined) ?? stringValue),
        numeric ? numericCheck : check
      );
    } catch {
      return false;
    }
  };
}

// ── plain (argument-free) modifiers, dispatched by runtime type ────────────
const sortBy = (ascending) => (value) => [...value].sort((a, b) => {
  const result = typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b), undefined, { numeric: true });
  return ascending ? result : -result;
});
const arrayGetOrDefault = (value, index) => (value.length > 0 ? String(value[index]) : '');
const mapLanguages = (value, convert) => [...new Set(value.map((i) => convert(String(i))).filter(Boolean))];

const STRING_MODIFIERS = {
  upper: (v) => v.toUpperCase(),
  lower: (v) => v.toLowerCase(),
  trim: (v) => v.trim(),
  title: (v) => v.split(' ').map((w) => w.toLowerCase()).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
  length: (v) => v.length.toString(),
  reverse: (v) => v.split('').reverse().join(''),
  base64: (v) => Buffer.from(v, 'utf8').toString('base64'),
  string: (v) => v,
  smallcaps: (v) => makeSmall(v),
  subscript: (v) => mapChars(v, DIGITS, SUBSCRIPT_DIGITS),
  superscript: (v) => mapChars(v, DIGITS, SUPERSCRIPT_DIGITS),
  languagecode: (v) => languageCode(v),
  languageemoji: (v) => languageEmoji(v),
};
const NUMBER_MODIFIERS = {
  comma: (v) => v.toLocaleString(),
  hex: (v) => v.toString(16),
  octal: (v) => v.toString(8),
  binary: (v) => v.toString(2),
  bytes: (v) => formatBytes(v, 1000),
  sbytes: (v) => formatSmartBytes(v, 1000),
  sbytes10: (v) => formatSmartBytes(v, 1000),
  sbytes2: (v) => formatSmartBytes(v, 1024),
  rbytes: (v) => formatBytes(v, 1000, true),
  bytes10: (v) => formatBytes(v, 1000),
  rbytes10: (v) => formatBytes(v, 1000, true),
  bytes2: (v) => formatBytes(v, 1024),
  rbytes2: (v) => formatBytes(v, 1024, true),
  bitrate: (v) => formatBitrate(v),
  rbitrate: (v) => formatBitrate(v, true),
  sbitrate: (v) => formatSmartBitrate(v),
  string: (v) => v.toString(),
  time: (v) => formatDuration(normaliseDuration(v)),
  star: stars(false),
  pstar: stars(true),
};
const ARRAY_MODIFIERS = {
  join: (v) => v.join(', '),
  length: (v) => v.length.toString(),
  first: (v) => arrayGetOrDefault(v, 0),
  last: (v) => arrayGetOrDefault(v, v.length - 1),
  random: (v) => arrayGetOrDefault(v, Math.floor(Math.random() * v.length)),
  sort: sortBy(true),
  rsort: sortBy(false),
  lsort: (v) => [...v].sort(),
  reverse: (v) => [...v].reverse(),
  unique: (v) => {
    const seen = new Set();
    return v.filter((item) => {
      const key = String(item).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
  languagecode: (v) => mapLanguages(v, languageCode),
  languageemoji: (v) => mapLanguages(v, languageEmoji),
  string: (v) => v.toString(),
};
const BOOLEAN_MODIFIERS = { string: (v) => String(v) };
const OBJECT_LIST_MODIFIERS = new Set(['length', 'reverse']);

function compilePlain(lower) {
  return (value) => {
    if (typeof value === 'string') return STRING_MODIFIERS[lower]?.(value);
    if (Array.isArray(value)) {
      if (isObjectList(value) && !OBJECT_LIST_MODIFIERS.has(lower)) return undefined;
      return ARRAY_MODIFIERS[lower]?.(value);
    }
    if (typeof value === 'number') return NUMBER_MODIFIERS[lower]?.(value);
    if (typeof value === 'boolean') return BOOLEAN_MODIFIERS[lower]?.(value);
    return undefined;
  };
}

// ── parameterised modifiers ────────────────────────────────────────────────
function compileParameterised(source, lower) {
  const open = source.indexOf('(');
  if (open === -1 || !source.endsWith(')')) return undefined;
  const name = lower.slice(0, open);
  const inner = source.slice(open + 1, -1);

  switch (name) {
    case 'replace': {
      // {section.prop} search form: replace('{user.x}','y')
      const variableForm = /^\s*\{([^}]+)\}\s*,\s*(['"])([\s\S]*)\2\s*$/.exec(inner);
      if (variableForm) {
        const [, variablePath, , rawReplacement] = variableForm;
        const replacementText = substituteTools(rawReplacement);
        return (value, parseValue, ctx) => {
          if (!isReplaceable(value)) return undefined;
          const resolved = ctx.resolveVariable(variablePath, parseValue);
          return resolved ? replaceIn(value, resolved, replacementText) : value;
        };
      }
      const openQuote = source.charAt('replace('.length);
      const closeQuote = source.charAt(source.length - 2);
      const body = source.slice('replace('.length + 1, -2);
      const parts = body.split(new RegExp(`${openQuote}\\s*,\\s*${closeQuote}`));
      const [rawSearch, replacement, extra] = parts;
      if (extra !== undefined || !rawSearch || replacement === undefined) {
        return (value) => (isReplaceable(value) ? value : undefined);
      }
      const variableKey = rawSearch.startsWith('{') && rawSearch.endsWith('}') ? rawSearch.slice(1, -1) : undefined;
      const replacementText = substituteTools(replacement);
      return (value, parseValue, ctx) => {
        if (!isReplaceable(value)) return undefined;
        if (!variableKey) return replaceIn(value, rawSearch, replacementText);
        const resolved = ctx.resolveVariable(variableKey, parseValue);
        if (!resolved) return value;
        return replaceIn(value, resolved, replacementText);
      };
    }
    case 'remove':
    case 'keep': {
      const args = quotedArguments(inner);
      const references = referenceArguments(inner);
      if (args.length === 0 && references.length === 0) return () => undefined;
      const targets = args.filter(Boolean);
      const loweredSet = new Set(targets.map((t) => t.toLowerCase()));
      const keeping = name === 'keep';
      return (value, parseValue, ctx) => {
        if (typeof value === 'string') {
          if (keeping) return undefined; // keeping part of a string has no meaning
          const removals = [...targets];
          for (const ref of references) {
            for (const v of ctx.resolveValues(ref, parseValue) ?? []) removals.push(v);
          }
          let result = value;
          for (const target of removals) result = result.split(target).join('');
          return result;
        }
        if (Array.isArray(value) && !isObjectList(value)) {
          const set = new Set(loweredSet);
          for (const ref of references) {
            for (const v of ctx.resolveValues(ref, parseValue) ?? []) set.add(v.toLowerCase());
          }
          return value.filter((item) => set.has(String(item).toLowerCase()) === keeping);
        }
        return undefined;
      };
    }
    case 'join': {
      const raw = unquote(inner);
      if (raw === undefined) return undefined;
      const separator = substituteTools(raw);
      return (value) => (Array.isArray(value) && !isObjectList(value) ? value.join(separator) : undefined);
    }
    case 'where': {
      let filter;
      try { filter = compileObjectFilter(quotedArguments(inner)); } catch { return () => undefined; }
      return (value, parseValue, ctx) =>
        Array.isArray(value) && (!value.length || isObjectList(value))
          ? value.filter((item) => filter(item, (path) => ctx.resolveValues(path, parseValue)))
          : undefined;
    }
    case 'pluck': {
      const key = unquote(inner);
      if (key === undefined) return undefined;
      return (value) => {
        if (!Array.isArray(value)) return undefined;
        if (value.length && !isObjectList(value)) return undefined;
        const found = new Set();
        for (const item of value) {
          const field = item?.[key];
          if (typeof field === 'string' && field) found.add(sanitise(field));
        }
        return [...found];
      };
    }
    case 'each': {
      const tm = /^each\(\s*"([\s\S]*)"\s*\)$/.exec(source);
      if (!tm) return undefined;
      const innerNodes = parseTemplate(tm[1]);
      return (value, parseValue, ctx) => {
        if (!Array.isArray(value)) return undefined;
        if (value.length && !isObjectList(value)) return undefined;
        const out = [];
        let renders = 0;
        for (const item of value) {
          if (renders >= MAX_EACH_RENDERS) break;
          renders += 1;
          const text = renderNodes(innerNodes, { ...parseValue, track: item }, 1, ctx, true);
          if (/\S/.test(text)) out.push(text);
        }
        return out;
      };
    }
    case 'truncate': {
      const limit = parseInt(inner, 10);
      if (isNaN(limit) || limit < 0) return undefined;
      return (value) => {
        if (typeof value !== 'string') return undefined;
        const graphemes = [...new Intl.Segmenter().segment(value)];
        if (graphemes.length <= limit) return value;
        return graphemes.slice(0, limit).map((s) => s.segment).join('').replace(/\s+$/, '') + '…';
      };
    }
    case 'slice': {
      const parts = inner.split(',').map((p) => parseInt(p.trim(), 10));
      if (isNaN(parts[0])) return undefined;
      const end = parts.length > 1 && !isNaN(parts[1]) ? parts[1] : undefined;
      return (value) => (Array.isArray(value) ? value.slice(parts[0], end) : undefined);
    }
    case 'default': {
      const fallback = unquote(inner);
      if (fallback === undefined) return undefined;
      return (value) => (isPresent(value) ? value : fallback);
    }
    case 'trim': {
      const chars = unquote(inner);
      if (chars === undefined) return undefined;
      const strip = new Set(chars);
      return (value) => {
        if (typeof value !== 'string') return undefined;
        const points = [...value];
        let start = 0;
        let end = points.length;
        while (start < end && strip.has(points[start])) start += 1;
        while (end > start && strip.has(points[end - 1])) end -= 1;
        return points.slice(start, end).join('');
      };
    }
    case 'translate': {
      const [from, to] = quotedArguments(inner);
      if (from === undefined || to === undefined) return undefined;
      return (value) => (typeof value === 'string' ? mapChars(value, from, to) : undefined);
    }
    case 'in': {
      const options = quotedArguments(inner).map((o) => o.toLowerCase());
      const references = referenceArguments(inner);
      if (options.length === 0 && references.length === 0) return undefined;
      const literalSet = new Set(options);
      return (value, parseValue, ctx) => {
        if (value === null || value === undefined) return false;
        if (isObjectList(value)) return undefined;
        const set = new Set(literalSet);
        for (const ref of references) {
          for (const v of ctx.resolveValues(ref, parseValue) ?? []) set.add(v.toLowerCase());
        }
        if (Array.isArray(value)) {
          return value.some((item) => typeof item === 'string' && set.has(item.toLowerCase()));
        }
        return set.has(String(value).toLowerCase());
      };
    }
    case 'time': {
      const pattern = unquote(inner);
      if (pattern === undefined) return undefined;
      return (value) => (typeof value === 'number' ? formatDurationPattern(normaliseDuration(value), pattern) : undefined);
    }
    case 'date': {
      const pattern = unquote(inner);
      if (pattern === undefined) return undefined;
      return (value) => (typeof value === 'string' ? formatDatePattern(value, pattern) : undefined);
    }
    default:
      return undefined;
  }
}

// Order matters: conditionals first (::exists, ::>5 apply to every type).
function compileModifier(source) {
  const lower = source.toLowerCase();
  return compileConditional(lower) ?? compileParameterised(source, lower) ?? compilePlain(lower);
}

// Known modifier names for the parser (case-insensitive). Conditional
// modifiers (exists/istrue/isfalse) are argument-free, so they parse as plain
// names and dispatch through compileConditional at render time.
const PLAIN_MODIFIER_NAMES = new Set([
  ...Object.keys(STRING_MODIFIERS),
  ...Object.keys(NUMBER_MODIFIERS),
  ...Object.keys(ARRAY_MODIFIERS),
  ...Object.keys(BOOLEAN_MODIFIERS),
  ...Object.keys(CONDITIONAL_EXACT),
]);
const CALL_MODIFIER_NAMES = ['default', 'trim', 'translate', 'replace', 'remove', 'keep', 'join', 'where', 'pluck', 'each', 'truncate', 'slice', 'in', 'time', 'date'];
const PREFIX_OPERATORS_PARSE = ['>=', '<=', '>', '<', '$', '^', '~', '='];

// ═══════════════════════════════ renderer ═════════════════════════════════
// A render error (unknown modifier on a present value, non-boolean check
// operand, …) throws EngineError; formatStream turns that into the card's
// original text — junk never reaches a card.

class EngineError extends Error {}

function renderNodes(nodes, values, depth, ctx, inEach = false) {
  if (depth > MAX_TEMPLATE_DEPTH) return ''; // documented: beyond 5 levels the branch emits nothing
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += node.text.replace(/\\n/g, '\n');
    else if (node.kind === 'tool') out += node.tool === 'newLine' ? NEW_LINE_SENTINEL : REMOVE_LINE_SENTINEL;
    else if (node.kind === 'group') out += renderGroup(node, values, depth, ctx, inEach);
    else out += renderExpression(node, values, depth, ctx, inEach);
    if (out.length > MAX_RENDER_LENGTH) { out = out.slice(0, MAX_RENDER_LENGTH); break; }
  }
  return out;
}

// A group renders only when every check-less field reference inside resolves
// to a present value — the FIELD matters, not the rendered text.
function renderGroup(node, values, depth, ctx, inEach) {
  for (const child of node.nodes) {
    if (child.kind !== 'expression' || child.check) continue;
    const resolved = resolveExpression(child, values, depth, ctx, inEach);
    if (resolved.present === false) return '';
  }
  return renderNodes(node.nodes, values, depth, ctx, inEach);
}

function resolveOperand(operand, values, ctx) {
  if (operand.literal !== undefined) {
    let value = operand.literal;
    for (const source of operand.modifiers) {
      const next = compileModifier(source)(value, values, ctx);
      if (next === undefined) break;
      value = next;
      if (typeof value === 'string' && value.length > MAX_RENDER_LENGTH) { value = value.slice(0, MAX_RENDER_LENGTH); break; }
    }
    return { result: value, present: true };
  }

  const [section, property] = splitPath(operand.path);
  const sectionValue = values[section];
  if (!sectionValue) throw new EngineError(`{unknown_variableType(${section})}`);
  const raw = sectionValue[property];
  if (raw === undefined) throw new EngineError(`{unknown_propertyName(${section}.${property})}`);

  let result = typeof raw === 'string' ? sanitise(raw)
    : Array.isArray(raw) && raw.some((i) => typeof i === 'string' && hasSentinel(i))
      ? raw.map((i) => (typeof i === 'string' ? sanitise(i) : i))
      : raw;

  const present = isPresent(raw) || operand.modifiers.some((m) => m.toLowerCase().startsWith('default('));

  for (const source of operand.modifiers) {
    const input = result;
    let next;
    try { next = compileModifier(source)(input, values, ctx); } catch { next = undefined; }
    if (next !== undefined) {
      result = next;
      if (typeof result === 'string' && result.length > MAX_RENDER_LENGTH) { result = result.slice(0, MAX_RENDER_LENGTH); break; }
      continue;
    }
    // a modifier on an absent value renders nothing
    if (input === null || input === undefined) return { result: '', present };
    throw new EngineError(`{unknown_${Array.isArray(input) ? 'array' : typeof input}_modifier(${source})}`);
  }
  if (isObjectList(result)) throw new EngineError(`{unrenderable_list(${section}.${property})}`);
  return { result, present };
}

const splitPath = (path) => path.split('.');

function resolveExpression(node, values, depth, ctx, inEach) {
  const first = { path: node.path, literal: node.literal, modifiers: node.modifiers };
  if (!node.extraOperands.length) return resolveOperand(first, values, ctx);

  const operandPresence = (op) => {
    if (op.literal !== undefined) return true;
    if (op.modifiers.some((m) => m.toLowerCase().startsWith('default('))) return true;
    const [section, property] = splitPath(op.path);
    const sectionValue = values[section];
    return sectionValue ? isPresent(sectionValue[property]) : false;
  };

  let present = operandPresence(first);
  for (let i = 0; i < node.comparators.length; i++) {
    const next = operandPresence(node.extraOperands[i]);
    present = node.comparators[i] === 'or' ? present || next : present && next;
  }

  const allSame = node.comparators.every((c) => c === node.comparators[0]);
  const canShortCircuit = allSame && (node.comparators[0] === 'and' || node.comparators[0] === 'or');

  let result = resolveOperand(first, values, ctx);
  if (result.error) return result;

  for (let i = 0; i < node.comparators.length; i++) {
    const comparator = node.comparators[i];
    if (canShortCircuit) {
      if (comparator === 'and' && result.result === false) return { result: false, present };
      if (comparator === 'or' && result.result === true) return { result: true, present };
    }
    const next = resolveOperand(node.extraOperands[i], values, ctx);
    if (next.error) return next;
    const a = result.result;
    const b = next.result;
    let combined;
    switch (comparator) {
      case 'and': combined = a && b; break;
      case 'or': combined = a || b; break;
      case 'xor': combined = (a || b) && !(a && b); break;
      case 'neq': combined = a !== b; break;
      case 'equal': combined = a === b; break;
      case 'left': combined = a; break;
      case 'right': combined = b; break;
      default: throw new EngineError(`{unable_to_compare(${comparator})}`);
    }
    result = { result: combined, present };
  }
  return { result: result.result, present };
}

function renderExpression(node, values, depth, ctx, inEach) {
  if (!node.check) {
    const resolved = resolveExpression(node, values, depth, ctx, inEach);
    if (resolved.error !== undefined) return resolved.error;
    return String(resolved.result ?? '');
  }
  const resolved = resolveExpression(node, values, depth, ctx, inEach);
  if (resolved.error !== undefined) return resolved.error;
  if (!isPresent(resolved.result)) {
    // absent renders nothing unless a third branch says otherwise
    return node.check.absent !== undefined
      ? renderNodes(parseTemplate(node.check.absent), values, depth + 1, ctx, inEach)
      : '';
  }
  if (resolved.result !== true && resolved.result !== false) {
    throw new EngineError(`{cannot_coerce_boolean_for_check_from(${resolved.result})}`);
  }
  const branchText = resolved.result ? node.check.yes : node.check.no;
  return renderNodes(parseTemplate(branchText), values, depth + 1, ctx, inEach);
}

// Render a parsed template against a value map. Errors propagate as
// EngineError so the caller can fail open.
function renderParsed(nodes, values, depth = 0, inEach = false) {
  const ctx = {
    resolveVariable: (path, parseValue) => {
      const [section, property] = canonicaliseField(...splitPath(path)) ?? [];
      if (!section) return undefined;
      return parseValue?.[section]?.[property];
    },
    resolveValues: (path, parseValue) => {
      const [section, property] = canonicaliseField(...splitPath(path)) ?? [];
      if (!section) return undefined;
      const v = parseValue?.[section]?.[property];
      if (Array.isArray(v)) return v.map((i) => String(i));
      if (v === null || v === undefined) return undefined;
      return [String(v)];
    },
  };
  return renderNodes(nodes, values, depth, ctx, inEach);
}

// Legacy entry: render a template string against a value map (nested sections
// like {stream:{resolution:'2160p'}} or flat dotted keys like
// {'stream.resolution':'2160p'}).
function renderTemplate(template, values) {
  if (typeof template !== 'string' || !template) return '';
  let map = values;
  if (values && Object.keys(values).some((k) => k.includes('.'))) {
    map = {};
    for (const [key, value] of Object.entries(values)) {
      const [section, property] = key.split('.');
      if (!property) continue;
      map[section] = map[section] || {};
      map[section][property] = value;
    }
  }
  try {
    return capRender(applyTools(renderParsed(parseTemplate(template), map || {})));
  } catch {
    return '';
  }
}

function capRender(out) {
  if (out.length <= MAX_RENDER_LENGTH) return out;
  const cut = out.slice(0, MAX_RENDER_LENGTH);
  const nl = cut.lastIndexOf('\n');
  return (nl > MAX_RENDER_LENGTH * 0.5 ? cut.slice(0, nl) : cut).trimEnd() + ' …';
}

// ═══════════════════ field map (our resolver data → template surface) ══════
// Every registry property is materialised (null when we have no data) so a
// template referencing an absent field renders "" / absent — never an error.

function sectionDefaults(section) {
  return Object.fromEntries(FIELD_REGISTRY[section].map((p) => [p, null]));
}

const CONTAINER_EXTS = ['mkv', 'mp4', 'avi', 'ts', 'm2ts', 'iso', 'mov', 'webm', 'flv', 'wmv', 'mpg', 'mpeg'];

function deriveFileMeta(urlStr, proxied, format) {
  let filename = null;
  let container = null;
  let extension = null;
  if (urlStr && !proxied) {
    try {
      const u = new URL(urlStr);
      const base = decodeURIComponent((u.pathname.split('/').pop() || '')).trim();
      if (/^[^\s]+\.[a-z0-9]{2,4}$/i.test(base)) {
        filename = base;
        extension = `.${base.split('.').pop().toLowerCase()}`;
        const ext = extension.slice(1);
        if (CONTAINER_EXTS.includes(ext)) container = ext;
      }
    } catch { /* not a parseable URL — no file meta */ }
  }
  if (!container && typeof format === 'string' && format.toLowerCase().includes('mp4')) {
    container = 'mp4';
    extension = extension || '.mp4';
  }
  return { filename, container, extension };
}

function fieldsForStream(meta, stream, addonName, extras = {}) {
  const height = Number(meta?.height) || 0;
  const resolution = height >= 2160 ? '2160p'
    : height >= 1440 ? '1440p'
    : height >= 1080 ? '1080p'
    : height >= 720 ? '720p'
    : height >= 480 ? '480p'
    : height >= 360 ? '360p' : null;
  const bytes = Number(meta?.bytes) > 0 ? Number(meta.bytes) : null;
  const urlStr = String(extras.url || '');
  const proxied = /\/(range-)?proxy(\?|$|\/)/.test(urlStr);
  const { filename, container, extension } = deriveFileMeta(urlStr, proxied, meta?.format);

  const codes = (Array.isArray(meta?.countryCodes) ? meta.countryCodes : [])
    .map((c) => String(c || '').toLowerCase().trim())
    .filter((c) => c && c !== 'multi'); // 'multi' is not a language (same as the default card display)
  const langNames = [...new Set(codes.map((c) => LANGUAGE_MAP[c]?.[0]).filter(Boolean))];
  const langEmojis = [...new Set(codes.map((c) => LANGUAGE_MAP[c]?.[1]).filter(Boolean))];
  const langCodes = [...new Set(codes.map((c) => (LANGUAGE_MAP[c] ? c.toUpperCase() : null)).filter(Boolean))];
  const smallLangCodes = langCodes.map((c) => makeSmall(c));

  const subTracks = Array.isArray(meta?.subtitles) ? meta.subtitles : [];
  const subCodes = [...new Set(subTracks.map((t) => String(t?.lang || '').toLowerCase().trim()).filter(Boolean))];
  const subNames = [...new Set(subCodes.map((c) => LANGUAGE_MAP[c]?.[0]).filter(Boolean))];
  const subEmojis = [...new Set(subCodes.map((c) => LANGUAGE_MAP[c]?.[1]).filter(Boolean))];

  const visualTags = meta?.hdr
    ? [...new Set(String(meta.hdr).split(/[,/]/).map((s) => s.trim()).filter(Boolean))]
    : null;
  const audioTags = meta?.audioCodec ? [String(meta.audioCodec)] : null;
  const audioChannels = meta?.audioChannels ? [String(meta.audioChannels)] : null;
  const encode = meta?.codec
    ? String(meta.codec)
    : (typeof meta?.codecs === 'string'
      ? (meta.codecs.includes('avc1') ? 'AVC'
        : meta.codecs.includes('hvc1') || meta.codecs.includes('hev1') ? 'HEVC'
          : meta.codecs.includes('av01') ? 'AV1' : null)
      : null);

  // user.resolutions: the configured quality whitelist, in canonical form
  const ac = extras.config || {};
  const resByTier = [['res_2160', '2160p'], ['res_1440', '1440p'], ['res_1080', '1080p'], ['res_720', '720p'], ['res_480', '480p'], ['res_360', '360p']];
  const userResolutions = resByTier
    .filter(([key]) => ac[key] === 'on' || ac[key] === true)
    .map(([, label]) => label);
  const userRes = userResolutions.length ? userResolutions : null;

  const requestType = extras.requestType === 'series' ? 'series' : extras.requestType === 'movie' ? 'movie' : null;
  let metadataSeason = Number.isFinite(extras.requestSeason) ? extras.requestSeason : null;
  let metadataEpisode = Number.isFinite(extras.requestEpisode) ? extras.requestEpisode : null;
  if (metadataSeason === null && metadataEpisode === null && requestType === 'series' && typeof extras.requestId === 'string') {
    const parts = extras.requestId.split(':');
    const s = parseInt(parts[1], 10);
    const e = parseInt(parts[2], 10);
    if (Number.isFinite(s)) metadataSeason = s;
    if (Number.isFinite(e)) metadataEpisode = e;
  }

  const streamSection = {
    ...sectionDefaults('stream'),
    filename,
    container,
    extension,
    size: bytes,
    bitrate: Number(meta?.bandwidth) > 0 ? Number(meta.bandwidth) : null,
    quality: meta?.sourceType ? String(meta.sourceType) : null,
    resolution,
    encode,
    languages: langNames.length ? langNames : null,
    languageCodes: langCodes.length ? langCodes : null,
    languageEmojis: langEmojis.length ? langEmojis : null,
    smallLanguageCodes: smallLangCodes.length ? smallLangCodes : null,
    uLanguages: langNames.length ? langNames : null,
    uLanguageCodes: langCodes.length ? langCodes : null,
    uLanguageEmojis: langEmojis.length ? langEmojis : null,
    uSmallLanguageCodes: smallLangCodes.length ? smallLangCodes : null,
    subtitles: subNames.length ? subNames : null,
    subtitleCodes: subCodes.length ? subCodes : null,
    subtitleEmojis: subEmojis.length ? subEmojis : null,
    smallSubtitleCodes: subCodes.length ? subCodes.map((c) => makeSmall(c)) : null,
    uSubtitles: subNames.length ? subNames : null,
    uSubtitleCodes: subCodes.length ? subCodes : null,
    uSubtitleEmojis: subEmojis.length ? subEmojis : null,
    uSmallSubtitleCodes: subCodes.length ? subCodes.map((c) => makeSmall(c)) : null,
    visualTags: visualTags && visualTags.length ? visualTags : null,
    audioTags: audioTags && audioTags.length ? audioTags : null,
    audioChannels: audioChannels && audioChannels.length ? audioChannels : null,
    releaseGroup: meta?.releaseGroup ? String(meta.releaseGroup) : null,
    network: meta?.streamingPlatform ? String(meta.streamingPlatform) : null,
    title: meta?.title ? String(meta.title) : null,
    type: 'http', // every card this addon serves is a direct/HTTP-hosted stream
    proxied,
    // addon-specific extensions (existing user templates keep working):
    provider: stream?.name ? String(stream.name) : null,
    fullTitle: stream?.title ? String(stream.title) : null,
    source: meta?.sourceLabel ? String(meta.sourceLabel) : null,
    server: (meta?.serverName || meta?.extractorLabel || meta?.provider) ? String(meta.serverName || meta.extractorLabel || meta.provider) : null,
    sizeReadable: bytes ? humanSize(bytes) : null,
  };
  const addonLabel = String(addonName || 'PhoeniX');
  const values = {
    stream: streamSection,
    service: sectionDefaults('service'),
    addon: { ...sectionDefaults('addon'), name: addonLabel },
    config: { ...sectionDefaults('config'), addonName: addonLabel },
    metadata: {
      ...sectionDefaults('metadata'),
      type: requestType,
      queryType: requestType,
      season: metadataSeason,
      episode: metadataEpisode,
    },
    user: { ...sectionDefaults('user'), resolutions: userRes },
    debug: {
      json: JSON.stringify(streamSection).slice(0, 2000),
      jsonf: JSON.stringify(streamSection, null, 2).slice(0, 2000),
    },
  };
  return values;
}

function humanSize(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

// ═══════════════════════════ formatStream (resolver entry) ═════════════════
// Output that still carries an unrendered token / engine-error marker means
// the template itself is broken — ship the card's original text instead
// (fail-open, same contract as before; junk can never reach a card).
const UNRENDERED_TOKEN = /\{(?:stream|addon|service|metadata|user|config|debug|tools)\.|invalid_expression|unknown_variableType|unknown_propertyName|unknown_(?:string|number|array|boolean|object)_modifier|cannot_coerce_boolean|unrenderable_list|unable_to_compare/;

function formatStream({ nameTemplate, descriptionTemplate, meta, stream, addonName, config, requestId, requestType, url }) {
  const build = (tpl, fallback) => {
    if (!tpl || !String(tpl).trim()) return fallback;
    try {
      const values = fieldsForStream(meta, stream, addonName, { config, requestId, requestType, url });
      const out = capRender(applyTools(renderParsed(parseTemplate(String(tpl)), values)));
      if (!out.trim() || UNRENDERED_TOKEN.test(out)) return fallback;
      return out;
    } catch {
      return fallback;
    }
  };
  return {
    name: build(nameTemplate, stream?.name || 'PhoeniX'),
    description: build(descriptionTemplate, stream?.title || ''),
  };
}

module.exports = {
  formatStream,
  renderTemplate,
  fieldsForStream,
  humanBytes: humanSize,
  FIELDS: FIELD_REGISTRY,
};
