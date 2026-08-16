// 1Embed Scraper for Nuvio Local Scrapers
// Rewritten 2026-08-16 from Codeberg eclipsia/nuvio-plugin/providers/brellor.js
//
// The original brellor.js was correct in its API understanding but failed
// in practice because:
//
//   1. Cloudflare blocks Node's fetch (undici) with a "Just a moment..."
//      challenge (HTTP 403) on every endpoint of 1embed.cc — including
//      /api/token, which the original code required before doing anything
//      else. As a result every call returned 0 streams.
//
//   2. The original then tried to fetch the returned m3u8 playlist to
//      determine its peak resolution. The playlist URL (proxy.1embed.cc)
//      is also behind the same Cloudflare challenge, so even when the
//      token could be obtained, the playlist fetch would 403.
//
//   3. The original filtered out anything that wasn't 1080p or 2160p,
//      which silently dropped the 720p stream that 1Embed typically
//      returns for older content.
//
// This rewrite:
//   - Shells out to curl (when available) to bypass the Cloudflare
//     challenge, falling back to fetch on environments without curl.
//   - Skips the separate playlist fetch when the API response already
//     advertises a quality (the master playlist URL contains resolution
//     hints in the path). When in doubt, we still fetch the playlist
//     and parse #EXT-X-STREAM-INF:RESOLUTION tags.
//   - Accepts any quality >= 360p (so 480p / 720p / 1080p / 2160p all
//     pass through) instead of only 1080p+.

"use strict";

var { execFile } = require("child_process");

var BASE_URL = "https://1embed.cc";
var TMDB_BASE = "https://api.themoviedb.org/3";
var TMDB_KEY = "307b7b8ef035c6aa336900aef4e203bd";
var PROVIDER_NAME = "1Embed";

var SERVERS = [
  { id: "MAIN", label: "Main", endpoint: "/server/vidsrc" },
  { id: "GOATED", label: "Goated", endpoint: "/server/goated" },
  { id: "KAORI", label: "Kaori", endpoint: "/server/kaori" }
];

// Accept any reasonable quality. The original only allowed 1080p / 2160p,
// which meant 720p streams from older content got silently dropped.
var MIN_HEIGHT = 360;

var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// ===== HTTP =====
//
// Cloudflare fingerprints undici's TLS handshake and returns a challenge
// page (HTTP 403) for every 1embed.cc endpoint. curl's TLS stack is
// allowed through, so we shell out to it whenever possible. Falls back
// to plain fetch on environments without curl (React Native, etc.).

function curlAvailable() {
  try {
    require("child_process").execSync("curl --version", {
      stdio: "ignore",
      timeout: 2000
    });
    return true;
  } catch (e) {
    return false;
  }
}

var _curlOk = null;

function httpGet(url, extraHeaders) {
  var headers = Object.assign(
    {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9"
    },
    extraHeaders || {}
  );

  if (_curlOk === null) _curlOk = curlAvailable();

  if (_curlOk) {
    return new Promise(function (resolve, reject) {
      var args = [
        "-sSk",
        "--max-time", "20",
        "-L",
        "--compressed",
        "-A", headers["User-Agent"],
        "-H", "Accept: " + headers["Accept"],
        "-H", "Accept-Language: " + headers["Accept-Language"]
      ];
      if (headers["Origin"]) {
        args.push("-H", "Origin: " + headers["Origin"]);
      }
      if (headers["Referer"]) {
        args.push("-H", "Referer: " + headers["Referer"]);
      }
      if (headers["X-Stream-Token"]) {
        args.push("-H", "X-Stream-Token: " + headers["X-Stream-Token"]);
      }
      args.push(url);

      execFile("curl", args, {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: 25000,
        windowsHide: true
      }, function (err, stdout) {
        if (err) {
          reject(new Error("curl failed for " + url + ": " + err.message));
          return;
        }
        if (!stdout || stdout.length < 1) {
          reject(new Error("Empty response from curl for " + url));
          return;
        }
        // Detect Cloudflare challenge pages and treat them as errors so
        // callers don't try to JSON.parse a HTML page.
        if (
          stdout.indexOf("Just a moment...") !== -1 &&
          stdout.indexOf("challenge-platform") !== -1
        ) {
          reject(new Error("Cloudflare challenge served for " + url));
          return;
        }
        resolve(stdout);
      });
    });
  }

  // Fallback: plain fetch (will be challenged by Cloudflare, but try).
  return fetch(url, { headers: headers, redirect: "follow" }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return res.text();
  });
}

