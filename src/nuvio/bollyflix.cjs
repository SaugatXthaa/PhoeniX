// BollyFlix Scraper for Nuvio Local Scrapers
// Rewritten 2026-08-16 to target the current live domain (bollyflix.free)
// and the new post structure (<h5> + <a class="dl">).
//
// The original provider pointed at bollyflix.at, which is dead. The site
// has since moved through several domains (bollyflix.band, bollyflix.moda,
// bollyflix.one, bollyflix.free, ...). To stay resilient, BASE_URL is
// fetched lazily from a remote domains.json, with a hardcoded fallback.

"use strict";

var cheerio = require("cheerio");

var PROVIDER_NAME = "BollyFlix";
var FALLBACK_BASE_URL = "https://bollyflix.free";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var DOMAINS_URL =
  "https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json";

var DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

// ===== DOMAIN RESOLUTION =====

var domainCache = { url: FALLBACK_BASE_URL, ts: 0 };

function getBaseUrl() {
  var now = Date.now();
  if (now - domainCache.ts < 3600000) {
    // Less than 1 hour old - reuse cache.
    return Promise.resolve(domainCache.url);
  }
  return fetch(DOMAINS_URL, { headers: DEFAULT_HEADERS })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (data) {
      var hit = data && (data.bollyflix || data["bollyflix"]);
      if (hit && /^https?:\/\//.test(hit)) {
        domainCache.url = hit.replace(/\/+$/, "");
      } else {
        domainCache.url = FALLBACK_BASE_URL;
      }
      domainCache.ts = now;
      return domainCache.url;
    })
    .catch(function () {
      // Network or parse failure - keep using whatever we already had.
      domainCache.ts = now;
      return domainCache.url;
    });
}

// ===== HTTP =====
//
// Uses got-scraping for Cloudflare bypass — works on Render where curl
// is not available. Falls back to native fetch if got-scraping fails to load.

var _gotScraping = null;
async function getGotScraping() {
  if (_gotScraping) return _gotScraping;
  try {
    var mod = await import("got-scraping");
    _gotScraping = mod.gotScraping;
  } catch (e) {
    console.error("[BollyFlix] Failed to load got-scraping:", e.message);
  }
  return _gotScraping;
}

function fetchText(url, extraHeaders) {
  var headers = Object.assign({}, DEFAULT_HEADERS, extraHeaders || {});

  return getGotScraping().then(function (gotScraping) {
    if (!gotScraping) {
      // Fallback: plain fetch (will likely get CF-challenged, but try)
      return fetch(url, { headers: headers, redirect: "follow" }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
        return res.text();
      });
    }

    return gotScraping(url, {
      timeout: { request: 20000 },
      throwHttpErrors: false,
      headers: headers,
      followRedirect: true,
    }).then(function (response) {
      if (response.statusCode >= 400) {
        throw new Error("HTTP " + response.statusCode + " for " + url);
      }
      return response.body;
    });
  });
}

function getTMDBInfo(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var url =
    "https://api.themoviedb.org/3/" +
    type +
    "/" +
    tmdbId +
    "?api_key=" +
    TMDB_API_KEY;
  return fetch(url, { headers: DEFAULT_HEADERS })
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      if (!data || (data.success === false)) {
        return { title: "", year: "", totalSeasons: 0 };
      }
      var dateField = type === "tv" ? data.first_air_date : data.release_date;
      return {
        title: (type === "tv" ? data.name : data.title) || "",
        year: ((data.first_air_date || data.release_date || "") + "").split(
          "-"
        )[0],
        totalSeasons: data.number_of_seasons || 0
      };
    })
    .catch(function () {
      return { title: "", year: "", totalSeasons: 0 };
    });
}

// ===== HELPERS =====

