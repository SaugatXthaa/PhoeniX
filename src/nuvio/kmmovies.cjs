// KMMovies Scraper — uses curl for CF-protected kmmovies.online,
// got-scraping for other hosts (magiclinks, hubcloud, gamerxyt).

"use strict";

var cheerio = require("cheerio");

var PROVIDER_NAME = "KMMovies";
var BASE_URL = "https://kmmovies.online";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";

var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

var FULL_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Ch-Ua": '"Chromium";v="147", "Not?A_Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1"
};

// ===== HTTP =====
// Uses native fetch() — the source wrapper overrides globalThis.fetch with
// got-scraping (http2: false) for Cloudflare bypass on Render.
// For kmmovies.online URLs, routes through the addon's /proxy endpoint
// (set via KM_PROXY_URL env var) which reliably bypasses CF.
function fetchText(url, extraHeaders) {
  var headers = Object.assign({}, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'Accept': '*/*' }, extraHeaders || {});

  // Route kmmovies.online requests through the addon's /proxy endpoint
  // (set by the source wrapper via KM_PROXY_URL env var).
  // This uses the main process's got-scraping instance which can bypass CF.
  var proxyUrl = process.env.KM_PROXY_URL;
  if (proxyUrl && url.indexOf("kmmovies") !== -1) {
    var proxiedUrl = proxyUrl + '?url=' + encodeURIComponent(url);
    return fetch(proxiedUrl, { headers: { 'Accept': 'application/json,text/html,*/*' }, redirect: "follow" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status + " for " + url + " (via proxy)");
        return res.text();
      });
  }

  return fetch(url, { headers: headers, redirect: "follow" }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return res.text();
  });
}

// ===== TMDB =====

function getTMDBInfo(tmdbId, mediaType) {
  var type = mediaType === "tv" ? "tv" : "movie";
  var url = "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  return fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
    .then(function (r) { return r.text(); })
    .then(function (body) {
      var d = JSON.parse(body);
      if (!d || d.success === false) return null;
      return {
        title: type === "tv" ? d.name : d.title,
        year: ((d.first_air_date || d.release_date || "") + "").split("-")[0]
      };
    })
    .catch(function () { return null; });
}

// ===== SEARCH =====