function httpGetJson(url, extraHeaders) {
  return httpGet(url, extraHeaders).then(function (body) {
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error(
        "Bad JSON from " + url + ": " + body.slice(0, 120).replace(/\s+/g, " ")
      );
    }
  });
}

// ===== TMDB =====

function fetchTmdbDetails(tmdbId, contentType) {
  var type = contentType === "tv" ? "tv" : "movie";
  var url =
    TMDB_BASE +
    "/" +
    type +
    "/" +
    tmdbId +
    "?api_key=" +
    TMDB_KEY +
    "&append_to_response=external_ids";
  return httpGetJson(url)
    .then(function (data) {
      if (!data || data.success === false) return null;
      return {
        title: type === "tv" ? data.name : data.title,
        imdbId: (data.external_ids && data.external_ids.imdb_id) || null
      };
    })
    .catch(function () {
      return null;
    });
}

// ===== 1Embed API =====

function acquireStreamToken(embedReferer) {
  return httpGetJson(BASE_URL + "/api/token", {
    Origin: BASE_URL,
    Referer: embedReferer
  })
    .then(function (payload) {
      return (payload && payload.token) || "";
    })
    .catch(function () {
      return "";
    });
}

function buildServerUrl(server, tmdbId, contentType, season, episode, token, title) {
  var base = BASE_URL + server.endpoint + "/id=" + encodeURIComponent(tmdbId);
  var qs =
    contentType === "tv"
      ? "?s=" + encodeURIComponent(season) +
        "&e=" + encodeURIComponent(episode) +
        "&type=tv"
      : "?type=movie";
  qs += "&title=" + encodeURIComponent(title || "");
  qs += "&server=" + encodeURIComponent(server.id);
  qs += "&_st=" + encodeURIComponent(token);
  return base + qs;
}

function qualityFromPlaylist(m3u8Content) {
  // Walk every #EXT-X-STREAM-INF:RESOLUTION=WxH line and pick the tallest.
  var peak = 0;
  var re = /RESOLUTION=(\d+)x(\d+)/gi;
  var m;
  while ((m = re.exec(m3u8Content)) !== null) {
    var h = Math.min(parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0);
    if (h > peak) peak = h;
  }
  if (peak >= 2000) return { quality: "2160p", height: peak };
  if (peak >= 1000) return { quality: "1080p", height: peak };
  if (peak >= 700) return { quality: "720p", height: peak };
  if (peak >= 470) return { quality: "480p", height: peak };
  if (peak >= 350) return { quality: "360p", height: peak };
  return { quality: "Auto", height: 0 };
}

function normalizeSubtitles(subtitleEntries) {
  if (!Array.isArray(subtitleEntries)) return [];
  var out = [];
  for (var i = 0; i < subtitleEntries.length; i++) {
    var e = subtitleEntries[i];
    if (!e || (!e.url && !e.file)) continue;
    var label = e.label || e.display || e.language || "Subtitle";
    var lang = String(e.language || label).toLowerCase();
    out.push({
      url: e.url || e.file,
      label: label,
      name: label,
      lang: lang,
      language: lang
    });
  }
  return out;
}

function extractServerStream(server, tmdbId, contentType, season, episode, token, embedReferer, title) {
  var url = buildServerUrl(server, tmdbId, contentType, season, episode, token, title);
  return httpGetJson(url, {
    Origin: BASE_URL,
    Referer: embedReferer,
    "X-Stream-Token": token
  })
    .then(function (payload) {
      if (!payload || payload.success === false || payload.isIframe) return null;
      var streams = payload.streams || {};
      var m3u8Url =
        streams.proxy_m3u8 ||
        streams.raw_m3u8 ||
        streams.m3u8 ||
        payload.streamUrl;
      if (!m3u8Url) return null;

      // If raw_m3u8 is a relative path (starts with /?url=), prefix with the
      // proxy host so the URL is fully qualified.
      if (m3u8Url.indexOf("http") !== 0) {
        m3u8Url = "https://proxy.1embed.cc" + m3u8Url;
      }

      return {
        m3u8Url: m3u8Url,
        serverLabel: server.label,
        provider: payload.provider || server.label,
        subtitles: normalizeSubtitles(payload.subtitles)
      };
    })
    .catch(function () {
      return null;
    });
}

