// src/nuvio/hub_extractor.cjs
// HubExtractor — Shared CommonJS module for resolving hubcloud/hubcdn/pixeldrain
// download links to direct Google Drive URLs.
//
// This file UNIFIES:
//   - The new resolver logic (from upload/hubextractor.js) — supports all
//     *.hubcloud.cx subdomains (pixel., gpdl., gpdl2., etc.)
//   - Metadata Extraction (ported from src/extractor/HubExtractor.js) —
//     extracts title, countryCodes, height, bytes from HubDrive/HubCloud pages
//   - Caching / Dedup (ported from src/extractor/HubExtractor.js) —
//     in-memory resolutionCache with TTL + eviction threshold, stripQueryParams
//     for canonical cache keys
//   - Security (ported from src/extractor/HubExtractor.js) —
//     DEAD_HUBCLOUD_HOSTS filter, URL validation, SSRF protection
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
// USED BY:
//   - src/nuvio/hdhub4u.cjs       — calls resolveDownloadUrl(url)
//   - src/nuvio/moviesdrive.cjs   — calls resolveHubcloudUrl(url)
//
// No Playwright, no FlareSolverr.

"use strict";

var { execFile } = require("child_process");
var path = require("path");

var cheerio;
try {
  cheerio = require("cheerio");
} catch (e) {
  cheerio = null;
}

// ===== CONSTANTS (ported from src/utils/hub.js) =====

var DEAD_HUBCLOUD_HOSTS = new Set([
  "hubcloud.ink",
  "hubcloud.co",
  "hubcloud.cc",
  "hubcloud.me",
  "hubcloud.xyz",
]);

var HUB_HOST_PATTERN = /hubcdn|hubcloud|hubdrive|gdflix|gyanigurus/;
var HUBCLOUD_CACHE_TTL = 5 * 60 * 1000; // 5 minutes — same as ESM HubExtractor
var DEFAULT_EVICTION_THRESHOLD = 64; // same as ESM HubExtractor

// ===== HEADERS / UA =====

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

// ===== SECURITY (ported from src/extractor/HubExtractor.js) =====

// Returns true if the host is in the dead-list. Used to skip dead mirrors
// (e.g. hubcloud.ink, hubcloud.co) before wasting a fetch.
function isDeadHost(hostname) {
  return DEAD_HUBCLOUD_HOSTS.has(hostname);
}

// SSRF guard — reject URLs that point at private/local network ranges.
// Protects against malicious pages embedding URLs like http://localhost:port
// or http://169.254.169.254 (cloud metadata endpoints).
function isPrivateUrl(urlStr) {
  try {
    var u = new URL(urlStr);
    var host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (host.endsWith(".localhost")) return true;
    if (host.startsWith("169.254.")) return true; // link-local / cloud metadata
    if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true; // 172.16.0.0/12
    return false;
  } catch (e) {
    return true; // invalid URL — treat as private (reject)
  }
}

// Validate that a URL is http(s) and not pointing at a private network.
function isSafeUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return false;
  if (!/^https?:\/\//i.test(urlStr)) return false;
  return !isPrivateUrl(urlStr);
}

// ===== METADATA EXTRACTION (ported from src/extractor/HubExtractor.js) =====

// Port of src/utils/language.js findCountryCodes()
// Detects language tags like "Hindi", "English", "Tamil" in a string and
// returns array of 2-letter codes (e.g. ['hi', 'en']).
var COUNTRY_CODE_MAP = {
  hi: "Hindi", en: "English", ta: "Tamil", te: "Telugu", ml: "Malayalam",
  kn: "Kannada", pa: "Punjabi", mr: "Marathi", bn: "Bengali", gu: "Gujarati",
  ur: "Urdu", fr: "French", es: "Spanish", de: "German", it: "Italian",
  pt: "Portuguese", ru: "Russian", ja: "Japanese", ko: "Korean", zh: "Chinese",
  ar: "Arabic", tr: "Turkish", pl: "Polish", nl: "Dutch", sv: "Swedish",
  th: "Thai", vi: "Vietnamese", id: "Indonesian", ms: "Malay",
};

