// HDHub4u Scraper for Nuvio Local Scrapers
// Updated 2026-08-18 — uses shared hub_extractor module.
//
// FLOW:
//   1. Search new1.hdhub4u.af/search/<title> → find movie/TV post URL
//   2. Fetch post → parse quality headings (h3/h4) with download links
//   3. For each link: use hub_extractor.resolveDownloadUrl() → direct GDrive URL
//      - hubcdn.sbs links → base64 decode → GDrive URL ✅
//      - hubcloud.* links → gamerxyt chain → GDrive URL ✅
//      - pixeldrain links → direct download API ✅
//      - greenmountmotors.com links → needs JS execution ❌ (skipped)
//      - hubdrive.tips links → needs auth ❌ (skipped)
//   4. Return streams with quality + direct GDrive URL
//
// No Playwright, no FlareSolverr — uses hub_extractor (got-scraping + curl + fetch).

"use strict";

var cheerio = require("cheerio");
var he = require("./hub_extractor.cjs");

var PROVIDER_NAME = "HDHub4u";
var BASE_URL = "https://new1.hdhub4u.af";
var DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";

var USER_AGENT = he.USER_AGENT;
var DEFAULT_HEADERS = he.FULL_HEADERS;

// ===== DOMAIN RESOLUTION =====

var domainCache = { url: BASE_URL, ts: 0 };

function getBaseUrl() {
  var now = Date.now();
  if (now - domainCache.ts < 3600000) {
    return Promise.resolve(domainCache.url);
  }
  return fetch(DOMAINS_URL, { headers: { "User-Agent": "Mozilla/5.0" } })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var hit = data && (data["HDHUB4u"] || data["hdhub4u"]);
      if (hit && /^https?:\/\//.test(hit)) {
        domainCache.url = hit.replace(/\/+$/, "");
      }
      domainCache.ts = now;
      return domainCache.url;
    })
    .catch(function () {
      domainCache.ts = now;
      return domainCache.url;
    });
}

// ===== HTTP =====

function fetchText(url, extraHeaders) {
  var headers = Object.assign({}, DEFAULT_HEADERS, extraHeaders || {});
  return fetch(url, { headers: headers, redirect: "follow" })
    .then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      return res.text();
    });
}

// ===== TMDB =====

function getTMDBInfo(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var url = "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  return fetchText(url)
    .then(function (body) {
      var d = JSON.parse(body);
      if (!d || d.success === false) return null;
      return {
        title: type === "tv" ? d.name : d.title,
        year: ((d.first_air_date || d.release_date || "") + "").split("-")[0],
        type: type
      };
    })
    .catch(function () { return null; });
}

// ===== SEARCH =====

