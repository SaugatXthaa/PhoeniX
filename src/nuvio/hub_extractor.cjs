// HubExtractor — Shared module for resolving hubcloud/hubcdn/pixeldrain
// download links to direct Google Drive URLs.
//
// Used by: 4khdhub.js, 1desiremovies.js, kmmovies.js, hdhub4u.js, and
// any other scraper that encounters hubcloud.*/hubcdn.sbs/pixeldrain links.
//
// SUPPORTED CHAINS:
//
// 1. Hubcloud chain (hubcloud.cx/foo/ist → gamerxyt → pixel → workers → dl.php):
//    Input:  https://hubcloud.cx/drive/<id>
//            https://hubcloud.foo/drive/<id>
//            https://hubcloud.ist/drive/<id>
//    Output: https://video-downloads.googleusercontent.com/... (direct GDrive download)
//
// 2. Hubcdn chain (hubcdn.sbs → base64 decode):
//    Input:  https://hubcdn.sbs/file/<id>
//    Output: https://video-downloads.googleusercontent.com/... (direct GDrive download)
//
// 3. Link protector chain (gyanigurus.online, hindifire.store, magiclinks.lol):
//    Input:  https://gyanigurus.online/view/<hash>
//            https://hindifire.store/view/<code>
//            https://w3.magiclinks.lol/<id>/
//    Output: hubcloud.*/drive/<id> (which then goes through chain 1)
//
// 4. Pixeldrain (direct file hosting):
//    Input:  https://pixeldrain.com/u/<id> or https://pixeldrain.dev/u/<id>
//    Output: https://pixeldrain.com/api/file/<id> (direct download URL)
//
// MULTI-STRATEGY HTTP:
//   1. Try got-scraping (Chrome TLS fingerprint — bypasses CF on Render)
//   2. Fall back to curl with full browser headers + cookie jar
//   3. Fall back to plain fetch()
//
// No Playwright, no FlareSolverr.

"use strict";

var { execFile } = require("child_process");
var path = require("path");

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

// ===== GOT-SCRAPING LOADER =====

var _gsHelper = null;
function getGsHelper() {
  if (_gsHelper !== null) return _gsHelper;
  try {
    _gsHelper = require("./got_scraping_helper");
  } catch (e) {
    try {
      _gsHelper = require(path.join(__dirname, "got_scraping_helper"));
    } catch (e2) {
      _gsHelper = false;
    }
  }
  return _gsHelper;
}

// ===== CURL AVAILABILITY =====

var _curlOk = null;
function curlAvailable() {
  if (_curlOk === null) {
    try {
      require("child_process").execSync("curl --version", {
        stdio: "ignore", timeout: 2000
      });
      _curlOk = true;
    } catch (e) { _curlOk = false; }
  }
  return _curlOk;
}

// ===== MULTI-STRATEGY HTTP =====

function fetchText(url, extraHeaders) {
  var headers = Object.assign({}, FULL_HEADERS, extraHeaders || {});

  // Strategy 1: got-scraping (Chrome TLS — works on Render for CF bypass)
  var gs = getGsHelper();
  if (gs) {
    return gs.httpGet(url, { headers: headers, timeout: 25000 })
      .then(function (body) {
        if (body && body.length > 50 && body.indexOf("Just a moment") === -1) {
          return body;
        }
        // got-scraping got CF-challenged or empty — fall back to curl
        return fetchViaCurl(url, headers);
      })
      .catch(function () {
        return fetchViaCurl(url, headers);
      });
  }

  // Strategy 2: curl with full browser headers + cookie jar
  if (curlAvailable()) {
    return fetchViaCurl(url, headers).catch(function () {
      return fetchViaPlainFetch(url, headers);
    });
  }

  // Strategy 3: plain fetch
  return fetchViaPlainFetch(url, headers);
}

function fetchViaCurl(url, headers) {
  return new Promise(function (resolve, reject) {
    var cookieFile = "/tmp/hubextractor_cookies.txt";
    var args = [
      "-sSk", "--max-time", "25", "-L", "--compressed",
      "-c", cookieFile, "-b", cookieFile,
      "-A", headers["User-Agent"],
      "-H", "Accept: " + headers["Accept"],
      "-H", "Accept-Language: " + headers["Accept-Language"]
    ];
    if (headers["Referer"]) args.push("-H", "Referer: " + headers["Referer"]);
    if (headers["Origin"]) args.push("-H", "Origin: " + headers["Origin"]);
    args.push(url);

    execFile("curl", args, {
      encoding: "utf8",
      maxBuffer: 30 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true
    }, function (err, stdout) {
      if (err) { reject(new Error("curl failed for " + url + ": " + err.message)); return; }
      resolve(stdout || "");
    });
  });
}