function normalizeTitle(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseQuality(text) {
  var t = String(text).toLowerCase();
  if (/(2160p|4k|uhd)/.test(t)) return "2160p";
  if (/(1080p)/.test(t)) {
    if (/(hq|10bit|10-bit)/.test(t)) return "1080p HQ";
    return "1080p";
  }
  if (/(720p)/.test(t)) {
    if (/(10bit|10-bit)/.test(t)) return "720p 10bit";
    return "720p";
  }
  if (/(480p)/.test(t)) return "480p";
  if (/(360p)/.test(t)) return "360p";
  return "720p"; // sensible default
}

function parseFileSize(text) {
  // BollyFlix headings look like: "Inception (2010) [Hindi-English] 480p [520MB]"
  // We want the [520MB] portion.
  var match = String(text).match(/\[([0-9.]+\s*(?:GB|MB))\]/i);
  if (!match) return null;
  return match[1].replace(/\s+/g, "").toUpperCase();
}

function fileSizeToBytes(sizeStr) {
  if (!sizeStr) return 0;
  var m = sizeStr.match(/([0-9.]+)\s*(GB|MB)/i);
  if (!m) return 0;
  var num = parseFloat(m[1]);
  return /GB/i.test(m[2]) ? num * 1024 * 1024 * 1024 : num * 1024 * 1024;
}

// ===== SEARCH =====

function searchBollyFlix(title) {
  return getBaseUrl().then(function (base) {
    // BollyFlix uses WordPress. Both /?s=Query and /search/Query work.
    // /search/Query is prettier and matches the original scraper's URL.
    var query = encodeURIComponent(title).replace(/%20/g, "+");
    var searchUrl = base + "/search/" + query;
    console.log("[BollyFlix] Searching: " + searchUrl);

    return fetchText(searchUrl, { Referer: base + "/" }).then(function (html) {
      if (!html || html.length < 100) {
        console.log("[BollyFlix] Empty search response");
        return [];
      }
      var $ = cheerio.load(html);
      var results = [];
      var seen = {};

      console.log(
        "[BollyFlix] Page title: " + ($("title").text() || "").trim()
      );

      // Primary: WordPress "latestPost" article cards.
      $("article.latestPost").each(function (_, el) {
        var $art = $(el);
        var $link = $art.find("a.post-image").first();
        if (!$link.length) $link = $art.find("a").first();
        var href = $link.attr("href");
        if (!href || seen[href]) return;
        // Skip non-content pages (categories, navigation, etc.)
        if (/\/(category|tag|page|movies-by-|tv-shows|web-series|adult|anime|how-to|dmca|about|contact|privacy|terms|post-credits)\b/i.test(href)) {
          return;
        }
        var titleText =
          $link.attr("title") ||
          $art.find("h2.title").first().text() ||
          $art.find("h2 a").first().text() ||
          $link.find("img").attr("alt") ||
          "";
        titleText = String(titleText).trim();
        if (titleText.length < 3) return;
        var thumb =
          $art.find("img").attr("src") ||
          $art.find("img").attr("data-src") ||
          "";
        seen[href] = true;
        results.push({ url: href, title: titleText, thumb: thumb });
      });

      // Fallback: any anchor whose href points to a deep bollyflix path.
      if (results.length === 0) {
        $("a[href]").each(function (_, el) {
          var href = $(el).attr("href");
          if (!href || seen[href]) return;
          if (href.indexOf(base) !== 0) return;
          // Must look like a post slug, not a listing/section page.
          var rest = href.slice(base.length).replace(/^\/+|\/+$/g, "");
          if (!rest) return;
          if (/^(category|tag|page|movies-by-|tv-shows|web-series|adult|anime|how-to|dmca|about|contact|privacy|terms|post-credits|movies|feed|wp-json|wp-content|wp-includes|author|cdn-cgi|xmlrpc)/i.test(rest)) {
            return;
          }
          if (/\?s=/.test(href)) return;
          var t = $(el).attr("title") || $(el).text() || "";
          t = String(t).trim();
          if (t.length < 3) return;
          seen[href] = true;
          results.push({ url: href, title: t, thumb: "" });
        });
      }

      console.log("[BollyFlix] Found " + results.length + " search results");
      return results;
    });
  });
}

// ===== MATCHING =====

function findBestMatch(results, tmdbTitle, tmdbYear, totalSeasons, isMovie, targetSeason) {
  if (!results || results.length === 0) return null;

  var normQuery = normalizeTitle(tmdbTitle);
  var year = parseInt(tmdbYear, 10) || 0;

  var scored = results.map(function (r) {
    var raw = r.title || "";
    // BollyFlix titles often look like: "Download Inception (2010) Dual Audio [Hindi-English] Movie 480p | 720p | 1080p BluRay ESub"
    var yearMatch = raw.match(/\b(19|20)\d{2}\b/);
    var resultYear = yearMatch ? parseInt(yearMatch[0], 10) : 0;

    // Detect season in the result title (e.g. "S01", "Season 1", "Series 1").
    var seasonMatch = raw.match(/\bS(?:eason\s*)?(\d{1,2})\b/i);
    var resultSeason = seasonMatch ? parseInt(seasonMatch[1], 10) : 0;

    // Strip everything from the year onwards to get the bare title.
    var bareTitle = raw
      .replace(/^Download\s+/i, "")
      .replace(/\s*[\(\[]?(19|20)\d{2}[\)\]]?.*$/i, "")
      .trim();
    var normBare = normalizeTitle(bareTitle);

    var score = 0;
    if (normBare === normQuery) score += 100;
    else if (normBare.indexOf(normQuery) === 0 || normQuery.indexOf(normBare) === 0)
      score += 70;
    else if (normBare && normQuery && normBare.split(" ").slice(0, 3).join(" ") === normQuery.split(" ").slice(0, 3).join(" "))
      score += 35;
    else if (normBare.indexOf(normQuery.split(" ")[0]) !== -1) score += 10;

    if (year && resultYear && year === resultYear) score += 30;
    else if (year && resultYear && Math.abs(year - resultYear) <= 1) score += 15;

    // For TV shows: prefer titles that contain S01 / Season 1 / Series
    if (!isMovie) {
      // Strongly prefer the requested season when one is specified.
      if (targetSeason && resultSeason) {
        if (resultSeason === targetSeason) score += 60;
        else score -= 40; // wrong season -> big penalty
      }
      // Generic bonus for any season marker.
      if (/\bS\d{2}\b|\bSeason\s*\d+\b|\bSeries\b/i.test(raw)) score += 10;
      // Penalize obvious movie-only markers.
      if (!/\bS\d{2}\b/i.test(raw) && /\bMovie\b/i.test(raw)) score -= 5;
    } else {
      if (/\bMovie\b/i.test(raw)) score += 5;
      if (/\bS\d{2}\b|\bSeason\s*\d+\b|\bWEB Series\b/i.test(raw)) score -= 20;
    }

    return { result: r, score: score, year: resultYear, bare: bareTitle };
  });

  scored.sort(function (a, b) {
    return b.score - a.score;
  });

  var best = scored[0];
  if (!best || best.score < 30) {
    console.log(
      "[BollyFlix] No confident match. Top candidate: " +
        (best ? best.bare + " (score=" + best.score + ")" : "none")
    );
    return null;
  }
  console.log(
    "[BollyFlix] Matched: " + best.bare + " (" + (best.year || "?") + ") score=" + best.score
  );
  return best.result;
}

// ===== DOWNLOAD LINK EXTRACTION =====

// Given the HTML of a BollyFlix post, walk every <h4>/<h5> heading and grab
// the first download link that follows it. BollyFlix uses two layouts:
//
//   1. Single-title posts (movies or single-season bundles):
//        <h5>Inception (2010) [Hindi-English] 480p [520MB]</h5>
//        <p><a class="dl" href="https://dl.fastdlserver.site/...">🚀 GDrive</a></p>
//
//   2. Complete-series bundles:
//        <h4>Breaking Bad (Season 1) {Hindi-English} 480p [225MB/E]</h4>
//        <p><a class="maxbutton-2 maxbutton maxbutton-download-links"
//              href="https://fxlinks.rest/elinks/...">Download Links</a></p>
function extractDownloadLinks(html, targetSeason, targetEpisode) {
  var $ = cheerio.load(html);
  var links = [];

  $("h4, h5").each(function (_, el) {
    var $h = $(el);
    var heading = $h.text().trim();
    if (!heading) return;

    // Only consider headings that contain a quality marker.
    if (!/(480p|720p|1080p|2160p|4k|uhd)/i.test(heading)) return;

    var quality = parseQuality(heading);
    var size = parseFileSize(heading);
    if (!size) {
      // Try the per-episode form [225MB/E] -> "225MB/E"
      var perEp = heading.match(/\[([0-9.]+\s*(?:GB|MB))\/E\]/i);
      if (perEp) size = perEp[1].replace(/\s+/g, "").toUpperCase() + "/E";
    }

    // Detect season. Support: S01, S1, Season 1, (Season 1)
    var seasonMatch = heading.match(/\bS(?:eason\s*)?(\d{1,2})\b/i);
    var episodeMatch = heading.match(/\bE(?:pisode\s*)?(\d{1,3})\b/i);
    // Don't pick up "ESub" as E1.
    if (episodeMatch && /esub/i.test(heading)) episodeMatch = null;
    var seasonNum = seasonMatch ? parseInt(seasonMatch[1], 10) : null;
    var episodeNum = episodeMatch ? parseInt(episodeMatch[1], 10) : null;

    // If we're looking for a specific season/episode, filter on it.
    if (targetSeason) {
      if (seasonNum && seasonNum !== targetSeason) return;
      if (episodeNum && targetEpisode && episodeNum !== targetEpisode) return;
    }

    // Find the next download link in document order, stopping at the next
    // heading. Support both the "dl" class and the "maxbutton-download-links"
    // class used by complete-series bundles.
    var $next = $h.next();
    var href = null;
    var label = null;
    var safety = 0;
    while ($next.length && safety < 20) {
      if ($next.is("h4, h5")) break;
      var $candidate = $next.find('a.dl, a.maxbutton-download-links, a[class*="maxbutton"]').first();
      if (!$candidate.length) $candidate = $next.filter('a.dl, a.maxbutton-download-links, a[class*="maxbutton"]').first();
      if ($candidate.length) {
        href = $candidate.attr("href");
        label = $candidate.text().trim();
        break;
      }
      $next = $next.next();
      safety++;
    }

    if (!href) return;

    // Decode HTML entities (&amp; -> &).
    href = href.replace(/&amp;/g, "&");

    links.push({
      heading: heading,
      quality: quality,
      size: size,
      url: href,
      source: /fastdlserver/.test(href)
        ? "GDrive"
        : /linksmod/.test(href)
        ? "LinksMod"
        : /fxlinks/.test(href)
        ? "EpisodeList"
        : "Other",
      season: seasonNum,
      episode: episodeNum,
      label: label
    });
  });

  // De-duplicate by URL.
  var seen = {};
  return links.filter(function (l) {
    if (seen[l.url]) return false;
    seen[l.url] = true;
    return true;
  });
}

// ===== MAIN ENTRY =====

function getStreams(tmdbId, mediaType, season, episode) {
  var isMovie = mediaType !== "tv";
  var targetSeason = season ? parseInt(season, 10) : null;
  var targetEpisode = episode ? parseInt(episode, 10) : null;

  console.log(
    "[BollyFlix] Request: tmdb=" +
      tmdbId +
      " type=" +
      mediaType +
      (isMovie ? "" : " S" + (targetSeason || "?") + "E" + (targetEpisode || "?"))
  );

  return getTMDBInfo(tmdbId, mediaType)
    .then(function (info) {
      if (!info.title) {
        console.log("[BollyFlix] Could not resolve TMDB info for " + tmdbId);
        return [];
      }
      console.log("[BollyFlix] TMDB: " + info.title + " (" + info.year + ")");

      return searchBollyFlix(info.title).then(function (results) {
        if (!results.length) {
          console.log("[BollyFlix] No search results for: " + info.title);
          return [];
        }
        var match = findBestMatch(
          results,
          info.title,
          info.year,
          info.totalSeasons,
          isMovie,
          targetSeason
        );
        if (!match) return [];

        return getBaseUrl().then(function (base) {
          return fetchText(match.url, { Referer: base + "/" }).then(function (
            postHtml
          ) {
            var links = extractDownloadLinks(
              postHtml,
              targetSeason,
              targetEpisode
            );
            if (!links.length) {
              console.log("[BollyFlix] No download links in post: " + match.url);
              return [];
            }
            console.log(
              "[BollyFlix] Extracted " +
                links.length +
                " download links from post"
            );

            // For TV: prefer links that explicitly match the requested season.
            if (!isMovie && targetSeason) {
              var seasonSpecific = links.filter(function (l) {
                return l.season === targetSeason;
              });
              if (seasonSpecific.length) links = seasonSpecific;
            }

            // De-duplicate by quality, keeping the first occurrence (which is
            // typically the GDrive link rather than the LinksMod shortlink).
            var byQuality = {};
            var picked = [];
            links.forEach(function (l) {
              if (byQuality[l.quality]) return;
              byQuality[l.quality] = true;
              picked.push(l);
            });

            return picked.map(function (l) {
              var titleLine = info.title;
              if (!isMovie) {
                titleLine +=
                  " S" + String(targetSeason || l.season || 1).padStart(2, "0");
                if (targetEpisode || l.episode) {
                  titleLine +=
                    "E" +
                    String(targetEpisode || l.episode || 1).padStart(2, "0");
                }
              }
              titleLine += " (" + info.year + ")";
              if (l.size) titleLine += " " + l.size;
              if (l.source === "LinksMod") titleLine += " [shortlink]";

              return {
                name: PROVIDER_NAME + " - " + l.quality + " " + l.source,
                title: titleLine,
                url: l.url,
                quality: l.quality,
                size: l.size || undefined,
                behaviorHints: {
                  bingeGroup: "bollyflix-" + l.quality,
                  headers: {
                    "User-Agent": DEFAULT_HEADERS["User-Agent"],
                    Referer: "https://bollyflix.free/"
                  }
                }
              };
            });
          });
        });
      });
    })
    .catch(function (err) {
      console.log("[BollyFlix] Error: " + (err && err.message ? err.message : err));
      return [];
    });
}

module.exports = { getStreams: getStreams };
