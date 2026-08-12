/**
 * AnimesDigital - Nuvio Provider (Fixed Build)
 *
 * Scrapes animesdigital.org — Brazilian anime catalog that serves direct HLS
 * playlists.
 *
 * ──────────────────────────────────────────────────────────────────
 * FIXES vs upstream (D3adlyRocket/Anime-Nuvio @ commit 3101d8223):
 *
 *   v1.1.0
 *     1) The site changed search URL pattern. `/?s=<q>` now returns a 302
 *        redirect to `/search/<q>`. Some React-Native / Hermes fetch
 *        implementations drop query params or surface the 302 as the final
 *        response, resulting in zero search results. Switched to the new
 *        canonical URL `/search/<q>` (no redirect, 200 OK).
 *     2) Page-size sanity threshold lowered from 40 KB to 20 KB.
 *     3) Stream object: added `notWebReady: true` because the CDN serves
 *        the .m3u8 with `Content-Type: application/octet-stream`.
 *     4) `redirect: "follow"` explicit on every fetch call.
 *
 *   v1.2.0
 *     5) Filter "fake MP4" iframes. The episode page actually has TWO
 *        iframes: one real HLS iframe pointing at api.anivideo.net, and
 *        one decoy iframe on the same animesdigital.org domain whose URL
 *        ends in ".mp4" but is in fact an obfuscated HTML player wrapper
 *        (opens to /home when accessed directly). We now skip any iframe
 *        whose host is animesdigital.org because it's never a real
 *        stream — only api.anivideo.net / cdn-s01.* contain playable URLs.
 *     6) Dedup streams by final URL. If multiple candidate anime pages
 *        resolve to the SAME .m3u8 (e.g. "naruto" and "naruto-classico"
 *        both pointing at /naruto-classico-legendado/01.mp4/index.m3u8),
 *        we only emit one entry.
 *     7) Friendlier titles: arc/season name derived from the slug
 *        instead of dumping the raw URL slug. Example:
 *        "kimetsu-no-yaiba-hashira-geiko-hen" → "Hashira Geiko Hen".
 *
 * Author of fixes: community fork — original logic by Nuvio Team.
 *
 * Hermes-safe (generator + __async helper, no async/await).
 */
"use strict";

var TMDB_API_KEY = "68e094699525b18a70bab2f86b1fa706";
var BASE_URL = "https://animesdigital.org";
var PROVIDER_TAG = "AnimesDigital";
var PROVIDER_VERSION = "1.2.0";
var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