function findCountryCodes(value) {
  if (!value) return [];
  var result = [];
  for (var cc in COUNTRY_CODE_MAP) {
    if (result.indexOf(cc) !== -1) continue;
    if (value.indexOf(COUNTRY_CODE_MAP[cc]) !== -1) result.push(cc);
  }
  return result;
}

// Port of src/utils/resolution.js findHeight()
// Parses quality strings like "1080p", "720p", "4K", "2160p" → height number.
var RESOLUTIONS = ["2160p", "1440p", "1080p", "720p", "576p", "480p", "360p", "240p", "144p"];

function findHeight(value) {
  if (!value) return undefined;
  var lower = value.toLowerCase();
  for (var i = 0; i < RESOLUTIONS.length; i++) {
    if (lower.indexOf(RESOLUTIONS[i]) !== -1) {
      return parseInt(RESOLUTIONS[i].replace("p", ""), 10);
    }
  }
  return undefined;
}

// Parse human-readable file size string → bytes
//   "1.5 GB" → 1610612736
//   "500 MB" → 524288000
//   "2 TB" → 2199023255552
function parseBytes(sizeText) {
  if (!sizeText || typeof sizeText !== "string") return undefined;
  var m = sizeText.match(/([\d.]+)\s*(GB|MB|TB|KB)/i);
  if (!m) return undefined;
  var num = parseFloat(m[1]);
  var unit = m[2].toUpperCase();
  if (isNaN(num)) return undefined;
  if (unit === "KB") return Math.round(num * 1024);
  if (unit === "MB") return Math.round(num * 1024 * 1024);
  if (unit === "GB") return Math.round(num * 1024 * 1024 * 1024);
  if (unit === "TB") return Math.round(num * 1024 * 1024 * 1024 * 1024);
  return undefined;
}

// Extract metadata from an HTML page (HubDrive or HubCloud page).
// Returns object with title, countryCodes, height, bytes — fields omitted if not found.
//
// Ported from src/extractor/HubExtractor.js extractHubDriveMeta() and
// HubCloud.js extractInternal title parsing.
function extractMetadata(html) {
  if (!html || !cheerio) return {};

  var $ = cheerio.load(html);
  var result = {};

  // Page title — strip "HubDrive |" prefix if present
  var pageTitle = $("title").text().replace(/^HubDrive\s*\|\s*/, "").trim();
  if (pageTitle) result.title = pageTitle;

  // File size from <td>File Size</td><td>XXX</td> pattern (HubDrive layout)
  var fileSizeText = "";
  $("td").each(function () {
    if (fileSizeText) return;
    if ($(this).text().trim() === "File Size") {
      fileSizeText = $(this).next().text().trim();
    }
  });
  // Fallback: <span id="size">XXX</span> (HubCloud gamerxyt page layout)
  if (!fileSizeText) {
    fileSizeText = $("#size").text().trim();
  }
  // Fallback: any "[1.5 GB]" pattern in body
  if (!fileSizeText) {
    var sizeMatch = html.match(/\[([\d.]+\s*[KMG]B)\]/i);
    if (sizeMatch) fileSizeText = sizeMatch[1];
  }
  if (fileSizeText) {
    var bytes = parseBytes(fileSizeText);
    if (bytes) result.bytes = bytes;
  }

  // Country codes (languages) from page title or body text
  var countryCodes = findCountryCodes(pageTitle + " " + fileSizeText);
  if (countryCodes.length > 0) result.countryCodes = countryCodes;

  // Height (quality) from page title or body text
  var height = findHeight(pageTitle);
  if (height !== undefined) result.height = height;

  return result;
}

// ===== CACHING / DEDUP (ported from src/extractor/HubExtractor.js) =====

// In-memory resolution cache — keyed by canonical (query-stripped) URL.
// Same TTL + eviction strategy as the ESM HubExtractor.
var resolutionCache = new Map();

