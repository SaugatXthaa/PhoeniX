// HDHub4u Scraper — Returns direct playable GDrive streams
// =================================================================
// Scrapes new1.hdhub4u.af → hubcloud.cx/drive/{id} → GDrive
//
// Flow:
//   1. Search via /search/{title} → find movie/TV post URL
//   2. Fetch post page → parse quality headings (h3/h4/h5) with download links
//   3. For each hubcloud.cx/drive/{id} link: resolve via hub_extractor.resolveHubcloudUrl()
//      → hubcloud → gamerxyt → pixel.hubcloud.cx → workers.dev → googleusercontent
//   4. Return direct video-downloads.googleusercontent.com URL (playable)
//
// Uses got-scraping for Cloudflare bypass on Render.
// Uses the FULL hub_extractor.cjs (not the stub) for real GDrive resolution.

"use strict";

var cheerio = require("cheerio");
var hubExtractor = require("./hub_extractor.cjs");

var PROVIDER_NAME = "HDHub4u";
var BASE_URL = "https://new1.hdhub4u.af";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// got-scraping loader (Chrome TLS fingerprint — bypasses CF on Render)
var _gotScraping = null;
async function getGotScraping() {
  if (_gotScraping) return _gotScraping;
  try {
    var mod = await import("got-scraping");
    _gotScraping = mod.gotScraping;
  } catch (e) {
    console.error("[HDHub4u] Failed to load got-scraping:", e.message);
    _gotScraping = false;
  }
  return _gotScraping;
}

function fetchText(url, referer) {
  var headers = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*" };
  if (referer) headers["Referer"] = referer;

  return getGotScraping().then(function (gs) {
    if (gs) {
      return gs.get(url, {
        headers: headers,
        timeout: { request: 15000 },
        throwHttpErrors: false,
        followRedirect: true,
        http2: false,
      }).then(function (res) {
        if (res.statusCode >= 400) throw new Error("HTTP " + res.statusCode);
        return res.body;
      });
    }
    // Fallback: plain fetch
    return fetch(url, { headers: headers, redirect: "follow" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      });
  });
}

function getTMDBInfo(tmdbId, type) {
  var endpoint = type === "tv" ? "tv" : "movie";
  var url = "https://api.themoviedb.org/3/" + endpoint + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  return fetchText(url)
    .then(function (body) {
      var d = JSON.parse(body);
      if (!d || d.success === false) return null;
      return {
        title: type === "tv" ? d.name : d.title,
        year: parseInt((d.first_air_date || d.release_date || "").slice(0, 4)) || null,
      };
    })
    .catch(function () { return null; });
}

// Normalize for fuzzy title matching
function normalizeTitle(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Search via /search/{title}
function findMoviePage(title, year) {
  var searchUrl = BASE_URL + "/search/" + encodeURIComponent(title);
  console.log("[HDHub4u] Searching: " + searchUrl);
  return fetchText(searchUrl, BASE_URL + "/")
    .then(function (html) {
      var $ = cheerio.load(html);
      var results = [];

      $("a[href]").each(function (_, el) {
        var href = $(el).attr("href") || "";
        var text = $(el).text().trim();
        if (href.indexOf(BASE_URL) !== -1 && text.length > 5 && text.length < 300) {
          // Skip non-movie links
          if (!href.match(/\/(category|tag|page|about|contact|privacy|terms|dmca|wp-|feed|comments|how-to|request|join|disclaimer)/i)) {
            // Only include links that look like movie/series posts
            if (text.match(/(19|20)\d{2}|4k|1080p|720p|480p|bluray|web-?dl|webrip|uhd/i)) {
              results.push({ url: href, title: text });
            }
          }
        }
      });

      // De-duplicate
      var seen = {};
      results = results.filter(function (r) {
        if (seen[r.url]) return false;
        seen[r.url] = true;
        return true;
      });

      console.log("[HDHub4u] Found " + results.length + " search results");

      // Find best match by title + year
      var normQuery = normalizeTitle(title);
      var y = year ? parseInt(year, 10) || 0 : 0;
      var bestMatch = null;
      var bestScore = 0;

      results.forEach(function (r) {
        var raw = r.title || "";
        var yearMatch = raw.match(/\b(19|20)\d{2}\b/);
        var resultYear = yearMatch ? parseInt(yearMatch[0], 10) : 0;
        // Strip year and quality info from title for matching
        var bare = raw.replace(/\s*[\(\[]?(19|20)\d{2}[\)\]]?.*$/i, "").trim();
        var normBare = normalizeTitle(bare);
        var score = 0;
        if (normBare === normQuery) score = 100;
        else if (normBare.indexOf(normQuery) !== -1 || normQuery.indexOf(normBare) !== -1) {
          score = Math.min(normBare.length, normQuery.length) / Math.max(normBare.length, normQuery.length) * 80;
        }
        if (y && resultYear && Math.abs(y - resultYear) <= 1) score += 30;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = r;
        }
      });

      if (bestMatch && bestScore >= 40) {
        console.log("[HDHub4u] Matched: " + bestMatch.title.slice(0, 60) + " (score=" + bestScore + ")");
        return bestMatch.url;
      }
      console.log("[HDHub4u] No matching page found (best score=" + bestScore + ")");
      return null;
    });
}

