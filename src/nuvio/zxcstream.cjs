// ZXCStream Scraper for Nuvio Local Scrapers
// Written 2026-08-18 — returns embed/stream URLs from player.zxcstream.xyz.
//
// FLOW:
//   1. Get TMDB info (title, year, type)
//   2. Generate auth token: ts = Date.now()
//      xt = sha512(`${ts}:24356351231432574635345245245252324:${tmdbId}`).slice(0,64)
//   3. POST /backend/token {id, fToken: xt, ts} → {token, ts}
//   4. GET /backend_/embed/sentinel?id={tmdbId}&b={movie|tv}&ts={ts}&token={token}&fToken={xt}
//      → {embed: "https://..."} (iframe URL to 3rd-party player)
//   5. Return the embed URL as a stream
//
// NOTE: The token endpoint may be CF-protected or IP-blocked.
// If token generation fails, return the embed page URL directly.
// No Playwright, no FlareSolverr — uses plain fetch() + crypto.

"use strict";

var crypto = require("crypto");

var PROVIDER_NAME = "ZXCStream";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var BASE_URL = "https://player.zxcstream.xyz";
var SECRET = "24356351231432574635345245245252324";

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

function generateToken(tmdbId) {
  var ts = Date.now();
  var input = ts + ":" + SECRET + ":" + tmdbId;
  var xt = crypto.createHash("sha512").update(input).digest("hex").slice(0, 64);
  return { ts: ts, fToken: xt };
}

function getEmbedUrl(tmdbId, type, season, episode) {
  var tokenData = generateToken(tmdbId);
  var body = JSON.stringify({
    id: String(tmdbId),
    fToken: tokenData.fToken,
    ts: tokenData.ts
  });

  // Try to get a token from the backend
  return fetch(BASE_URL + "/backend/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "Origin": BASE_URL,
      "Referer": BASE_URL + "/embed/" + (type === "tv" ? "tv" : "movie") + "/" + tmdbId
    },
    body: body,
    redirect: "follow"
  })
    .then(function (r) { return r.text(); })
    .then(function (response) {
      try {
        var data = JSON.parse(response);
        if (data.token) {
          // Got a token — request the embed URL
          var sentinelUrl = BASE_URL + "/backend_/embed/sentinel?id=" + tmdbId +
            "&b=" + (type === "tv" ? "tv" : "movie") +
            "&ts=" + data.ts +
            "&token=" + encodeURIComponent(data.token) +
            "&fToken=" + encodeURIComponent(tokenData.fToken);
          if (type === "tv" && season && episode) {
            sentinelUrl += "&season=" + season + "&episode=" + episode;
          }
          return fetch(sentinelUrl, {
            headers: {
              "User-Agent": USER_AGENT,
              "Referer": BASE_URL + "/"
            },
            redirect: "follow"
          })
            .then(function (r) { return r.text(); })
            .then(function (sentinelResponse) {
              try {
                var sentinelData = JSON.parse(sentinelResponse);
                if (sentinelData.embed) {
                  return sentinelData.embed;
                }
              } catch (e) {}
              return null;
            })
            .catch(function () { return null; });
        }
      } catch (e) {}
      return null;
    })
    .catch(function () { return null; });
}

function getStreams(tmdbId, type, season, episode) {
  var isMovie = type !== "tv";
  console.log("[ZXCStream] Request: tmdb=" + tmdbId + " type=" + type +
    (isMovie ? "" : " S" + season + "E" + episode));

  return getTMDBInfo(tmdbId, type)
    .then(function (info) {
      if (!info || !info.title) {
        console.log("[ZXCStream] Could not resolve TMDB info");
        return [];
      }
      console.log("[ZXCStream] TMDB: " + info.title + " (" + info.year + ")");

      // Try to get the embed URL via the token/sentinel flow
      return getEmbedUrl(tmdbId, type, season, episode)
        .then(function (embedUrl) {
          var streams = [];

          if (embedUrl) {
            console.log("[ZXCStream] Got embed URL: " + embedUrl.slice(0, 80));
            streams.push({
              name: PROVIDER_NAME + " - HD",
              title: info.title + (isMovie ? "" : " S" + String(season || 1).padStart(2, "0") + "E" + String(episode || 1).padStart(2, "0")) + " (" + info.year + ")",
              url: embedUrl,
              quality: "HD",
              type: "iframe",
              headers: { "User-Agent": USER_AGENT }
            });
          }

          // Also return the embed page URL as a fallback stream
          var embedPageUrl = BASE_URL + "/embed/" + (isMovie ? "movie" : "tv") + "/" + tmdbId;
          if (!isMovie && season && episode) {
            embedPageUrl += "/" + season + "/" + episode;
          }
          streams.push({
            name: PROVIDER_NAME + " - Player",
            title: info.title + (isMovie ? "" : " S" + String(season || 1).padStart(2, "0") + "E" + String(episode || 1).padStart(2, "0")) + " (" + info.year + ")",
            url: embedPageUrl,
            quality: "HD",
            type: "iframe",
            headers: { "User-Agent": USER_AGENT }
          });

          console.log("[ZXCStream] Returning " + streams.length + " streams");
          return streams;
        });
    })
    .catch(function (err) {
      console.log("[ZXCStream] Error: " + (err && err.message ? err.message : err));
      return [];
    });
}

module.exports = { getStreams: getStreams };