// Returns cached result if fresh, else null.
function getCached(cacheKey) {
  var cached = resolutionCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < HUBCLOUD_CACHE_TTL) {
    return cached.url;
  }
  return null;
}

// Stores a resolved URL in cache. Evicts expired entries when threshold exceeded.
function setCached(cacheKey, resolvedUrl) {
  resolutionCache.set(cacheKey, { url: resolvedUrl, ts: Date.now() });
  if (resolutionCache.size > DEFAULT_EVICTION_THRESHOLD) {
    evictExpired();
  }
}

// Removes expired entries from the resolution cache.
function evictExpired() {
  var now = Date.now();
  for (var key of resolutionCache.keys()) {
    var entry = resolutionCache.get(key);
    if (now - entry.ts >= HUBCLOUD_CACHE_TTL) {
      resolutionCache.delete(key);
    }
  }
}

// Strip query params to produce a canonical cache key.
// Same as src/extractor/HubExtractor.js stripQueryParams().
function stripQueryParams(urlStr) {
  try {
    var u = new URL(urlStr);
    u.search = "";
    return u.href;
  } catch (e) {
    return urlStr; // not a valid URL — return as-is
  }
}

// ===== GOT-SCRAPING LOADER =====

var _gsHelper = null;
function getGsHelper() {
  if (_gsHelper !== null) return _gsHelper;
  try {
    _gsHelper = require("./got_scraping_helper.cjs");
  } catch (e) {
    try {
      _gsHelper = require(path.join(__dirname, "got_scraping_helper.cjs"));
    } catch (e2) {
      try {
        // Try .js extension as last resort
        _gsHelper = require("./got_scraping_helper");
      } catch (e3) {
        _gsHelper = false;
      }
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
  // SECURITY: validate URL before fetching
  if (!isSafeUrl(url)) {
    return Promise.reject(new Error("Unsafe URL blocked: " + String(url).slice(0, 80)));
  }

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
  // SECURITY: validate URL before following redirects
  if (!isSafeUrl(url)) {
    return Promise.reject(new Error("Unsafe URL blocked: " + String(url).slice(0, 80)));
  }

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
          var finalUrl = locations[locations.length - 1];
          // SECURITY: validate the final redirect URL
          if (!isSafeUrl(finalUrl)) {
            reject(new Error("Unsafe redirect blocked: " + finalUrl.slice(0, 80)));
            return;
          }
          resolve(finalUrl);
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
    // SECURITY: validate redirect target
    if (!isSafeUrl(loc)) throw new Error("Unsafe redirect blocked: " + loc.slice(0, 80));
    // Follow second hop if needed
    return fetch(loc, {
      headers: headers,
      redirect: "manual"
    }).then(function (res2) {
      var loc2 = res2.headers.get("location");
      if (loc2 && !isSafeUrl(loc2)) throw new Error("Unsafe redirect blocked: " + loc2.slice(0, 80));
      return loc2 || loc;
    }).catch(function () { return loc; });
  });
}

// ===== HUBCLOUD RESOLUTION =====

