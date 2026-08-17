// got_scraping_helper.cjs — provides got-scraping with http2: false for CF bypass
'use strict';

var _gotScraping = null;

async function getGotScraping() {
  if (_gotScraping) return _gotScraping;
  try {
    var mod = await import('got-scraping');
    _gotScraping = mod.gotScraping;
  } catch (e) {
    console.error('[gsHelper] Failed to load got-scraping:', e.message);
    _gotScraping = false;
  }
  return _gotScraping;
}

async function httpGet(url, options) {
  options = options || {};
  var headers = options.headers || {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
  };
  var timeout = options.timeout || 25000;
  
  var gs = await getGotScraping();
  if (!gs) {
    throw new Error('got-scraping not available');
  }
  
  // Retry up to 3 times for intermittent CF challenges
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var res = await gs(url, {
        timeout: { request: timeout },
        throwHttpErrors: false,
        headers: headers,
        followRedirect: true,
        http2: false,  // KEY: http2: false bypasses CF on Render
      });
      if (res.statusCode < 400) {
        return res.body || '';
      }
      // Retry on 403 (CF challenge)
      if (attempt < 2) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        continue;
      }
      throw new Error('HTTP ' + res.statusCode + ' for ' + url);
    } catch (e) {
      if (attempt < 2) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        continue;
      }
      throw e;
    }
  }
  throw new Error('Max retries exceeded for ' + url);
}

module.exports = { httpGet: httpGet };
