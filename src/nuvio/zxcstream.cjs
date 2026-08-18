// ZXCStream Scraper for Nuvio Local Scrapers
// ---------------------------------------------------------------
// Returns the ZXCStream player page URL as an iframe stream.
//
// ORIGINAL FLOW (from player.zxcstream.xyz/_next/static/chunks/...):
//   1. Client generates fToken = sha512(`${ts}:SECRET:${tmdbId}`).slice(0,64)
//   2. POST /backend/token { id, fToken, ts } → server returns { token, ts }
//   3. GET /backend_/embed/sentinel?id=X&b=movie&ts=X&token=X&fToken=X → { embed }
//   4. The embed URL is an iframe to a 3rd-party player (e.g. 2embed)
//
// PROBLEM: `/backend/token` is IP-blocked at the APPLICATION LAYER
// (HTTP 422 with "Blocked IP tried to access:"). This block is per-IP —
// works fine from a residential browser IP, but fails from a Render/worker
// server IP. Cloudflare itself is fine; the block is in the zxcstream
// Next.js backend.
//
// SOLUTION: Return the player page URL as an iframe stream. When the
// end-user opens it in Stremio's iframe, the request goes out from
// their residential IP → no block → page loads → JS fetches token
// → video plays. We label this clearly so the user understands it's
// a player iframe, not a direct video URL.
//
// No Playwright, no FlareSolverr — uses plain fetch() + crypto.

"use strict";

var crypto = require("crypto");

var PROVIDER_NAME = "ZXCStream";
var TMDB_API_KEY = "1c29a5198ee1854bd5eb45dbe8d17d92";
var BASE_URL = "https://player.zxcstream.xyz";

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

// Generate the frontend token (matches the client-side logic in chunk 101r9kj).
// We use this when constructing the player page URL hash so the player page
// can short-circuit its token POST request.
function generateFrontendToken(tmdbId) {
  var SECRET = "24356351231432574635345245245252324";
  var ts = Date.now();
  var input = ts + ":" + SECRET + ":" + tmdbId;
  var xt = crypto.createHash("sha512").update(input).digest("hex").slice(0, 64);
  return { xt: xt, rt: ts };
}

// Attempt to get the embed URL via /backend_/embed/sentinel directly.
// This will only succeed if either:
//   (a) our server IP is NOT blocked, OR
//   (b) the server has cached a token from a previous request.
// Otherwise returns null and the caller falls through to the player-page iframe.
function tryGetEmbedUrl(tmdbId, type, season, episode) {
  var tokenData = generateFrontendToken(tmdbId);
  var sentinelUrl = BASE_URL + "/backend_/embed/sentinel?id=" + tmdbId +
    "&b=" + (type === "tv" ? "tv" : "movie") +
    "&ts=" + tokenData.rt +
    "&token=" +
    "&fToken=" + encodeURIComponent(tokenData.xt);
  if (type === "tv" && season && episode) {
    sentinelUrl += "&season=" + season + "&episode=" + episode;
  }

  return fetch(sentinelUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": BASE_URL + "/embed/" + (type === "tv" ? "tv" : "movie") + "/" + tmdbId
    },
    redirect: "follow"
  })
    .then(function (r) {
      if (!r.ok) return null;
      return r.text();
    })
    .then(function (body) {
      if (!body) return null;
      try {
        var data = JSON.parse(body);
        if (data && data.embed) return data.embed;
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

      return tryGetEmbedUrl(tmdbId, type, season, episode)
        .then(function (embedUrl) {
          var streams = [];
          var titleLine = info.title + (isMovie ? "" : " S" + String(season || 1).padStart(2, "0") + "E" + String(episode || 1).padStart(2, "0")) + " (" + info.year + ")";

          if (embedUrl) {
            console.log("[ZXCStream] Got embed URL: " + embedUrl.slice(0, 80));
            streams.push({
              name: PROVIDER_NAME + " - HD",
              title: titleLine + " HD",
              url: embedUrl,
              quality: "1080p",
              type: "iframe",
              headers: { "User-Agent": USER_AGENT },
              behaviorHints: {
                bingeGroup: "zxcstream-hd",
                notWebVideo: true
              }
            });
          }

          // Always also return the player page URL as a fallback stream.
          // The page itself handles the token POST from the user's browser IP.
          var playerPageUrl = BASE_URL + "/embed/" + (isMovie ? "movie" : "tv") + "/" + tmdbId;
          if (!isMovie && season && episode) {
            playerPageUrl += "/" + season + "/" + episode;
          }
          streams.push({
            name: PROVIDER_NAME + (embedUrl ? " - Player Page" : " - HD (Player Page)"),
            title: titleLine + " [Player Page]",
            url: playerPageUrl,
            quality: embedUrl ? "1080p" : "HD",
            type: "iframe",
            headers: { "User-Agent": USER_AGENT },
            behaviorHints: {
              bingeGroup: "zxcstream-player",
              notWebVideo: true
            }
          });

          if (embedUrl) {
            console.log("[ZXCStream] Returning " + streams.length + " streams (embed + player page fallback)");
          } else {
            console.log("[ZXCStream] Returning " + streams.length + " stream (player page — backend IP-blocked from server, will work from user browser)");
          }
          return streams;
        });
    })
    .catch(function (err) {
      console.log("[ZXCStream] Error: " + (err && err.message ? err.message : err));
      return [];
    });
}

module.exports = { getStreams: getStreams };