function fetchViaPlainFetch(url, headers) {
  return fetch(url, { headers: headers, redirect: "follow" }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return res.text();
  });
}

// Follow a redirect chain manually and return the final Location URL.
// Uses curl (with -I for HEAD) to get redirect headers without downloading body.
function followRedirectChain(url, extraHeaders) {
  var headers = Object.assign({}, FULL_HEADERS, extraHeaders || {});

  // Try curl first (handles multi-hop redirects + cookies)
  if (curlAvailable()) {
    return new Promise(function (resolve, reject) {
      var args = [
        "-sSk", "--max-time", "15", "-I", "-L",
        "-A", headers["User-Agent"]
      ];
      if (headers["Referer"]) args.push("-H", "Referer: " + headers["Referer"]);
      args.push(url);

      execFile("curl", args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 20000,
        windowsHide: true
      }, function (err, stdout) {
        if (err) { reject(new Error("curl redirect failed: " + err.message)); return; }
        var locations = stdout.split("\n")
          .filter(function (l) { return l.match(/^location:/i); })
          .map(function (l) { return l.replace(/^location:\s*/i, "").trim(); });
        if (locations.length) {
          resolve(locations[locations.length - 1]);
        } else {
          reject(new Error("No redirect found"));
        }
      });
    });
  }

  // Fallback: plain fetch with manual redirect
  return fetch(url, {
    headers: headers,
    redirect: "manual"
  }).then(function (res) {
    var loc = res.headers.get("location");
    if (!loc) throw new Error("No redirect (plain fetch)");
    // Follow second hop if needed
    return fetch(loc, {
      headers: headers,
      redirect: "manual"
    }).then(function (res2) {
      var loc2 = res2.headers.get("location");
      return loc2 || loc;
    }).catch(function () { return loc; });
  });
}

// ===== HUBCLOUD RESOLUTION =====

