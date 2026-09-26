// src/utils/addonConfig.cjs
//
// Task 98 — ADDON CONFIG layer for the same-to-same configure UI.
//
// A configured install encodes the whole config JSON into the manifest URL
// path:  https://host/<segment>/manifest.json
//   - segment = URI-encoded JSON, or "z" + base64url(deflate-raw(json)) when
//     the browser's CompressionStream produced a shorter blob (the UI picks
//     whichever is shorter, exactly like the reference implementation).
// Stremio then appends every config key to EVERY resource request as query
// params (e.g. /stream/movie/tt.json?source_4khdhub=on&res_1080=on).
//
// FAIL-OPEN CONTRACT (Task 94 heritage): an absent/empty/unparseable config
// means the legacy full-registry, unfiltered behavior — byte-identical to a
// pre-config install. Unknown keys are ignored. No config key can ever make
// /stream fail; the config layer only ever narrows or reformats results.

const zlib = require('zlib');

// ── Source metadata for the configure page (/sources.json) ──────────────
// Curated from the Task 78/83 per-source audits + known site behavior.
// tags: [quality lead first, then speed/coverage tags]. Anime/movie-only
// classification comes from the registry + ANIME_ONLY_SOURCE_IDS.
const SOURCE_TAGS = {
  '4khdhub':        ['4K', '1080p', 'Mainstream', 'Classics', 'Series', 'Direct'],
  'fourkhdhubone':  ['4K', '1080p', 'Mainstream', 'Series', 'Direct'],
  'hdhub4uv2':      ['4K', '1080p', 'Hindi', 'Dual Audio', 'WEB-DL', 'Series'],
  'moviesdrivev2':  ['4K', '1080p', 'Direct', 'Series', 'Dual Audio'],
  'movieshuntv2':   ['4K', '1080p', 'Regional', 'Series'],
  'cinefreak':      ['4K', '1080p', 'Regional', 'Classics', 'Indie'],
  'bollyflix':      ['4K', '1080p', 'Hindi', 'Dual Audio', 'Regional'],
  'vegamovies2':    ['4K', '1080p', 'Regional', 'Direct', 'Dual Audio'],
  'vegamovies':     ['1080p', 'Regional', 'Hindi', 'Series'],
  'moviebox':       ['Fast', '1080p', 'Regional', 'Anime', 'Indie'],
  'cinewave':       ['HLS', '4K', '1080p', 'Mainstream', 'Series', 'Subtitles'],
  'vidfast':        ['HLS', '4K', '1080p', 'Mainstream', 'Series'],
  'vidlink2':       ['HLS', '1080p', 'Mainstream', 'Classic TV', 'Fast'],
  'vidking':        ['HLS', '4K', '1080p', 'Multi-Server', 'Series'],
  'vidsrcsbs':      ['HLS', '1080p', 'Mainstream'],
  'watchseries':    ['HLS', '1080p', 'Series', 'Classic TV'],
  'necro':          ['HLS', '1080p', 'Multi-Source'],
  'videasy':        ['HLS', '4K', '1080p', 'Multi-Server', 'Subtitles'],
  'videasyto':      ['HLS', '4K', '1080p', 'Multi-Server', 'Subtitles'],
  'cineby':         ['HLS', '4K', '1080p', 'Multi-Server', 'Anime'],
  'cinebyrocks':    ['HLS', '4K', '1080p', 'Multi-Server', 'Anime'],
  'zxcstream':      ['Player page', '1080p', 'Mainstream'],
  'vixsrc':         ['HLS', '1080p', 'Regional'],
  'vidzee':         ['HLS', '1080p', 'Multi-Server', 'Subtitles'],
  'primeshows':     ['HLS', '1080p', 'Mainstream'],
  'netlio':         ['HLS', '1080p', 'Mainstream'],
  'meinecloud':     ['Direct', '1080p', 'Movies Only'],
  'acermovies':     ['Direct', '1080p', 'Regional', 'Movies Only'],
  'streamxtv':      ['HLS', '4K', '1080p', 'Multi-Provider', 'Anime'],
  'framextv':       ['HLS', '4K', '1080p', 'Anime', 'Subtitles'],
  'cinejoyaio':     ['HLS', '4K', '1080p', 'Subtitles', 'Series'],
  'atlantic':       ['HLS', '4K', '1080p', 'Multi-Audio', 'Anime'],
  'stellar':        ['HLS', '4K', '1080p', 'Mainstream'],
  'anikoto':        ['Anime', 'HLS', 'Subtitles', 'Dub'],
  'anikototv':      ['Anime', 'HLS', 'Series'],
  'anikage':        ['Anime', 'HLS', 'Dub', 'Series'],
  'anibd':          ['Anime', 'HLS', 'Series'],
  '2dhive':         ['Anime', 'HLS', 'Movies Only'],
  'anidoor':        ['Anime', 'HLS', 'Dub'],
  'pantyflix':      ['Anime', '1080p', 'Series'],
  'animegg':        ['Anime', 'HLS', 'Dub'],
  'peckle':         ['1080p', 'Mainstream', 'Series'],
  'hianime':        ['Anime', 'HLS', 'Dub', 'Subtitles'],
  'animekai':       ['Anime', 'HLS', 'Subtitles'],
  'animezey':       ['Anime', 'Series Only'],
  'animesdigital':  ['Anime', 'Series Only', 'Dub'],
  'itachi':         ['Anime', 'HLS', 'Dub'],
  'reanime':        ['Anime', 'HLS', 'Dub', 'Subtitles'],
  'allwish':        ['Anime', 'HLS', 'Subtitles'],
  'nikastream':     ['Anime', 'HLS', 'Subtitles', 'Dub'],
  'anichan':        ['Anime', 'HLS', '1080p'],
  'animesuge':      ['Anime', 'HLS', '1080p', 'Dub'],
  'animotvslash':   ['Anime', '1080p'],
  'hindmoviez':     ['1080p', 'Hindi', 'Regional', 'Series'],
  'hindmovie':      ['Hindi', 'Regional'],
  'desiflix':       ['Multi-Provider', 'Regional', 'Series', 'Anime'],
  'persianstremio': ['Regional', 'Persian', 'Dual Audio', '4K'],
  'cinehdplus':     ['Regional', 'Series Only', 'HLS'],
  'verhdlink':      ['1080p', 'Direct', 'Movies Only'],
  'movielinkbd':    ['1080p', 'Regional', 'Dual Audio', 'Direct'],
  'playimdb':       ['HLS', '1080p', 'Mainstream'],
  'imdbplay':       ['HLS', '1080p', 'Mainstream'],
  'raflix':         ['HLS', '1080p', 'Mainstream'],
  'rivestream':     ['HLS', '1080p', 'Multi-Server'],
  'movieblast':     ['HLS', '1080p', 'Mainstream'],
  'uhdmovies':      ['4K', '1080p', 'Direct', 'Movies Only', 'Dual Audio'],
};

