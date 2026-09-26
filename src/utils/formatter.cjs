// src/utils/formatter.cjs
//
// Task 98 — STREAM NAME / DESCRIPTION TEMPLATE ENGINE (configure UI's
// "Custom formatter").
//
// AIOStreams-style template syntax, implemented over the fields our resolver
// actually has on every card. Templates render per stream:
//
//   {field}                        → value or ""
//   {?literal {field} more?}       → conditional block: rendered only if
//                                    every {field} inside it has a value
//   {field::exists["A"||"B"]}      → switch: "A" if field exists else "B"
//   {field::replace(a,b)::upper}   → modifier chain (see MODIFIERS)
//   {addon.name}                   → the addon's display name
//
// FIELDS (everything else renders "" — templates degrade gracefully):
//   stream.resolution   '4K' | '1440p' | '1080p' | '720p' | '480p' | '360p'
//   stream.quality      same as resolution (alias)
//   stream.size         human size e.g. '2.4 GB' ('' when unknown)
//   stream.bytes        raw byte count ('' when unknown)
//   stream.source       source label, e.g. '4KHDHub'
//   stream.server       sub-server label when the source has named servers
//   stream.languages    comma list of detected audio languages
//   stream.title        the card's descriptive line (release info)
//   stream.provider     full card name line as the resolver built it
//   stream.type         'HLS' | 'MP4' | 'Direct'
//   addon.name          ADDON_NAME
//
// MODIFIERS: exists, title, upper, lower, replace(a,b), join(sep) (array-ish
// fields), truncate(n), bytes (raw number → human size).
//
// SAFETY: a template can only produce strings for the card's name/title.
// Render is length-capped, exception-guarded (any error → original card
// text), and runs after the resolver's own naming — a broken custom template
// can never crash /stream.

const FIELDS = [
  'stream.resolution', 'stream.quality', 'stream.size', 'stream.bytes',
  'stream.source', 'stream.server', 'stream.languages', 'stream.title',
  'stream.provider', 'stream.type', 'addon.name',
];

const MAX_RENDER = 400;

function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

// Build the field map for one stream from the resolver's urlResult meta.
// meta fields: height, bytes, sourceLabel, serverName/extractorLabel/provider,
// countryCodes (language codes), title, format.
function fieldsForStream(meta, stream, addonName) {
  const height = Number(meta?.height) || 0;
  const resolution = height >= 2160 ? '4K'
    : height >= 1440 ? '1440p'
    : height >= 1080 ? '1080p'
    : height >= 720 ? '720p'
    : height >= 480 ? '480p'
    : height >= 360 ? '360p' : '';
  const langs = Array.isArray(meta?.countryCodes) && meta.countryCodes.length
    ? meta.countryCodes.join(', ') : '';
  const fmt = String(meta?.format || '').toLowerCase();
  const type = fmt.includes('hls') || fmt.includes('m3u8') ? 'HLS'
    : fmt.includes('mp4') ? 'MP4'
    : meta?.isDirect ? 'Direct' : '';
  const server = meta?.serverName || meta?.extractorLabel || meta?.provider || '';
  return {
    'stream.resolution': resolution,
    'stream.quality': resolution,
    'stream.bytes': Number(meta?.bytes) > 0 ? String(Math.round(meta.bytes)) : '',
    'stream.size': Number(meta?.bytes) > 0 ? humanBytes(Number(meta.bytes)) : '',
    'stream.source': String(meta?.sourceLabel || ''),
    'stream.server': String(server),
    'stream.languages': langs,
    'stream.title': String(stream?.title || ''),
    'stream.provider': String(stream?.name || ''),
    'stream.type': type,
    'addon.name': String(addonName || 'PhoeniX'),
  };
}