// Resolve a hubcloud.*/drive/<id> URL to a direct Google Drive download URL.
// Chain: hubcloud.* → gamerxyt.com → <subdomain>.hubcloud.cx → workers.dev → dl.php?link=<gdrive>
// Supported subdomains: pixel., gpdl., gpdl2., and any other *.hubcloud.cx
//
// CACHING: results are cached by canonical (query-stripped) URL for HUBCLOUD_CACHE_TTL.
// SECURITY: dead hosts are skipped; URL validation at every hop.
function resolveHubcloudUrl(hubcloudUrl) {
  // SECURITY: validate URL
  if (!isSafeUrl(hubcloudUrl)) {
    return Promise.reject(new Error("Unsafe URL blocked: " + String(hubcloudUrl).slice(0, 80)));
  }

  // SECURITY: skip dead hosts (e.g. hubcloud.ink, hubcloud.co)
  try {
    var parsed = new URL(hubcloudUrl);
    if (isDeadHost(parsed.hostname)) {
      return Promise.reject(new Error("Dead HubCloud host: " + parsed.hostname));
    }
  } catch (e) {
    return Promise.reject(new Error("Invalid URL: " + String(hubcloudUrl).slice(0, 80)));
  }

  // CACHING: check cache first
  var cacheKey = stripQueryParams(hubcloudUrl);
  var cached = getCached(cacheKey);
  if (cached) {
    return Promise.resolve(cached);
  }

  var gamerxytUrl = null;
  var hubcloudCdnUrl = null;

  return fetchText(hubcloudUrl)
    .then(function (html) {
      // Extract the gamerxyt URL from `var url = '...'`
      var match = html.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/);
      if (!match) throw new Error("No gamerxyt URL found in hubcloud page");
      gamerxytUrl = match[1];
      // SECURITY: validate gamerxyt URL
      if (!isSafeUrl(gamerxytUrl)) throw new Error("Unsafe gamerxyt URL: " + gamerxytUrl.slice(0, 80));
      return fetchText(gamerxytUrl, { Referer: "https://hubcloud.cx/" });
    })
    .then(function (gamerxytHtml) {
      // Extract ANY hubcloud.cx subdomain URL (pixel., gpdl., gpdl2., etc.)
      var match = gamerxytHtml.match(/https:\/\/[a-z0-9]+\.hubcloud\.cx\/\?id=[^"'\s]+/);
      if (!match) throw new Error("No hubcloud.cx CDN URL found");
      hubcloudCdnUrl = match[0];
      // SECURITY: validate CDN URL
      if (!isSafeUrl(hubcloudCdnUrl)) throw new Error("Unsafe CDN URL: " + hubcloudCdnUrl.slice(0, 80));
      // Follow hubcloud.cx → workers.dev → dl.php?link=<gdrive>
      return followRedirectChain(hubcloudCdnUrl, { Referer: "https://gamerxyt.com/" });
    })
    .then(function (finalUrl) {
      // The final URL should be dl.php?link=<googleusercontent_url>
      // Extract the googleusercontent URL from the link= parameter
      var match = finalUrl.match(/link=(https:\/\/video-downloads\.googleusercontent\.com\/[^&]+)/);
      if (!match) throw new Error("No googleusercontent URL in redirect chain");
      var gdriveUrl = match[1];
      // SECURITY: final sanity check — must be a googleusercontent URL
      if (!isSafeUrl(gdriveUrl) || gdriveUrl.indexOf("googleusercontent.com") === -1) {
        throw new Error("Final URL is not a googleusercontent URL: " + gdriveUrl.slice(0, 80));
      }
      // CACHING: store resolved URL
      setCached(cacheKey, gdriveUrl);
      return gdriveUrl;
    });
}

// ===== HUBCDN RESOLUTION (base64 decode) =====

// Resolve a hubcdn.sbs/file/<id> URL to a direct Google Drive download URL.
// Chain: hubcdn.sbs → extract `var reurl` → base64 decode → extract GDrive URL
function resolveHubcdnUrl(hubcdnUrl) {
  // SECURITY: validate URL
  if (!isSafeUrl(hubcdnUrl)) {
    return Promise.reject(new Error("Unsafe URL blocked: " + String(hubcdnUrl).slice(0, 80)));
  }

  // CACHING: check cache first
  var cacheKey = stripQueryParams(hubcdnUrl);
  var cached = getCached(cacheKey);
  if (cached) {
    return Promise.resolve(cached);
  }

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
      var gdriveUrl = gucMatch[1];

      // SECURITY: final sanity check
      if (!isSafeUrl(gdriveUrl)) {
        throw new Error("Decoded URL is not safe: " + gdriveUrl.slice(0, 80));
      }

      // CACHING: store resolved URL
      setCached(cacheKey, gdriveUrl);
      return gdriveUrl;
    });
}