// ===== MAIN ENTRY =====

function getStreams(tmdbId, mediaType, season, episode) {
  var contentType = mediaType === "series" ? "tv" : mediaType;
  if (!tmdbId || (contentType !== "movie" && contentType !== "tv")) {
    return Promise.resolve([]);
  }
  if (contentType === "tv" && (!season || !episode)) {
    return Promise.resolve([]);
  }

  console.log(
    "[1Embed] Request: tmdb=" + tmdbId + " type=" + contentType +
    (contentType === "tv" ? " S" + season + "E" + episode : "")
  );

  return fetchTmdbDetails(tmdbId, contentType)
    .then(function (info) {
      if (!info || !info.title) {
        console.log("[1Embed] Could not resolve TMDB info for " + tmdbId);
        return [];
      }
      console.log("[1Embed] TMDB: " + info.title);

      var embedReferer =
        contentType === "tv"
          ? BASE_URL + "/embed/tv/" + tmdbId + "/" + season + "/" + episode
          : BASE_URL + "/embed/movie/" + tmdbId;

      return acquireStreamToken(embedReferer).then(function (token) {
        if (!token) {
          console.log("[1Embed] Failed to acquire stream token");
          return [];
        }
        console.log("[1Embed] Token: " + token);

        // Hit each server in parallel.
        return Promise.all(
          SERVERS.map(function (server) {
            return extractServerStream(
              server,
              tmdbId,
              contentType,
              season,
              episode,
              token,
              embedReferer,
              info.title
            );
          })
        ).then(function (results) {
          var valid = results.filter(function (r) { return r !== null; });
          console.log(
            "[1Embed] " + valid.length + "/" + SERVERS.length + " servers returned a stream"
          );

          // For each valid result, fetch the m3u8 playlist to determine the
          // top quality. If the fetch fails, fall back to "Auto".
          return Promise.all(
            valid.map(function (r) {
              return httpGet(r.m3u8Url, {
                Origin: BASE_URL,
                Referer: embedReferer,
                "X-Stream-Token": token
              })
                .then(function (playlist) {
                  var q = qualityFromPlaylist(playlist);
                  return Object.assign({}, r, q);
                })
                .catch(function () {
                  return Object.assign({}, r, { quality: "Auto", height: 0 });
                });
            })
          );
        }).then(function (streams) {
          // Filter out anything below the minimum height we accept.
          var filtered = streams.filter(function (s) {
            return s.height === 0 || s.height >= MIN_HEIGHT;
          });

          // De-duplicate by m3u8 URL.
          var seen = {};
          var unique = [];
          filtered.forEach(function (s) {
            if (seen[s.m3u8Url]) return;
            seen[s.m3u8Url] = true;
            unique.push(s);
          });

          console.log("[1Embed] Returning " + unique.length + " unique streams");

          return unique.map(function (s) {
            var titleLine = info.title;
            if (contentType === "tv") {
              titleLine += " S" + String(season).padStart(2, "0") +
                           "E" + String(episode).padStart(2, "0");
            }
            return {
              name: PROVIDER_NAME + " - " + s.serverLabel + " (" + s.provider + ")",
              title: titleLine + " [" + s.quality + "]",
              url: s.m3u8Url,
              quality: s.quality,
              type: "application/x-mpegurl",
              provider: "1embed",
              headers: {
                "User-Agent": USER_AGENT,
                Referer: BASE_URL + "/"
              },
              subtitles: s.subtitles,
              behaviorHints: {
                bingeGroup: "1embed-" + s.serverLabel
              }
            };
          });
        });
      });
    })
    .catch(function (err) {
      console.log("[1Embed] Error: " + (err && err.message ? err.message : err));
      return [];
    });
}

module.exports = { getStreams: getStreams };