// Tokenizer: walks the template, returns the rendered string.
// Grammar handled recursively:
//   chunk   := (text | token | cond)*
//   token   := '{' path ('::' modifier)* ('[' alt ']' '["' yes '"||"' no '"]')?
//   cond    := '{?' chunk '?}'
function renderTemplate(template, values) {
  if (typeof template !== 'string' || !template) return '';
  let out = '';
  let i = 0;
  const n = template.length;
  while (i < n) {
    const ch = template[i];
    if (ch === '{' && template[i + 1] === '?') {
      // conditional block {? ... ?} — render, keep only if it produced
      // non-whitespace output (that is the point of the syntax)
      let depth = 1;
      let j = i + 2;
      let body = '';
      while (j < n && depth > 0) {
        if (template[j] === '{' && template[j + 1] === '?') { depth++; j += 2; body += '{?'; continue; }
        if (template[j] === '?' && template[j + 1] === '}') { depth--; if (!depth) { j += 2; break; } body += '?}'; j += 2; continue; }
        body += template[j++];
      }
      const rendered = renderTemplate(body, values);
      if (rendered.trim()) out += rendered;
      i = j;
      continue;
    }
    if (ch === '{') {
      // find the matching '}' (templates can contain ["..."||"..."] with braces
      // inside? our grammar: no nested braces inside a single token except the
      // alt strings, which we scan char-wise)
      let j = i + 1;
      let body = '';
      let inStr = null;
      while (j < n) {
        const c = template[j];
        if (inStr) {
          if (c === inStr && template[j - 1] !== '\\') inStr = null;
          body += c; j++;
          continue;
        }
        if (c === '"' || c === "'") { inStr = c; body += c; j++; continue; }
        if (c === '{') { body = null; break; }   // nested '{' inside token = malformed → literal
        if (c === '}') { break; }
        body += c; j++;
      }
      if (body == null || template[j] !== '}') { out += '{'; i++; continue; }
      out += renderToken(body, values);
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out.slice(0, MAX_RENDER);
}

function applyModifier(value, mod) {
  // mod: name or name(args) — args split on first-level commas
  const m = /^([a-zA-Z_]+)(?:\((.*)\))?$/.exec(mod);
  if (!m) return value;
  const [, name, rawArgs] = m;
  const args = rawArgs != null
    ? splitArgs(rawArgs).map(a => a.replace(/^["']|["']$/g, ''))
    : [];
  switch (name) {
    case 'exists': return value ? '1' : '';
    case 'title': return value ? value.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()) : '';
    case 'upper': return value.toUpperCase();
    case 'lower': return value.toLowerCase();
    case 'replace': {
      if (args.length < 2) return value;
      try { return value.split(args[0]).join(args[1]); } catch { return value; }
    }
    case 'join': {
      const parts = value.split ? value.split(',') : [value];
      return parts.map(p => p.trim()).filter(Boolean).join(args[0] != null ? args[0] : ' | ');
    }
    case 'truncate': {
      const maxN = parseInt(args[0], 10);
      if (!Number.isFinite(maxN) || value.length <= maxN) return value;
      return value.slice(0, Math.max(1, maxN - 1)).trimEnd() + '…';
    }
    case 'bytes': {
      const num = Number(value);
      return Number.isFinite(num) && num > 0 ? humanBytes(num) : '';
    }
    default: return value; // unknown modifier = pass through (fail-open)
  }
}

function splitArgs(s) {
  const out = [];
  let cur = '';
  let inStr = null;
  for (const c of s) {
    if (inStr) { if (c === inStr) inStr = null; cur += c; continue; }
    if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
    if (c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// token body examples:
//   stream.resolution
//   stream.resolution::exists["{...}"||""]  — alt strings may hold a nested
//   template (one level); we render them with the same value map.
function renderToken(body, values) {
  // switch syntax: path::mods["YES"||"NO"]
  const switchRe = /^(.*?)\["(.*)"\|\|"(.*)"\]$/s;
  const sm = switchRe.exec(body);
  let pathPart = body;
  let yes = null, no = null;
  if (sm) {
    pathPart = sm[1];
    yes = sm[2];
    no = sm[3];
  }
  const mods = pathPart.split('::').map(s => s.trim()).filter(Boolean);
  const path = mods.shift();
  let value = values[path] != null ? String(values[path]) : '';
  for (const mod of mods) value = applyModifier(value, mod);
  if (yes != null || no != null) {
    // exists-style switch: truthy = value non-empty after mods
    return value ? renderTemplate(yes, values) : renderTemplate(no || '', values);
  }
  return value;
}

// Apply both templates to one card. Returns {name, description} — always
// falls back to the card's original text on empty render or error.
function formatStream({ nameTemplate, descriptionTemplate, meta, stream, addonName }) {
  const safe = (tpl, fallback) => {
    if (!tpl || !String(tpl).trim()) return fallback;
    try {
      const values = fieldsForStream(meta, stream, addonName);
      const out = renderTemplate(String(tpl), values);
      // A render that still carries unrendered field tokens means the template
      // itself is malformed (unclosed brace / broken switch syntax leaks raw
      // text like '{stream.resolution::exists["…'). Ship the card's original
      // text instead of template junk — same contract as the throw path.
      if (!out.trim() || /\{(?:stream|addon)\./.test(out)) return fallback;
      return out;
    } catch {
      return fallback;
    }
  };
  const name = safe(nameTemplate, stream?.name || 'PhoeniX');
  const description = safe(descriptionTemplate, stream?.title || '');
  return { name, description };
}

module.exports = { formatStream, renderTemplate, fieldsForStream, humanBytes, FIELDS };
