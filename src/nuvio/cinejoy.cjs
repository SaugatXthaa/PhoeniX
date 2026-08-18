// CineJoy Scraper for Nuvio Local Scrapers
// ---------------------------------------------------------------
// Returns HLS m3u8 streams via HdHub addon's /resolve/cj/ endpoint.
//
// FLOW:
//   1. Get TMDB info (title, year, type)
//   2. For each quality (4K HEVC, 1080p, 720p, 480p), build the resolve URL
//   3. HEAD-check each URL in parallel (200ms-1s total)
//   4. Return only the qualities that actually exist for this title
//
// The addon server (hdhub.thevolecitor.qzz.io) handles the Noise-protocol
// handshake with api.shegu.st and returns a valid m3u8 playlist from
// info.movieboxnoob.cc.
//
// Qualities: 4K HEVC, 1080p, 720p, 480p
// No Playwright, no FlareSolverr — uses plain fetch().

"use strict";

var PROVIDER_NAME = "CineJoy";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var RESOLVE_BASE = "https://hdhub.thevolecitor.qzz.io/resolve/cj/tmdb";

var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function getTMDBInfo(tmdbId, type) {
  var endpoint = type === "tv" ? "tv" : "movie";
  var url = "https://api.themoviedb.org/3/" + endpoint + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  return fetch(url, { headers: { "User-Agent": USER_AGENT } })
    .then(function (r) { return r.text(); })
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

// Quick GET with short timeout to verify the resolve URL returns a valid m3u8.
// We don't use HEAD because the addon server may not handle HEAD on /resolve/cj/.
// We grab only the first 4 bytes to check for the #EXTM3U magic.
function validateStreamUrl(url) {
  return fetch(url, {
    method: "GET",
    headers: { "User-Agent": USER_AGENT, "Range": "bytes=0-3" },
    signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined
  })
    .then(function (r) {
      if (!r.ok) return false;
      return r.text().then(function (body) {
        return body && body.indexOf("#EXTM3U") === 0;
      });
    })
    .catch(function () { return false; });
}

function getStreams(tmdbId, type, season, episode) {
  var isMovie = type !== "tv";
  console.log("[CineJoy] Request: tmdb=" + tmdbId + " type=" + type +
    (isMovie ? "" : " S" + season + "E" + episode));

  return getTMDBInfo(tmdbId, type)
    .then(function (info) {
      if (!info || !info.title) {
        console.log("[CineJoy] Could not resolve TMDB info");
        return [];
      }
      console.log("[CineJoy] TMDB: " + info.title + " (" + info.year + ")");

      var qualities = [
        { quality: "2160p", suffix: "4khevc", name: "4K HEVC" },
        { quality: "1080p", suffix: "1080p", name: "1080p" },
        { quality: "720p", suffix: "720p", name: "720p" },
        { quality: "480p", suffix: "480p", name: "480p" }
      ];

      // Build candidate streams first
      var candidates = qualities.map(function (q) {
        var streamUrl = RESOLVE_BASE + "/" + tmdbId + "/" + q.suffix + ".m3u8";
        var titleLine = info.title;
        if (!isMovie) {
          titleLine += " S" + String(season || 1).padStart(2, "0") +
                       "E" + String(episode || 1).padStart(2, "0");
        }
        titleLine += " (" + info.year + ") " + q.name;

        return {
          name: PROVIDER_NAME + " - " + q.name,
          title: titleLine,
          url: streamUrl,
          quality: q.quality,
          type: "application/vnd.apple.mpegurl",
          headers: { "User-Agent": USER_AGENT },
          behaviorHints: {
            bingeGroup: "cinejoy-" + q.quality
          }
        };
      });

      // Validate all URLs in parallel
      return Promise.all(
        candidates.map(function (s) {
          return validateStreamUrl(s.url).then(function (ok) {
            return { stream: s, ok: ok };
          });
        })
      ).then(function (results) {
        var streams = results
          .filter(function (r) { return r.ok; })
          .map(function (r) { return r.stream; });

        if (streams.length === 0) {
          console.log("[CineJoy] No playable qualities — addon server may be down");
        } else {
          var labels = streams.map(function (s) { return s.quality; }).join(", ");
          console.log("[CineJoy] Returning " + streams.length + " streams: " + labels);
        }
        return streams;
      });
    })
    .catch(function (err) {
      console.log("[CineJoy] Error: " + (err && err.message ? err.message : err));
      return [];
    });
}

module.exports = { getStreams: getStreams };
