// CineJoy Scraper for Nuvio Local Scrapers
// Written 2026-08-18 — returns HLS m3u8 streams via HdHub addon's resolve endpoint.
//
// FLOW:
//   1. Get TMDB info (title, year, type)
//   2. Return HLS streams using the HdHub addon's /resolve/cj/ endpoint
//   3. Stream URL: https://hdhub.thevolecitor.qzz.io/resolve/cj/tmdb/{tmdbId}/{quality}.m3u8
//   4. The addon server handles the Noise protocol handshake with api.shegu.st
//      and returns a valid m3u8 playlist from info.movieboxnoob.cc
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

      // Build stream URLs for each quality
      var qualities = [
        { quality: "2160p", suffix: "4khevc", name: "4K HEVC" },
        { quality: "1080p", suffix: "1080p", name: "1080p" },
        { quality: "720p", suffix: "720p", name: "720p" },
        { quality: "480p", suffix: "480p", name: "480p" }
      ];

      var streams = qualities.map(function (q) {
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

      console.log("[CineJoy] Returning " + streams.length + " streams");
      return streams;
    })
    .catch(function (err) {
      console.log("[CineJoy] Error: " + (err && err.message ? err.message : err));
      return [];
    });
}

module.exports = { getStreams: getStreams };
