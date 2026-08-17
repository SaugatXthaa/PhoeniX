// got_scraping_helper.cjs — provides got-scraping with http2: false for CF bypass
'use strict';

var _gotScraping = null;

function getGotScraping() {
  if (_gotScraping !== null) return Promise.resolve(_gotScraping);
  // Use dynamic import for got-scraping (it's an ESM package)
  return import('got-scraping').then(function (mod) {
    _gotScraping = mod.gotScraping;
    console.log('[gsHelper] got-scraping loaded:', typeof _gotScraping);
    return _gotScraping;
  }).catch(function (e) {
    console.error('[gsHelper] Failed to load got-scraping:', e.message);
    _gotScraping = false;
    return false;
  });
}

function httpGet(url, options) {
  options = options || {};
  var headers = options.headers || {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
  };
  var timeout = options.timeout || 25000;
  
  return getGotScraping().then(function (gs) {
    if (!gs) {
      throw new Error('got-scraping not available');
    }
    
    // Retry up to 3 times for intermittent CF challenges
    function attempt(tryNum) {
      return gs(url, {
        timeout: { request: timeout },
        throwHttpErrors: false,
        headers: headers,
        followRedirect: true,
        http2: false,
      }).then(function (res) {
        if (res.statusCode < 400) {
          return res.body || '';
        }
        if (tryNum < 2) {
          console.log('[gsHelper] Got ' + res.statusCode + ', retrying (' + (tryNum + 1) + '/3)...');
          return new Promise(function (r) { setTimeout(r, 2000); })
            .then(function () { return attempt(tryNum + 1); });
        }
        throw new Error('HTTP ' + res.statusCode + ' for ' + url);
      });
    }
    return attempt(0);
  });
}

module.exports = { httpGet: httpGet };
