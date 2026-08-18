// AnimeZeY Wrapper
// ----------------
// The upstream obfuscated scraper (animezey_orig.js) returns stream names that
// contain invisible BOM (U+FEFF) and zero-width-space (U+200B / U+2060) chars
// — likely an anti-debugging watermark injected by the source. Stremio and
// most UIs render these as zero-width glyphs which breaks title display,
// sorting, and binge-grouping.
//
// This wrapper:
//   1. Loads the original obfuscated scraper.
//   2. Sanitizes every string field (name, title) by stripping control chars
//      and zero-width/BOM glyphs.
//   3. Parses a real `quality` value out of the cleaned name when the
//      upstream scraper left it blank.
//   4. Falls back to a stable "HD" label if no quality marker is found.
//   5. Hardens error handling so a worker 429 never crashes the addon.

"use strict";

var _azModule = null;

function loadAZ() {
  if (_azModule) return _azModule;
  try { _azModule = require("./animezey_orig.cjs"); }
  catch (e) {
    try { _azModule = require("./animezey_orig.cjs"); }
    catch (e2) { _azModule = { getStreams: function () { return Promise.resolve([]); } }; }
  }
  return _azModule;
}

// Strip every invisible / control char that breaks UI display.
//   U+FEFF      BOM
//   U+200B      zero-width space
//   U+200C      zero-width non-joiner
//   U+200D      zero-width joiner
//   U+2060      word joiner
//   U+2061      function application
//   U+2062      invisible times
//   U+2063      invisible separator
//   U+00A0      non-breaking space (normalize to regular space)
//   U+180E      mongolian vowel separator
//   U+0000..U+001F  C0 control chars (except \t \n \r)
//   U+200E..U+200F  LRM/RLM
function sanitizeText(text) {
  if (!text) return "";
  var str = String(text);
  // Replace common invisible separators and BOM with nothing
  str = str.replace(/[\uFEFF\u200B\u200C\u200D\u2060\u2061\u2062\u2063\u180E\u200E\u200F]/g, "");
  // Normalize non-breaking spaces to regular spaces
  str = str.replace(/[\u00A0\u2028\u2029]/g, " ");
  // Strip remaining C0 / C1 control chars except \t \n \r
  str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  // Collapse repeated whitespace
  str = str.replace(/\s+/g, " ").trim();
  return str;
}

function parseQuality(text) {
  var t = String(text || "").toLowerCase();
  if (t.indexOf("2160p") !== -1 || t.indexOf("4k") !== -1 || t.indexOf("uhd") !== -1) return "2160p";
  if (t.indexOf("1440p") !== -1 || t.indexOf("2k") !== -1) return "1440p";
  if (t.indexOf("1080p") !== -1 || t.indexOf("full hd") !== -1 || t.indexOf("fhd") !== -1) return "1080p";
  if (t.indexOf("720p") !== -1 || t.indexOf("hd ready") !== -1) return "720p";
  if (t.indexOf("480p") !== -1) return "480p";
  if (t.indexOf("360p") !== -1) return "360p";
  if (t.indexOf("240p") !== -1) return "240p";
  return "HD";
}

function getStreams(tmdbId, type, season, episode) {
  var mod = loadAZ();
  return Promise.resolve()
    .then(function () { return mod.getStreams(tmdbId, type, season, episode); })
    .then(function (streams) {
      if (!Array.isArray(streams)) return [];
      return streams
        .filter(function (s) { return s && s.url; })
        .map(function (s) {
          var cleanName = sanitizeText(s.name) || "AnimeZeY";
          var cleanTitle = sanitizeText(s.title) || cleanName;
          var q = s.quality;
          if (!q || q === "" || q === undefined) {
            q = parseQuality(cleanName) || parseQuality(cleanTitle) || "HD";
          }
          var cleaned = Object.assign({}, s, {
            name: cleanName,
            title: cleanTitle,
            quality: q,
            type: s.type || "video/mp4"
          });
          // Also sanitize any nested headers/behaviorHints if they have strings
          if (cleaned.behaviorHints && typeof cleaned.behaviorHints === "object") {
            var bh = {};
            Object.keys(cleaned.behaviorHints).forEach(function (k) {
              var v = cleaned.behaviorHints[k];
              bh[k] = typeof v === "string" ? sanitizeText(v) : v;
            });
            cleaned.behaviorHints = bh;
          }
          return cleaned;
        });
    })
    .catch(function (err) {
      console.log("[AnimeZeY] Wrapper error: " + (err && err.message ? err.message : err));
      return [];
    });
}

module.exports = {
  getStreams: getStreams,
  _sanitizeText: sanitizeText,
  _parseQuality: parseQuality
};