// Parse quality from heading text
function parseQuality(heading) {
  var t = String(heading || "").toLowerCase();
  if (t.indexOf("2160p") !== -1 || t.indexOf("4k") !== -1 || t.indexOf("uhd") !== -1) return "2160p";
  if (t.indexOf("1080p") !== -1) return "1080p";
  if (t.indexOf("720p") !== -1) return "720p";
  if (t.indexOf("480p") !== -1) return "480p";
  return "HD";
}

// Parse codec from heading text
function parseCodec(heading) {
  var t = String(heading || "").toLowerCase();
  if (/10bit|10-bit|hevc|x265|h265/i.test(t)) return "HEVC 10bit";
  if (/x264|h264/i.test(t)) return "x264";
  return "HEVC";
}

// Parse file size from heading text
function parseSize(heading) {
  var m = String(heading || "").match(/\[?([0-9.]+\s*(?:GB|MB))\]?/i);
  return m ? m[1].replace(/\s+/g, "") : "";
}

// Parse language from heading text
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
// Finds hubcloud.cx/drive/{id} links with quality headings.
function extractDownloadLinks(html, targetSeason, targetEpisode) {
  var $ = cheerio.load(html);
  var links = [];

  // Find ALL <a> tags with hubcloud.cx/drive/ hrefs directly
  // This is more reliable than searching headings — the links may be
  // inside various container types (h3, h4, p, div, span, etc.)
  $("a[href]").each(function (_, el) {
    var href = $(el).attr("href") || "";
    if (!href.match(/hubcloud\.[a-z]+\/drive\//)) return;

    // Get the link text and parent heading for quality/size info
    var linkText = $(el).text().trim();
    // Walk up to find the closest heading or quality context
    var $parent = $(el).closest("h3, h4, h5, h6, p, div, li, td");
    var heading = $parent.text().trim() || linkText;

    // For TV: check if this matches the requested SxxExx
    if (targetSeason && targetEpisode) {
      var sxxexx = heading.match(/S(\d{2})E(\d{2})/i);
      if (sxxexx) {
        if (parseInt(sxxexx[1], 10) !== targetSeason || parseInt(sxxexx[2], 10) !== targetEpisode) return;
      }
    }

    // Use link text if it has quality info, otherwise use heading
    var qualitySource = linkText.match(/480p|720p|1080p|2160p|4k|uhd/i) ? linkText : heading;

    links.push({
      url: href,
      heading: heading,
      linkText: linkText,
      quality: parseQuality(qualitySource),
      codec: parseCodec(qualitySource),
      size: parseSize(qualitySource),
      language: parseLanguage(heading + " " + linkText),
    });
  });

  // De-duplicate by URL
  var seen = {};
  links = links.filter(function (l) {
    if (seen[l.url]) return false;
    seen[l.url] = true;
    return true;
  });

  console.log("[HDHub4u] Extracted " + links.length + " hubcloud download links");
  links.forEach(function (l) {
    console.log("[HDHub4u] " + l.quality + " " + l.codec + " [" + l.language + "]" + (l.size ? " " + l.size : ""));
  });

  return links;
}

function getStreams(tmdbId, type, season, episode) {
  var isMovie = type !== "tv";
  var targetSeason = season ? parseInt(season, 10) : null;
  var targetEpisode = episode ? parseInt(episode, 10) : null;

  console.log("[HDHub4u] Request: tmdb=" + tmdbId + " type=" + type +
    (isMovie ? "" : " S" + season + "E" + episode));

  return getTMDBInfo(tmdbId, type)
    .then(function (info) {
      if (!info || !info.title) {
        console.log("[HDHub4u] Could not resolve TMDB info");
        return [];
      }
      console.log("[HDHub4u] TMDB: " + info.title + " (" + info.year + ")");

      return findMoviePage(info.title, info.year).then(function (pageUrl) {
        if (!pageUrl) {
          return [];
        }
        console.log("[HDHub4u] Found page: " + pageUrl.slice(0, 60));

        return fetchText(pageUrl, BASE_URL + "/").then(function (postHtml) {
          var links = extractDownloadLinks(postHtml, targetSeason, targetEpisode);
          if (!links.length) {
            console.log("[HDHub4u] No hubcloud links found");
            return [];
          }

          // Resolve each hubcloud URL via hub_extractor.resolveHubcloudUrl()
          // This goes through the full chain:
          //   hubcloud.cx → gamerxyt.com → pixel.hubcloud.cx → workers.dev → googleusercontent
          // The HubCloud page has FSL, FSLv2, PixelDrain, 10Gbps, Download File buttons.
          // hub_extractor.resolveHubcloudUrl() follows the chain and returns the
          // googleusercontent.com URL (which is directly playable).
          return Promise.all(links.map(function (l) {
            return hubExtractor.resolveHubcloudUrl(l.url)
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
          console.log("[HDHub4u] Returning " + resolvedLinks.length + " playable streams");
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
                "User-Agent": UA
              },
              behaviorHints: {
                bingeGroup: "hdhub4u-" + l.quality
              }
            };
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