// Resolve a hubcloud.*/drive/<id> URL to a direct Google Drive download URL.
// Chain: hubcloud.* → gamerxyt.com → pixel.hubcloud.cx → workers.dev → dl.php?link=<gdrive>
function resolveHubcloudUrl(hubcloudUrl) {
  var gamerxytUrl = null;
  var pixelUrl = null;

  return fetchText(hubcloudUrl)
    .then(function (html) {
      // Extract the gamerxyt URL from `var url = '...'`
      var match = html.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/);
      if (!match) throw new Error("No gamerxyt URL found in hubcloud page");
      gamerxytUrl = match[1];
      return fetchText(gamerxytUrl, { Referer: "https://hubcloud.cx/" });
    })
    .then(function (gamerxytHtml) {
      // Extract the pixel.hubcloud.cx URL
      var match = gamerxytHtml.match(/https:\/\/pixel\.hubcloud\.cx\/\?id=[^"'\s]+/);
      if (!match) throw new Error("No pixel.hubcloud.cx URL found");
      pixelUrl = match[0];
      // Follow pixel.hubcloud.cx → workers.dev → dl.php?link=<gdrive>
      return followRedirectChain(pixelUrl, { Referer: "https://gamerxyt.com/" });
    })
    .then(function (finalUrl) {
      // The final URL should be dl.php?link=<googleusercontent_url>
      // Extract the googleusercontent URL from the link= parameter
      var match = finalUrl.match(/link=(https:\/\/video-downloads\.googleusercontent\.com\/[^&]+)/);
      if (!match) throw new Error("No googleusercontent URL in redirect chain");
      return match[1];
    });
}

// ===== HUBCDN RESOLUTION (base64 decode) =====

// Resolve a hubcdn.sbs/file/<id> URL to a direct Google Drive download URL.
// Chain: hubcdn.sbs → extract `var reurl` → base64 decode → extract GDrive URL
function resolveHubcdnUrl(hubcdnUrl) {
  return fetchText(hubcdnUrl)
    .then(function (html) {
      var match = html.match(/var\s+reurl\s*=\s*["']([^"']+)["']/);
      if (!match) throw new Error("No reurl found in hubcdn page");
      var reurl = match[1];

      // Extract base64 from ?r= parameter
      var b64Match = reurl.match(/\?r=([A-Za-z0-9+/=]+)/);
      if (!b64Match) throw new Error("No base64 in reurl");
      var decoded = Buffer.from(b64Match[1], "base64").toString("utf8");

      // Extract the googleusercontent URL from link= parameter
      var gucMatch = decoded.match(/link=(https:\/\/video-downloads\.googleusercontent\.com\/[^&]+)/);
      if (!gucMatch) throw new Error("No googleusercontent URL in decoded hubcdn URL");
      return gucMatch[1];
    });
}

// ===== LINK PROTECTOR RESOLUTION =====

// Fetch a link protector page (gyanigurus.online, hindifire.store, magiclinks.lol)
// and find hubcloud.*/drive/<id> link.
function resolveLinkProtectorUrl(protectorUrl) {
  return fetchText(protectorUrl)
    .then(function (html) {
      // Find any hubcloud.* link (hubcloud.cx, hubcloud.foo, hubcloud.ist, etc.)
      var match = html.match(/https:\/\/hubcloud\.[a-z]+\/drive\/[a-zA-Z0-9_]+/);
      if (!match) throw new Error("No hubcloud link found on protector page");
      return match[0];
    });
}

// Full resolution: link protector → hubcloud → googleusercontent
function resolveFromLinkProtector(protectorUrl) {
  return resolveLinkProtectorUrl(protectorUrl)
    .then(function (hubcloudUrl) {
      return resolveHubcloudUrl(hubcloudUrl);
    });
}

// ===== PIXELDRAIN RESOLUTION =====

// Resolve a pixeldrain.com/u/<id> URL to a direct download URL.
function resolvePixeldrainUrl(pixeldrainUrl) {
  var idMatch = pixeldrainUrl.match(/pixeldrain\.(?:com|dev)\/(?:u|l)\/([a-zA-Z0-9]+)/);
  if (!idMatch) throw new Error("Not a pixeldrain URL");
  var fileId = idMatch[1];
  // Pixeldrain direct download: https://pixeldrain.com/api/file/<id>
  return Promise.resolve("https://pixeldrain.com/api/file/" + fileId);
}

// ===== MASTER RESOLVER =====

// Given any download URL, detect its type and resolve to a direct download URL.
// Returns null if the URL type is not supported.
function resolveDownloadUrl(url) {
  // Hubcloud chain
  if (url.match(/https:\/\/hubcloud\.[a-z]+\/drive\//)) {
    return resolveHubcloudUrl(url);
  }

  // Hubcdn chain (base64 decode)
  if (url.indexOf("hubcdn.sbs") !== -1) {
    return resolveHubcdnUrl(url);
  }

  // Link protector → hubcloud
  if (url.match(/gyanigurus\.online|hindifire\.store|magiclinks\.lol/)) {
    return resolveFromLinkProtector(url);
  }

  // Pixeldrain
  if (url.match(/pixeldrain\.(com|dev)\/[ul]\//)) {
    return resolvePixeldrainUrl(url);
  }

  // Already a direct googleusercontent URL
  if (url.indexOf("video-downloads.googleusercontent.com") !== -1) {
    return Promise.resolve(url);
  }

  // Unknown URL type
  return Promise.resolve(null);
}

// ===== BATCH RESOLVER =====

// Resolve multiple download URLs in parallel (with concurrency limit).
// Returns array of { url, gdriveUrl, error } objects.
function resolveBatch(urls, concurrency) {
  var limit = concurrency || 5;
  var results = new Array(urls.length);
  var cursor = 0;
  var active = 0;

  return new Promise(function (resolve) {
    var launch = function () {
      while (active < limit && cursor < urls.length) {
        var i = cursor++;
        active++;
        resolveDownloadUrl(urls[i])
          .then(function (gdriveUrl) {
            results[i] = { url: urls[i], gdriveUrl: gdriveUrl, error: null };
          })
          .catch(function (err) {
            results[i] = { url: urls[i], gdriveUrl: null, error: err.message };
          })
          .then(function () {
            active--;
            if (cursor >= urls.length && active === 0) {
              resolve(results);
            } else {
              launch();
            }
          });
      }
    };
    launch();
  });
}

module.exports = {
  // Core resolvers
  resolveHubcloudUrl: resolveHubcloudUrl,
  resolveHubcdnUrl: resolveHubcdnUrl,
  resolveLinkProtectorUrl: resolveLinkProtectorUrl,
  resolveFromLinkProtector: resolveFromLinkProtector,
  resolvePixeldrainUrl: resolvePixeldrainUrl,
  resolveDownloadUrl: resolveDownloadUrl,
  resolveBatch: resolveBatch,

  // HTTP utilities (for scrapers that need custom fetch logic)
  fetchText: fetchText,
  followRedirectChain: followRedirectChain,

  // Constants
  USER_AGENT: USER_AGENT,
  FULL_HEADERS: FULL_HEADERS
};