// ─────────────────────────────────────────────
// Async helper (Hermes-safe generator runner)
// ─────────────────────────────────────────────
var __async = function (__this, __arguments, generator) {
  return new Promise(function (resolve, reject) {
    var fulfilled = function (v) {
      try { step(generator.next(v)); } catch (e) { reject(e); }
    };
    var rejected = function (v) {
      try { step(generator.throw(v)); } catch (e) { reject(e); }
    };
    var step = function (x) {
      return x.done
        ? resolve(x.value)
        : Promise.resolve(x.value).then(fulfilled, rejected);
    };
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// ─────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────
function fetchText(url, opts) {
  if (!opts) opts = {};
  return __async(this, null, function* () {
    try {
      var r = yield fetch(url, {
        method: opts.method || "GET",
        redirect: "follow",
        headers: Object.assign(
          {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9",
          },
          opts.headers || {}
        ),
      });
      return { status: r.status, text: yield r.text() };
    } catch (e) {
      return { status: -1, text: "" };
    }
  });
}

function fetchJson(url, opts) {
  if (!opts) opts = {};
  return __async(this, null, function* () {
    try {
      var r = yield fetch(url, {
        method: opts.method || "GET",
        redirect: "follow",
        headers: Object.assign(
          {
            "User-Agent": USER_AGENT,
            Accept: "application/json, */*",
            "Accept-Language": "pt-BR,pt;q=0.9",
          },
          opts.headers || {}
        ),
      });
      var t = yield r.text();
      try { return { status: r.status, data: JSON.parse(t) }; }
      catch (e) { return { status: r.status, data: null, raw: t }; }
    } catch (e) {
      return { status: -1, data: null };
    }
  });
}

// ─────────────────────────────────────────────
// Slug utilities
// ─────────────────────────────────────────────
var STOPWORDS = {
  a: 1, o: 1, os: 1, as: 1, de: 1, do: 1, da: 1, dos: 1, das: 1,
  the: 1, of: 1, and: 1, e: 1, "no": 1, na: 1, nos: 1, nas: 1,
  to: 1, in: 1, on: 1, at: 1, for: 1, ni: 1, wa: 1, ga: 1, wo: 1, ka: 1,
};

function normalize(str) {
  if (!str) return "";
  str = str.toLowerCase();
  str = str.replace(/[áàâãä]/g, "a")
           .replace(/[éèêë]/g, "e")
           .replace(/[íìîï]/g, "i")
           .replace(/[óòôõö]/g, "o")
           .replace(/[úùûü]/g, "u")
           .replace(/[ç]/g, "c")
           .replace(/[ñ]/g, "n")
           .replace(/[:：]/g, " ")
           .replace(/[^a-z0-9\s-]/g, " ")
           .replace(/\s+/g, " ")
           .trim();
  return str;
}

function slugify(str) {
  return normalize(str).replace(/\s+/g, "-");
}

function tokensOf(title, minLen) {
  if (!minLen) minLen = 3;
  return normalize(title)
    .split(" ")
    .filter(function (w) { return w && !STOPWORDS[w] && w.length >= minLen; });
}

function stripListSuffix(slug) {
  return slug
    .replace(/-todos-os-episodios$/, "")
    .replace(/-todos-episodios$/, "");
}

function slugBody(slug) {
  return slug
    .replace(/-dublado$/, "")
    .replace(/-legendado$/, "")
    .replace(/-online$/, "")
    .replace(/-[0-9]+$/, "");
}

function isStrictMatch(slug, expectedRoots, strongTokens) {
  if (!slug) return false;
  var body = slugBody(stripListSuffix(slug));

  for (var i = 0; i < expectedRoots.length; i++) {
    var root = expectedRoots[i];
    if (!root) continue;
    if (body === root) return true;
    if (body.indexOf(root + "-") === 0) return true;
  }

  for (var j = 0; j < expectedRoots.length; j++) {
    var r2 = expectedRoots[j];
    if (!r2 || r2.length < 6) continue;
    if (body.indexOf("-" + r2 + "-") !== -1) return true;
    if (body.length > r2.length && body.substring(body.length - r2.length - 1) === "-" + r2) return true;
  }

  if (strongTokens && strongTokens.length >= 2) {
    var hits = 0;
    for (var k = 0; k < strongTokens.length; k++) {
      if (body.indexOf(strongTokens[k]) !== -1) hits++;
    }
    var needed = Math.max(2, Math.ceil(strongTokens.length * 0.5));
    if (hits >= needed) return true;
  }

  return false;
}

// FIX #7: turn slug into a human-readable arc/season name.
// "kimetsu-no-yaiba-hashira-geiko-hen-dublado" → "Hashira Geiko Hen"
// "naruto-classico" → "Clássico"
// "one-piece" → "" (same as main title, omit)
function prettyArcName(slug, info) {
  if (!slug) return "";
  var body = slugBody(stripListSuffix(slug));

  // The "main" slug is derived ONLY from info.title and info.originalTitle
  // (not from alt titles). Alt titles are usually arc/season names and we
  // do NOT want to strip them, otherwise distinct arcs collapse into the
  // same display label.
  var mainSlugs = [];
  function pushMain(t) {
    if (!t) return;
    var s2 = slugify(t);
    if (s2 && mainSlugs.indexOf(s2) === -1) mainSlugs.push(s2);
    var noThe = s2.replace(/^the-/, "");
    if (noThe && noThe !== s2 && mainSlugs.indexOf(noThe) === -1) mainSlugs.push(noThe);
    // The part after the colon counts too (e.g. main = "Demon Slayer: Kimetsu
    // no Yaiba" → also strip "kimetsu-no-yaiba" so arc names are exposed).
    if (t.indexOf(":") !== -1) {
      var afterColon = t.split(":").slice(1).join(":").trim();
      var afterSlug = slugify(afterColon);
      if (afterSlug && mainSlugs.indexOf(afterSlug) === -1) mainSlugs.push(afterSlug);
    }
  }
  pushMain(info.title);
  pushMain(info.originalTitle);
  mainSlugs.sort(function (a, b) { return b.length - a.length; });

  // If body matches the main title exactly → nothing extra to show.
  for (var ci = 0; ci < mainSlugs.length; ci++) {
    if (body === mainSlugs[ci]) return "";
  }

  // Strip the longest matching MAIN prefix; the remainder is the arc/season.
  var trimmed = body;
  for (var cj = 0; cj < mainSlugs.length; cj++) {
    var cs = mainSlugs[cj];
    if (body.indexOf(cs + "-") === 0) {
      trimmed = body.substring(cs.length + 1);
      break;
    }
  }
  if (!trimmed) return "";
  var parts = trimmed.split("-").filter(Boolean);
  for (var i = 0; i < parts.length; i++) {
    parts[i] = parts[i].charAt(0).toUpperCase() + parts[i].substring(1);
  }
  return parts.join(" ");
}

// ─────────────────────────────────────────────
// TMDB
// ─────────────────────────────────────────────
function getTmdbInfo(tmdbId, type) {
  return __async(this, null, function* () {
    var path = type === "tv" ? "tv" : "movie";
    var base = "https://api.themoviedb.org/3/" + path + "/" + tmdbId;
    var ptRes = yield fetchJson(base + "?api_key=" + TMDB_API_KEY + "&language=pt-BR");
    if (!ptRes.data) return null;
    var d = ptRes.data;
    var origin = d.origin_country || [];
    var isJapaneseOrigin =
      d.original_language === "ja" ||
      origin.indexOf("JP") !== -1 ||
      origin.indexOf("JA") !== -1;

    var altTitles = [];
    var altRes = yield fetchJson(base + "/alternative_titles?api_key=" + TMDB_API_KEY);
    if (altRes && altRes.data) {
      var results = altRes.data.results || altRes.data.titles || [];
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        if (!r || !r.title) continue;
        var c = (r.iso_3166_1 || "").toUpperCase();
        if (c === "JP" || c === "US" || c === "GB" || c === "BR" || c === "PT") {
          altTitles.push(r.title);
        }
      }
    }

    return {
      title: d.title || d.name || "",
      originalTitle: d.original_title || d.original_name || "",
      altTitles: altTitles,
      year: ((d.release_date || d.first_air_date || "").split("-")[0]) || null,
      originalLanguage: d.original_language || "",
      originCountry: origin,
      isAnime: isJapaneseOrigin,
    };
  });
}

// ─────────────────────────────────────────────
// Expected roots
// ─────────────────────────────────────────────
function buildExpectedRoots(tmdbInfo) {
  var titles = [tmdbInfo.title, tmdbInfo.originalTitle]
    .concat(tmdbInfo.altTitles || [])
    .filter(Boolean);
  var roots = [];
  var seen = {};
  function push(s) { if (s && !seen[s]) { seen[s] = 1; roots.push(s); } }
  for (var i = 0; i < titles.length; i++) {
    var base = slugify(titles[i]);
    if (!base) continue;
    push(base);
    push(base.replace(/^the-/, ""));
    var afterColon = titles[i].indexOf(":") !== -1
      ? titles[i].split(":").slice(1).join(":")
      : "";
    if (afterColon) {
      var slug = slugify(afterColon);
      if (slug) push(slug);
    }
  }
  return roots;
}

function buildStrongTokens(info) {
  var source = [info.title, info.originalTitle].concat(info.altTitles || []);
  var seen = {};
  var out = [];
  for (var si = 0; si < source.length; si++) {
    var toks = tokensOf(source[si], 4);
    for (var ti = 0; ti < toks.length; ti++) {
      if (!seen[toks[ti]]) { seen[toks[ti]] = 1; out.push(toks[ti]); }
    }
  }
  return out;
}

// ─────────────────────────────────────────────
// Search animesdigital
// FIX #1: site moved from /?s=Q (now 302) to /search/Q (200).
// ─────────────────────────────────────────────
function searchAnime(query) {
  return __async(this, null, function* () {
    if (!query) return [];
    var slugQuery = slugify(query);
    if (!slugQuery) return [];

    var url = BASE_URL + "/search/" + encodeURIComponent(slugQuery);
    var res = yield fetchText(url);

    // Fallback: try the legacy ?s= URL in case the site rolls back.
    if (!res || res.status !== 200 || res.text.length < 2000) {
      var legacyUrl = BASE_URL + "/?s=" + encodeURIComponent(query);
      res = yield fetchText(legacyUrl);
      if (!res || res.status !== 200 || res.text.length < 2000) return [];
    }

    var results = [];
    var seen = {};
    var re = /href=["'](https?:\/\/animesdigital\.org\/(?:anime|desenho|dorama|tokusatsu)\/[a-z]+\/([a-z0-9-]+))\/?["']/gi;
    var m;
    while ((m = re.exec(res.text)) !== null) {
      var full = m[1];
      var slug = m[2];
      if (seen[slug]) continue;
      seen[slug] = 1;
      results.push({ url: full, slug: slug });
    }
    var reFilm = /href=["'](https?:\/\/animesdigital\.org\/filme\/[a-z]+\/([a-z0-9-]+))\/?["']/gi;
    while ((m = reFilm.exec(res.text)) !== null) {
      var f = m[2];
      if (seen[f]) continue;
      seen[f] = 1;
      results.push({ url: m[1], slug: f });
    }
    return results;
  });
}

// ─────────────────────────────────────────────
// Build direct-guess slugs
// ─────────────────────────────────────────────
function buildDirectGuessPages(tmdbInfo, season) {
  var titles = [tmdbInfo.title, tmdbInfo.originalTitle]
    .concat(tmdbInfo.altTitles || [])
    .filter(Boolean);
  var seen = {};
  var out = [];
  function push(slug) {
    if (!slug || seen[slug]) return;
    seen[slug] = 1;
    out.push({ url: BASE_URL + "/anime/a/" + slug, slug: slug });
  }
  for (var i = 0; i < titles.length; i++) {
    var base = slugify(titles[i]);
    if (!base) continue;
    push(base);
    push(base + "-dublado");
    push(base + "-legendado");
    var stripped = base.replace(/^the-/, "");
    if (stripped !== base) {
      push(stripped);
      push(stripped + "-dublado");
    }
    var afterColon = titles[i].indexOf(":") !== -1
      ? titles[i].split(":").slice(1).join(":")
      : "";
    if (afterColon) {
      var cs = slugify(afterColon);
      if (cs) {
        push(cs);
        push(cs + "-dublado");
        push(cs + "-legendado");
      }
    }
    if (season && season > 1) {
      push(base + "-" + season);
      push(base + "-" + season + "-dublado");
    }
  }
  return out;
}

function tryFetchAnimePage(pageObj) {
  return __async(this, null, function* () {
    var res = yield fetchText(pageObj.url);
    if (!res || res.status !== 200) return null;
    if (res.text.length < 20000) return null;
    if (res.text.indexOf("/video/a/") === -1) return null;
    return { url: pageObj.url, slug: pageObj.slug, html: res.text };
  });
}

var EPS_PER_PAGE = 50;

function fetchAnimePageN(baseUrl, pageNum) {
  return __async(this, null, function* () {
    var url = pageNum > 1 ? baseUrl + "?paged=" + pageNum : baseUrl;
    var res = yield fetchText(url);
    if (!res || res.status !== 200 || res.text.length < 20000) return null;
    return res.text;
  });
}

function guessPageForEpisode(maxEpOnPage1, targetEp) {
  if (!maxEpOnPage1 || maxEpOnPage1 <= 0) return 1;
  if (targetEp > maxEpOnPage1) return 1;
  var indexFromTop = maxEpOnPage1 - targetEp + 1;
  return Math.max(1, Math.ceil(indexFromTop / EPS_PER_PAGE));
}

// ─────────────────────────────────────────────
// Parse episode list
// ─────────────────────────────────────────────
function parseEpisodes(html) {
  var eps = [];
  var seen = {};
  var blockRe = /<a[^>]+href=["']https?:\/\/animesdigital\.org\/video\/[a-z]+\/([0-9]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = blockRe.exec(html)) !== null) {
    var id = m[1];
    if (seen[id]) continue;
    var inner = m[2];
    var numMatch =
      inner.match(/epis[oó]dio\s*([0-9]+)/i) ||
      inner.match(/\bep\.?\s*([0-9]+)/i) ||
      inner.match(/>\s*([0-9]+)\s*</);
    var num = numMatch ? parseInt(numMatch[1], 10) : null;
    seen[id] = 1;
    eps.push({ id: id, num: num });
  }
  return eps;
}

// ─────────────────────────────────────────────
// Extract HLS/MP4 from episode page
// FIX #5: Skip "fake MP4" iframes on animesdigital.org. The site embeds
// a decoy iframe whose src ends in ".mp4" but actually serves an
// obfuscated HTML player (not a real video). Only iframes pointing at
// external hosts (api.anivideo.net, cdn-s01.*, etc.) are real streams.
// ─────────────────────────────────────────────
function extractStream(html) {
  var ifRe = /<iframe[^>]+src=["']([^"']+)["']/gi;
  var m;
  var iframes = [];
  while ((m = ifRe.exec(html)) !== null) iframes.push(m[1]);

  for (var i = 0; i < iframes.length; i++) {
    var src = iframes[i];

    // FIX #5a: skip same-domain iframes — they are HTML player wrappers.
    if (/^https?:\/\/(?:www\.)?animesdigital\.org\//i.test(src)) continue;

    // a) videohls.php?d=<url>
    var dMatch = src.match(/[?&]d=([^&]+)/);
    if (dMatch) {
      var inner = dMatch[1];
      try { inner = decodeURIComponent(inner); } catch (e) {}
      // FIX #5b: also skip decoded URLs that point back at animesdigital.
      if (/^https?:\/\/(?:www\.)?animesdigital\.org\//i.test(inner)) continue;
      if (/\.m3u8/i.test(inner)) return { url: inner, type: "hls", referer: BASE_URL + "/" };
      if (/\.mp4/i.test(inner)) return { url: inner, type: "mp4", referer: BASE_URL + "/" };
    }
    // b) direct .m3u8/.mp4 iframe (rare)
    if (/\.m3u8/i.test(src)) return { url: src, type: "hls", referer: BASE_URL + "/" };
    if (/\.mp4(\?|$)/i.test(src)) return { url: src, type: "mp4", referer: BASE_URL + "/" };
  }

  // 2) Direct .m3u8/.mp4 anywhere on the page (fallback)
  // FIX #5c: also exclude same-domain matches here.
  var direct = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi);
  if (direct) {
    for (var di = 0; di < direct.length; di++) {
      if (!/^https?:\/\/(?:www\.)?animesdigital\.org\//i.test(direct[di])) {
        return { url: direct[di], type: "hls", referer: BASE_URL + "/" };
      }
    }
  }
  var directMp4 = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi);
  if (directMp4) {
    for (var di2 = 0; di2 < directMp4.length; di2++) {
      if (!/^https?:\/\/(?:www\.)?animesdigital\.org\//i.test(directMp4[di2])) {
        return { url: directMp4[di2], type: "mp4", referer: BASE_URL + "/" };
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// Build stream object
// FIX #3: notWebReady=true so Nuvio uses native demuxer.
// FIX #7: friendlier display title.
// ─────────────────────────────────────────────
function toStream(sx, info, animeSlug, season, episode, relevance, isDubbed) {
  var mainTitle = info.title || info.originalTitle || "Anime";
  var titleBase = mainTitle + (info.year ? " (" + info.year + ")" : "");
  var epTag = episode
    ? " · EP" + (season > 1 ? "S" + season + "E" + episode : String(episode))
    : "";
  var flag = isDubbed ? "DUB" : "LEG";

  // Replace raw slug with a friendly arc/season name if there's extra info.
  var arc = prettyArcName(animeSlug, info);
  var arcSuffix = arc ? " · " + arc : "";

  return {
    _relevance: relevance || 0,
    name: PROVIDER_TAG + " · " + (sx.type === "hls" ? "HLS" : "MP4"),
    title: titleBase + epTag + arcSuffix + " [PT-BR " + flag + "]",
    quality: sx.quality || "Auto",
    url: sx.url,
    type: sx.type,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: "animesdigital-" + animeSlug,
    },
    headers: {
      "User-Agent": USER_AGENT,
      Referer: sx.referer || (BASE_URL + "/"),
      Origin: BASE_URL,
      Accept: sx.type === "hls"
        ? "application/vnd.apple.mpegurl,application/x-mpegURL,*/*"
        : "video/mp4,video/*;q=0.9,*/*;q=0.8",
    },
    provider: "animesdigital",
  };
}

// ─────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────
function getStreams(tmdbId, type, season, episode) {
  return __async(this, null, function* () {
    try {
      if (!tmdbId) return [];
      var info = yield getTmdbInfo(tmdbId, type);
      if (!info || (!info.title && !info.originalTitle)) return [];

      if (!info.isAnime) {
        console.log(
          "[" + PROVIDER_TAG + "] skipping non-anime: " +
          (info.title || info.originalTitle) +
          " (lang=" + info.originalLanguage + ", origin=" +
          (info.originCountry || []).join(",") + ")"
        );
        return [];
      }

      console.log(
        "[" + PROVIDER_TAG + " v" + PROVIDER_VERSION + "] " + type + " " +
        (info.title || info.originalTitle) + " (" + (info.year || "?") + ")" +
        (type === "tv" ? " S" + (season || 1) + "E" + (episode || 1) : "")
      );

      var expectedRoots = buildExpectedRoots(info);
      var strongTokens = buildStrongTokens(info);

      var queries = [];
      var src = [info.title, info.originalTitle].concat(info.altTitles || []);
      for (var qi = 0; qi < src.length; qi++) {
        var t = (src[qi] || "").trim();
        if (t && queries.indexOf(t) === -1) queries.push(t);
      }
      if (queries.length === 0) return [];

      // 1) DIRECT GUESSES
      var candidatePages = [];
      var seenPage = {};
      var directGuesses = buildDirectGuessPages(info, season);
      var guessTried = 0;
      var MAX_GUESSES = 8;
      for (var g = 0; g < directGuesses.length && guessTried < MAX_GUESSES; g++) {
        if (seenPage[directGuesses[g].slug]) continue;
        seenPage[directGuesses[g].slug] = 1;
        guessTried++;
        var checked = yield tryFetchAnimePage(directGuesses[g]);
        if (checked) {
          candidatePages.push(checked);
          if (candidatePages.length >= 4) break;
        }
      }

      // 2) FALLBACK SEARCHES
      if (candidatePages.length < 4) {
        for (var q = 0; q < queries.length && candidatePages.length < 6; q++) {
          var searchResults = yield searchAnime(queries[q]);
          for (var sr = 0; sr < searchResults.length; sr++) {
            if (seenPage[searchResults[sr].slug]) continue;
            if (!isStrictMatch(searchResults[sr].slug, expectedRoots, strongTokens)) continue;
            seenPage[searchResults[sr].slug] = 1;
            candidatePages.push(searchResults[sr]);
            if (candidatePages.length >= 6) break;
          }
        }
      }

      if (candidatePages.length === 0) {
        console.log("[" + PROVIDER_TAG + "] no matching anime page found");
        return [];
      }

      console.log(
        "[" + PROVIDER_TAG + "] " + candidatePages.length + " candidate pages: " +
        candidatePages.map(function (p) { return p.slug; }).join(", ")
      );

      var targetEp = type === "tv" ? (episode || 1) : 1;
      var streams = [];
      var seenStreamUrl = {}; // FIX #6: dedup by final stream URL.

      for (var cp = 0; cp < candidatePages.length && streams.length < 4; cp++) {
        var page = candidatePages[cp];
        var html = page.html || null;
        if (!html) {
          var pageRes = yield fetchText(page.url);
          if (!pageRes || pageRes.status !== 200) continue;
          html = pageRes.text;
        }

        var body = slugBody(stripListSuffix(page.slug));
        var isDubbed = /dublado/i.test(page.slug);

        var relevance = 50;
        for (var rr = 0; rr < expectedRoots.length; rr++) {
          var root = expectedRoots[rr];
          if (!root) continue;
          if (body === root) { relevance = Math.max(relevance, 100); break; }
          if (body.indexOf(root + "-") === 0) { relevance = Math.max(relevance, 90); break; }
          if (body.indexOf("-" + root + "-") !== -1) relevance = Math.max(relevance, 70);
        }

        var target = null;
        if (type === "tv") {
          var page1Eps = parseEpisodes(html);
          if (page1Eps.length === 0) continue;
          var page1Max = 0;
          for (var em = 0; em < page1Eps.length; em++) {
            if (typeof page1Eps[em].num === "number" && page1Eps[em].num > page1Max) {
              page1Max = page1Eps[em].num;
            }
          }
          for (var e1 = 0; e1 < page1Eps.length; e1++) {
            if (page1Eps[e1].num === targetEp) { target = page1Eps[e1]; break; }
          }
          if (!target && page1Max > 0 && targetEp < page1Max) {
            var guessedPage = guessPageForEpisode(page1Max, targetEp);
            var pagesToTry = [guessedPage];
            if (guessedPage > 1) pagesToTry.push(guessedPage - 1);
            pagesToTry.push(guessedPage + 1);
            for (var gp = 0; gp < pagesToTry.length && !target; gp++) {
              var pn = pagesToTry[gp];
              if (pn <= 1) continue;
              var pageHtml = yield fetchAnimePageN(page.url, pn);
              if (!pageHtml) continue;
              var epsN = parseEpisodes(pageHtml);
              for (var ei2 = 0; ei2 < epsN.length; ei2++) {
                if (epsN[ei2].num === targetEp) { target = epsN[ei2]; break; }
              }
            }
          }
          if (!target) {
            console.log(
              "[" + PROVIDER_TAG + "] ep " + targetEp + " not found in " + page.slug +
              " (max on site=" + page1Max + ")"
            );
            continue;
          }
        } else {
          var movieEps = parseEpisodes(html);
          if (movieEps.length === 0) continue;
          target = movieEps[0];
        }

        var epUrl = BASE_URL + "/video/a/" + target.id + "/";
        var epRes = yield fetchText(epUrl, { headers: { Referer: page.url } });
        if (!epRes || epRes.status !== 200) continue;

        var sx = extractStream(epRes.text);
        if (!sx) {
          console.log("[" + PROVIDER_TAG + "] no stream extracted from " + epUrl);
          continue;
        }

        // FIX #6: skip if we've already emitted this exact stream URL.
        if (seenStreamUrl[sx.url]) {
          console.log(
            "[" + PROVIDER_TAG + "] dedup: " + page.slug + " → same URL as previous, skipping"
          );
          continue;
        }
        seenStreamUrl[sx.url] = 1;

        var qMatch = sx.url.match(/(1080|720|480|360)p?/i);
        sx.quality = qMatch ? qMatch[1] + "p" : "Auto";

        console.log(
          "[" + PROVIDER_TAG + "] OK slug=" + page.slug +
          " ep=" + (target.num || "?") +
          " url=" + sx.url.substring(0, 120) +
          " rel=" + relevance
        );
        streams.push(toStream(sx, info, page.slug, season, targetEp, relevance, isDubbed));
      }

      streams.sort(function (a, b) {
        if (a._relevance !== b._relevance) return b._relevance - a._relevance;
        var aDub = /DUB/.test(a.title) ? 1 : 0;
        var bDub = /DUB/.test(b.title) ? 1 : 0;
        return bDub - aDub;
      });
      streams = streams.map(function (s) { delete s._relevance; return s; });
      if (streams.length > 4) streams = streams.slice(0, 4);

      console.log("[" + PROVIDER_TAG + "] total streams: " + streams.length);
      return streams;
    } catch (e) {
      console.log("[" + PROVIDER_TAG + "] fatal: " + (e && e.message));
      return [];
    }
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else if (typeof global !== "undefined") {
  global.getStreams = getStreams;
}