function normalizeTitle(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function searchHDHub4u(title) {
  return getBaseUrl().then(function (base) {
    var searchUrl = base + "/search/" + encodeURIComponent(title);
    console.log("[HDHub4u] Searching: " + searchUrl);
    return fetchText(searchUrl, { Referer: base + "/" }).then(function (html) {
      var $ = cheerio.load(html);
      var results = [];

      $("a[href]").each(function (_, el) {
        var href = $(el).attr("href") || "";
        var text = $(el).text().trim();
        if (href.indexOf(base) !== -1 && text.length > 5 && text.length < 300) {
          if (!href.match(/\/(category|tag|page|about|contact|privacy|terms|dmca|wp-|feed|comments|how-to|request|join|disclaimer)/i)) {
            if (text.match(/(19|20)\d{2}|4k|1080p|720p|480p|bluray|web-?dl|webrip/i)) {
              results.push({ url: href, title: text });
            }
          }
        }
      });

      var seen = {};
      results = results.filter(function (r) {
        if (seen[r.url]) return false;
        seen[r.url] = true;
        return true;
      });

      console.log("[HDHub4u] Found " + results.length + " search results");
      return results;
    });
  });
}

function findBestMatch(results, tmdbTitle, tmdbYear, isMovie) {
  if (!results || !results.length) return null;
  var normQuery = normalizeTitle(tmdbTitle);
  var y = parseInt(tmdbYear, 10) || 0;
  var scored = results.map(function (r) {
    var raw = r.title || "";
    var yearMatch = raw.match(/\b(19|20)\d{2}\b/);
    var resultYear = yearMatch ? parseInt(yearMatch[0], 10) : 0;
    var bare = raw.replace(/\s*[\(\[]?(19|20)\d{2}[\)\]]?.*$/i, "").trim();
    var normBare = normalizeTitle(bare);
    var score = 0;
    if (normBare === normQuery) score += 100;
    else if (normBare.indexOf(normQuery) === 0 || normQuery.indexOf(normBare) === 0) score += 70;
    else if (normBare.split(" ").slice(0, 3).join(" ") === normQuery.split(" ").slice(0, 3).join(" ")) score += 40;
    if (y && resultYear && y === resultYear) score += 30;
    var isSeriesPost = /series|s\d{2}|season/i.test(raw);
    if (isMovie && !isSeriesPost) score += 10;
    if (!isMovie && isSeriesPost) score += 10;
    return { result: r, score: score, bare: bare };
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  var best = scored[0];
  if (best && best.score >= 30) {
    console.log("[HDHub4u] Matched: " + best.bare + " (score=" + best.score + ")");
    return best.result;
  }
  return null;
}

// ===== DOWNLOAD LINK EXTRACTION =====

function parseQuality(heading) {
  var t = String(heading || "").toLowerCase();
  if (t.indexOf("2160p") !== -1 || t.indexOf("4k") !== -1 || t.indexOf("uhd") !== -1) return "2160p";
  if (t.indexOf("1080p") !== -1) return "1080p";
  if (t.indexOf("720p") !== -1) return "720p";
  if (t.indexOf("480p") !== -1) return "480p";
  return "HD";
}

function parseCodec(heading) {
  var t = String(heading || "").toLowerCase();
  if (/10bit|10-bit|hevc|x265|h265/i.test(t)) return "H265 10bit";
  if (/x264|h264/i.test(t)) return "H264";
  return "HEVC";
}

function parseSize(heading) {
  var m = String(heading || "").match(/\[?([0-9.]+\s*(?:GB|MB))\]?/i);
  return m ? m[1].replace(/\s+/g, "") : null;
}

function parseLanguage(heading) {
  var t = String(heading || "");
  var langs = [];
  if (/hindi/i.test(t)) langs.push("Hindi");
  if (/english/i.test(t)) langs.push("English");
  if (/tamil/i.test(t)) langs.push("Tamil");
  if (/telugu/i.test(t)) langs.push("Telugu");
  return langs.length ? langs.join("+") : "Multi";
}

// Extract all download links from the post HTML.
// Supports: hubcdn.sbs, hubcloud.*, hubdrive.tips, pixeldrain, greenmountmotors.com
function extractDownloadLinks(html, targetSeason, targetEpisode) {
  var $ = cheerio.load(html);
  var links = [];

  // Find quality headings with download links
  $("h3, h4, h5").each(function (_, el) {
    var $h = $(el);
    var heading = $h.text().trim();
    if (!heading.match(/480p|720p|1080p|2160p|4k|uhd/i)) return;

    // For TV: check if this matches the requested SxxExx
    if (targetSeason && targetEpisode) {
      var sxxexx = heading.match(/S(\d{2})E(\d{2})/i);
      if (sxxexx) {
        if (parseInt(sxxexx[1], 10) !== targetSeason || parseInt(sxxexx[2], 10) !== targetEpisode) return;
      }
    }

    // Find the download link — it's INSIDE the heading or in the next element
    var $links = $h.find("a[href]");
    if ($links.length === 0) {
      $links = $h.next().find("a[href]");
    }

    $links.each(function (_, a) {
      var href = $(a).attr("href") || "";
      var quality = parseQuality(heading);
      var codec = parseCodec(heading);
      var size = parseSize(heading);
      var lang = parseLanguage(heading);

      // Determine link type and whether it's resolvable
      var linkType = "unknown";
      var resolvable = false;

      if (href.indexOf("hubcdn.sbs") !== -1) {
        linkType = "hubcdn";
        resolvable = true;
      } else if (href.match(/hubcloud\.[a-z]+\/drive\//)) {
        linkType = "hubcloud";
        resolvable = true;
      } else if (href.match(/pixeldrain\.(?:com|dev)\/[ul]\//)) {
        linkType = "pixeldrain";
        resolvable = true;
      } else if (href.indexOf("hubdrive.tips") !== -1 || href.indexOf("hubdrive.cc") !== -1) {
        linkType = "hubdrive";
        resolvable = false; // requires auth
      } else if (href.indexOf("greenmountmotors") !== -1) {
        linkType = "greenmountmotors";
        resolvable = false; // requires JS execution
      } else if (href.indexOf("hdstream4u") !== -1) {
        linkType = "hdstream4u";
        resolvable = false;
      } else if (href.indexOf("hubstream") !== -1) {
        linkType = "hubstream";
        resolvable = false;
      } else if (href.indexOf("video-downloads.googleusercontent.com") !== -1) {
        linkType = "gdrive";
        resolvable = true; // already direct
      }

      links.push({
        url: href,
        heading: heading,
        quality: quality,
        codec: codec,
        size: size,
        language: lang,
        linkType: linkType,
        resolvable: resolvable
      });
    });
  });

  // De-duplicate by URL
  var seen = {};
  links = links.filter(function (l) {
    if (seen[l.url]) return false;
    seen[l.url] = true;
    return true;
  });

  // De-duplicate by quality+codec (keep first per quality)
  var byKey = {};
  var unique = [];
  links.forEach(function (l) {
    var key = l.quality + "|" + l.codec;
    if (!byKey[key]) {
      byKey[key] = true;
      unique.push(l);
    }
  });

  console.log("[HDHub4u] Extracted " + unique.length + " download links (" +
    unique.filter(function(l) { return l.resolvable; }).length + " resolvable, " +
    unique.filter(function(l) { return !l.resolvable; }).length + " not resolvable)");

  return unique;
}

// ===== MAIN ENTRY =====

function getStreams(tmdbId, type, season, episode) {
  var isMovie = type !== "tv";
  var targetSeason = season ? parseInt(season, 10) : null;
  var targetEpisode = episode ? parseInt(episode, 10) : null;

  console.log(
    "[HDHub4u] Request: tmdb=" + tmdbId + " type=" + type +
    (isMovie ? "" : " S" + season + "E" + episode)
  );

  return getTMDBInfo(tmdbId, type)
    .then(function (info) {
      if (!info || !info.title) {
        console.log("[HDHub4u] Could not resolve TMDB info");
        return [];
      }
      console.log("[HDHub4u] TMDB: " + info.title + " (" + info.year + ")");

      return searchHDHub4u(info.title).then(function (results) {
        if (!results.length) return [];
        var match = findBestMatch(results, info.title, info.year, isMovie);
        if (!match) {
          console.log("[HDHub4u] No matching post found");
          return [];
        }

        return getBaseUrl().then(function (base) {
          return fetchText(match.url, { Referer: base + "/" }).then(function (postHtml) {
            var links = extractDownloadLinks(postHtml, targetSeason, targetEpisode);
            if (!links.length) return [];

            // Log all link types for debugging
            links.forEach(function (l) {
              console.log("[HDHub4u] " + l.quality + " " + l.codec + " [" + l.linkType + "] " +
                (l.resolvable ? "✓ resolvable" : "✗ not resolvable") +
                (l.size ? " " + l.size : ""));
            });

            // Only resolve resolvable links
            var resolvable = links.filter(function (l) { return l.resolvable; });
            if (!resolvable.length) {
              console.log("[HDHub4u] No resolvable links found");
              return [];
            }

            // Resolve each link using the shared hub_extractor
            return Promise.all(resolvable.map(function (l) {
              return he.resolveDownloadUrl(l.url)
                .then(function (gdriveUrl) {
                  if (!gdriveUrl) return null;
                  return Object.assign({}, l, { gdriveUrl: gdriveUrl });
                })
                .catch(function (err) {
                  console.log("[HDHub4u] Failed to resolve " + l.url.slice(0, 60) + ": " + err.message);
                  return null;
                });
            })).then(function (resolved) {
              return resolved.filter(function (r) { return r !== null && r.gdriveUrl; });
            });
          }).then(function (resolvedLinks) {
            return resolvedLinks.map(function (l) {
              var titleLine = info.title;
              if (!isMovie) {
                titleLine += " S" + String(targetSeason || 1).padStart(2, "0") +
                             "E" + String(targetEpisode || 1).padStart(2, "0");
              }
              titleLine += " (" + info.year + ")";
              titleLine += " " + l.quality + " " + l.codec;
              if (l.size) titleLine += " [" + l.size + "]";
              titleLine += " [" + l.language + "]";

              return {
                name: PROVIDER_NAME + " - " + l.quality + " " + l.codec + " [" + l.language + "]",
                title: titleLine,
                url: l.gdriveUrl,
                quality: l.quality,
                type: "video/mkv",
                headers: {
                  "User-Agent": USER_AGENT
                },
                behaviorHints: {
                  bingeGroup: "hdhub4u-" + l.quality
                }
              };
            });
          });
        });
      });
    })
    .catch(function (err) {
      console.log("[HDHub4u] Error: " + (err && err.message ? err.message : err));
      return [];
    });
}

module.exports = { getStreams: getStreams };