// ===== LINK PROTECTOR RESOLUTION =====

// Fetch a link protector page (gyanigurus.online, hindifire.store, magiclinks.lol)
// and find hubcloud.*/drive/<id> link.
function resolveLinkProtectorUrl(protectorUrl) {
  // SECURITY: validate URL
  if (!isSafeUrl(protectorUrl)) {
    return Promise.reject(new Error("Unsafe URL blocked: " + String(protectorUrl).slice(0, 80)));
  }

  return fetchText(protectorUrl)
    .then(function (html) {
      // Find any hubcloud.* link (hubcloud.cx, hubcloud.foo, hubcloud.ist, etc.)
      var match = html.match(/https:\/\/hubcloud\.[a-z]+\/drive\/[a-zA-Z0-9_]+/);
      if (!match) throw new Error("No hubcloud link found on protector page");
      var hubcloudUrl = match[0];

      // SECURITY: skip dead hosts found on protector page
      try {
        var parsed = new URL(hubcloudUrl);
        if (isDeadHost(parsed.hostname)) {
          throw new Error("Dead HubCloud host on protector page: " + parsed.hostname);
        }
      } catch (e) {
        if (e.message.indexOf("Dead HubCloud host") !== -1) throw e;
        // else: URL parse failed — fall through, the next resolveHubcloudUrl call will reject
      }

      return hubcloudUrl;
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
//
// CACHING: all resolvers use the shared resolutionCache. SECURITY: dead hosts
// and unsafe URLs are rejected at every hop.
function resolveDownloadUrl(url) {
  // SECURITY: validate URL first
  if (!isSafeUrl(url)) {
    return Promise.resolve(null);
  }

  // Hubcloud chain
  if (url.match(/https:\/\/hubcloud\.[a-z]+\/drive\//)) {
    // SECURITY: skip dead hubcloud hosts
    try {
      var parsed = new URL(url);
      if (isDeadHost(parsed.hostname)) return Promise.resolve(null);
    } catch (e) { /* fall through */ }

    return resolveHubcloudUrl(url).catch(function () { return null; });
  }

  // Hubcdn chain (base64 decode)
  if (url.indexOf("hubcdn.sbs") !== -1) {
    return resolveHubcdnUrl(url).catch(function () { return null; });
  }

  // Link protector → hubcloud
  if (url.match(/gyanigurus\.online|hindifire\.store|magiclinks\.lol/)) {
    return resolveFromLinkProtector(url).catch(function () { return null; });
  }

  // Pixeldrain
  if (url.match(/pixeldrain\.(com|dev)\/[ul]\//)) {
    return resolvePixeldrainUrl(url).catch(function () { return null; });
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
  // Core resolvers (API preserved for hdhub4u.cjs + moviesdrive.cjs compatibility)
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

  // Metadata extraction (ported from ESM HubExtractor)
  extractMetadata: extractMetadata,
  findCountryCodes: findCountryCodes,
  findHeight: findHeight,
  parseBytes: parseBytes,

  // Caching / Dedup (ported from ESM HubExtractor)
  // Exposed so scrapers can pre-populate the cache or inspect it.
  resolutionCache: resolutionCache,
  stripQueryParams: stripQueryParams,
  getCached: getCached,
  setCached: setCached,
  evictExpired: evictExpired,
  HUBCLOUD_CACHE_TTL: HUBCLOUD_CACHE_TTL,
  DEFAULT_EVICTION_THRESHOLD: DEFAULT_EVICTION_THRESHOLD,

  // Security (ported from ESM HubExtractor)
  DEAD_HUBCLOUD_HOSTS: DEAD_HUBCLOUD_HOSTS,
  HUB_HOST_PATTERN: HUB_HOST_PATTERN,
  isDeadHost: isDeadHost,
  isPrivateUrl: isPrivateUrl,
  isSafeUrl: isSafeUrl,

  // Constants
  USER_AGENT: USER_AGENT,
  FULL_HEADERS: FULL_HEADERS
};