// ── Config decode ────────────────────────────────────────────────────────

function decodeSegment(segment) {
  if (!segment || typeof segment !== 'string') return null;
  try {
    if (segment.startsWith('z')) {
      const b64 = segment.slice(1).replace(/-/g, '+').replace(/_/g, '/');
      const json = zlib.inflateRawSync(Buffer.from(b64, 'base64')).toString('utf8');
      const parsed = JSON.parse(json);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    }
    const json = decodeURIComponent(segment);
    const parsed = JSON.parse(json);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

// Parse the query params Stremio appends (config values ride as params).
// Returns the raw key/value map (strings). Absent → {}.
function configFromQuery(query) {
  const out = {};
  if (!query) return out;
  for (const [k, v] of Object.entries(query)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0];
  }
  return out;
}

const RANKS = [2160, 1080, 720, 480, 360];

// Normalize a raw config map into the resolved options the resolver and the
// /stream route consume. Anything not explicitly configured stays "unset"
// (falsy) → legacy behavior. Unknown source keys are IGNORED (fail-open if
// they turn out to be the only keys).
function normalizeConfig(raw, { allSourceIds } = {}) {
  const cfg = {
    // source whitelist: null = no source_* keys present (all sources)
    sourceIds: null,
    // quality whitelist: null = no res_* keys present (all heights)
    heights: null,
    subtitlesDisabled: false,
    disableDirect: false,      // hide non-inline-playable (external player-page) cards
    minBytes: null,
    maxBytes: null,
    groupBy: null,             // 'provider' | 'quality' | null
    sortBy: null,              // 'size' | null
    providerOrder: null,       // [sourceId,...] | null
    maxTimeoutSec: null,       // 5..45 | null
    qualityCaps: null,         // Map<'<sourceId>_<height>', n> (0 = block tier)
    formatterName: null,
    formatterDescription: null,
    hasAny: false,
  };
  if (!raw || typeof raw !== 'object') return cfg;

  const known = allSourceIds instanceof Set ? allSourceIds : null;
  const picked = [];
  let sawSourceKey = false;
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('source_')) {
      sawSourceKey = true;
      const id = k.slice('source_'.length);
      if (v === 'on' || v === '1' || v === 'true') {
        if (!known || known.has(id)) picked.push(id);
      }
    }
  }
  if (sawSourceKey) {
    cfg.sourceIds = picked.length ? picked : [];
    cfg.hasAny = true;
  }

  const heights = [];
  let sawRes = false;
  for (const rank of RANKS) {
    const v = raw[`res_${rank}`];
    if (v != null) {
      sawRes = true;
      if (v === 'on' || v === '1' || v === 'true') heights.push(rank);
    }
  }
  if (sawRes) {
    cfg.heights = heights;
    cfg.hasAny = true;
  }

  const on = (v) => v === 'on' || v === '1' || v === 'true';
  if (raw.subtitles_disabled != null) { cfg.subtitlesDisabled = on(raw.subtitles_disabled); cfg.hasAny = true; }
  if (raw.disable_direct != null) { cfg.disableDirect = on(raw.disable_direct); cfg.hasAny = true; }

  const num = (v) => {
    const n = Number(v);
    return (v != null && v !== '' && Number.isFinite(n) && n > 0) ? n : null;
  };
  const minGb = num(raw.min_size_gb);
  const maxGb = num(raw.max_size_gb);
  if (minGb != null) { cfg.minBytes = Math.round(minGb * 1024 ** 3); cfg.hasAny = true; }
  if (maxGb != null) { cfg.maxBytes = Math.round(maxGb * 1024 ** 3); cfg.hasAny = true; }

  if (raw.group_by === 'provider' || raw.group_by === 'quality') { cfg.groupBy = raw.group_by; cfg.hasAny = true; }
  if (raw.sort_by === 'size') { cfg.sortBy = 'size'; cfg.hasAny = true; }
  if (typeof raw.provider_order === 'string' && raw.provider_order.trim()) {
    const ids = raw.provider_order.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length) { cfg.providerOrder = ids; cfg.hasAny = true; }
  }
  const t = num(raw.max_timeout);
  if (t != null) { cfg.maxTimeoutSec = Math.min(45, Math.max(5, Math.round(t))); cfg.hasAny = true; }

  const caps = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith('quality_limit_')) continue;
    // key: quality_limit_<sourceId>_<rank>
    const rest = k.slice('quality_limit_'.length);
    const m = /^(.+)_(2160|1080|720|480|360)$/.exec(rest);
    if (!m) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    if (n > 0 || n === 0) { caps[`${m[1]}_${m[2]}`] = Math.round(n); cfg.hasAny = true; }
  }
  if (Object.keys(caps).length) cfg.qualityCaps = caps;

  if (typeof raw.formatter_name === 'string' && raw.formatter_name.trim()) {
    cfg.formatterName = raw.formatter_name; cfg.hasAny = true;
  }
  if (typeof raw.formatter_description === 'string' && raw.formatter_description.trim()) {
    cfg.formatterDescription = raw.formatter_description; cfg.hasAny = true;
  }
  return cfg;
}

module.exports = { decodeSegment, configFromQuery, normalizeConfig, SOURCE_TAGS, RANKS };
