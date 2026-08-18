// Shared got-scraping loader. got-scraping is ESM-only, so we use
// dynamic import() to load it from CommonJS. The loaded function is
// cached so subsequent calls are fast.

var _cached = null;
var _loading = null;

function loadGotScraping() {
  if (_cached) return Promise.resolve(_cached);
  if (_loading) return _loading;
  _loading = import("got-scraping").then(function (mod) {
    _cached = mod.gotScraping || (mod.default && mod.default.gotScraping) || mod.default;
    _loading = null;
    return _cached;
  }).catch(function () {
    _cached = false;
    _loading = null;
    return false;
  });
  return _loading;
}

// Convenience: fetch a URL with got-scraping, falling back to plain fetch.
function httpGet(url, options) {
  options = options || {};
  var headers = options.headers || {};
  return loadGotScraping().then(function (gs) {
    if (gs) {
      return gs({
        url: url,
        headers: headers,
        body: options.body,
        method: options.method || "GET",
        timeout: { request: options.timeout || 20000 },
        retry: { limit: 1 },
        headerGeneratorOptions: options.headerGeneratorOptions || {
          browsers: ["chrome"],
          devices: ["desktop"],
          operatingSystems: ["windows"]
        }
      }).then(function (response) {
        return response.body || "";
      });
    }
    // Fallback: plain fetch
    return fetch(url, {
      method: options.method || "GET",
      headers: headers,
      body: options.body,
      redirect: "follow"
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      return res.text();
    });
  });
}

module.exports = { loadGotScraping: loadGotScraping, httpGet: httpGet };