function normalizeTitle(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function searchKMMovies(title) {
  // Use WP REST API (bypasses Cloudflare — JSON API is not CF-challenged)
  var apiUrl = BASE_URL + "/wp-json/wp/v2/posts?search=" + encodeURIComponent(title) + "&per_page=10";
  console.log("[KMMovies] Searching WP REST API: " + apiUrl);
  return fetchText(apiUrl)
    .then(function (body) {
      var posts;
      try { posts = JSON.parse(body); } catch (e) { return []; }
      if (!Array.isArray(posts)) return [];

      var results = [];
      var normTitle = normalizeTitle(title);

      for (var i = 0; i < posts.length; i++) {
        var post = posts[i];
        var postTitle = post.title && post.title.rendered ? post.title.rendered : "";
        var link = post.link || "";
        if (!link) continue;
        var titleNorm = normalizeTitle(postTitle);
        // Check if the post title contains the search query
        if (titleNorm.indexOf(normTitle.split(" ")[0]) !== -1 || normTitle.indexOf(titleNorm.split(" ")[0]) !== -1) {
          results.push({ url: link, title: postTitle });
        }
      }

      var seen = {};
      results = results.filter(function (r) {
        if (seen[r.url]) return false;
        seen[r.url] = true;
        return true;
      });

      console.log("[KMMovies] Found " + results.length + " search results");
      return results;
    });
}

function findBestMatch(results, tmdbTitle, tmdbYear) {
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
    return { result: r, score: score, bare: bare };
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  var best = scored[0];
  if (best && best.score >= 30) {
    console.log("[KMMovies] Matched: " + best.bare + " (score=" + best.score + ")");
    return best.result;
  }
  return null;
}

// ===== DOWNLOAD LINK EXTRACTION =====

function parseQuality(text) {
  var t = String(text || "").toLowerCase();
  if (t.indexOf("2160p") !== -1 || t.indexOf("4k") !== -1 || t.indexOf("uhd") !== -1) return "2160p";
  if (t.indexOf("1080p") !== -1) return "1080p";
  if (t.indexOf("720p") !== -1) return "720p";
  if (t.indexOf("480p") !== -1) return "480p";
  return "HD";
}

function parseSize(text) {
  var m = String(text || "").match(/([0-9.]+\s*(?:GB|MB))/i);
  return m ? m[1].replace(/\s+/g, "") : null;
}

function extractDownloadLinks(html) {
  var $ = cheerio.load(html);
  var links = [];

  $("a[href*='magiclinks.lol']").each(function (_, el) {
    var href = $(el).attr("href") || "";
    var text = $(el).text().trim().replace(/\s+/g, " ");
    var quality = parseQuality(text);
    var size = parseSize(text);
    links.push({ url: href, quality: quality, size: size, text: text });
  });

  var seen = {};
  links = links.filter(function (l) {
    if (seen[l.url]) return false;
    seen[l.url] = true;
    return true;
  });

  console.log("[KMMovies] Extracted " + links.length + " download links");
  return links;
}

// ===== MAGICLINKS → HUBCLOUD RESOLUTION =====

function resolveMagiclinksUrl(magiclinksUrl) {
  return fetchText(magiclinksUrl)
    .then(function (html) {
      var match = html.match(/https:\/\/hubcloud\.[a-z]+\/drive\/[a-zA-Z0-9_]+/);
      if (!match) throw new Error("No hubcloud link found on magiclinks page");
      return match[0];
    });
}

function resolveHubcloudUrl(hubcloudUrl) {
  return fetchText(hubcloudUrl)
    .then(function (html) {
      var match = html.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/);
      if (!match) throw new Error("No gamerxyt URL found");
      return match[1];
    })
    .then(function (gamerxytUrl) {
      return fetchText(gamerxytUrl, { Referer: "https://hubcloud.cx/" });
    })
    .then(function (gamerxytHtml) {
      var match = gamerxytHtml.match(/https:\/\/pixel\.hubcloud\.cx\/\?id=[^"'\s]+/);
      if (!match) throw new Error("No pixel.hubcloud.cx URL found");
      return match[0];
    })
    .then(function (pixelUrl) {
      return fetch(pixelUrl, {
        headers: Object.assign({}, FULL_HEADERS, { Referer: "https://gamerxyt.com/" }),
        redirect: "manual"
      });
    })
    .then(function (res1) {
      var workersUrl = res1.headers.get("location");
      if (!workersUrl) throw new Error("No workers.dev redirect");
      return fetch(workersUrl, {
        headers: Object.assign({}, FULL_HEADERS, { Referer: "https://gamerxyt.com/" }),
        redirect: "manual"
      });
    })
    .then(function (res2) {
      var dlPhpUrl = res2.headers.get("location");
      if (!dlPhpUrl) throw new Error("No dl.php redirect");
      var match = dlPhpUrl.match(/link=(https:\/\/video-downloads\.googleusercontent\.com\/[^&]+)/);
      if (!match) throw new Error("No googleusercontent URL");
      return match[1];
    });
}

function resolveStreamUrl(magiclinksUrl) {
  return resolveMagiclinksUrl(magiclinksUrl)
    .then(function (hubcloudUrl) {
      console.log("[KMMovies] Resolved magiclinks → " + hubcloudUrl.slice(0, 50));
      return resolveHubcloudUrl(hubcloudUrl);
    });
}

// ===== MAIN ENTRY =====

function getStreams(tmdbId, type, season, episode) {
  console.log("[KMMovies] Request: tmdb=" + tmdbId + " type=" + type);

  return getTMDBInfo(tmdbId, type)
    .then(function (info) {
      console.log("[KMMovies] TMDB result:", JSON.stringify(info));
      if (!info || !info.title) return [];
      console.log("[KMMovies] TMDB: " + info.title + " (" + info.year + ")");

      return searchKMMovies(info.title).then(function (results) {
        if (!results.length) return [];
        var match = findBestMatch(results, info.title, info.year);
        if (!match) return [];

        return fetchText(match.url, { Referer: BASE_URL + "/" }).then(function (postHtml) {
          var links = extractDownloadLinks(postHtml);
          if (!links.length) return [];

          return Promise.all(links.map(function (l) {
            return resolveStreamUrl(l.url)
              .then(function (gdriveUrl) {
                return Object.assign({}, l, { gdriveUrl: gdriveUrl });
              })
              .catch(function (err) {
                console.log("[KMMovies] Failed to resolve " + l.url + ": " + err.message);
                return null;
              });
          })).then(function (resolved) {
            return resolved.filter(function (r) { return r !== null && r.gdriveUrl; });
          });
        }).then(function (resolvedLinks) {
          return resolvedLinks.map(function (l) {
            return {
              name: PROVIDER_NAME + " - " + l.quality + (l.size ? " [" + l.size + "]" : ""),
              title: info.title + " (" + info.year + ") " + l.quality + (l.size ? " " + l.size : ""),
              url: l.gdriveUrl,
              quality: l.quality,
              size: l.size,
              type: "video/mkv",
              headers: { "User-Agent": USER_AGENT },
              behaviorHints: { bingeGroup: "kmmovies-" + l.quality }
            };
          });
        });
      });
    })
    .catch(function (err) {
      console.error("[KMMovies] getStreams FAILED:", err && err.message ? err.message : err);
      throw err;
    });
}

module.exports = { getStreams: getStreams };
