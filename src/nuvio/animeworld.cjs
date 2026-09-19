// ================================================================
// AnimeWorld India — Android TV Optimized
// ================================================================

var TMDB_KEY = 'd80ba92bc7cefe3359668d30d06f3305'
// Updated 2024-09: site moved from watchanimeworld.top → watchanimeworld.one.
// The .top domain still serves the search page but its result links now point
// to the .one domain. Using .one directly avoids the extra redirect.
// Also: the player iframe domain moved from play.zephyrix.top → play.zephyrix.org.
// We support BOTH TLDs in the regex below so the fix is forward-compatible.
var BASE     = 'https://watchanimeworld.one'
var PLAYER   = 'https://play.zephyrix.org'
var UA       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// got-scraping loader — watchanimeworld.top is behind Cloudflare which can
// 403 native fetch() requests. got-scraping uses Chrome's TLS fingerprint
// to bypass CF. Falls back to native fetch if got-scraping fails to load.
var _gotScrapingMod = null
function getGotScraping() {
  if (_gotScrapingMod !== null) return Promise.resolve(_gotScrapingMod)
  return import('got-scraping').then(function (mod) {
    _gotScrapingMod = mod.gotScraping || (mod.default && mod.default.gotScraping) || mod.default
    return _gotScrapingMod
  }).catch(function () {
    _gotScrapingMod = false
    return false
  })
}

// Bounded retry helper — zephyrix CDN rate-limits datacenter IPs on a
// window-by-window basis (~1/3 success observed). Individual attempts are
// independent, so 3 quick attempts lift per-request success substantially
// without meaningfully extending the happy path.
function withRetry(fn, attempts, gapMs) {
  function tryOnce(i) {
    return Promise.resolve().then(fn).catch(function (e) {
      if (i + 1 >= attempts) throw e
      return new Promise(function (r) { setTimeout(r, gapMs) }).then(function () { return tryOnce(i + 1) })
    })
  }
  return tryOnce(0)
}

function httpGet(url, headers) {
  var hdrs = Object.assign({ 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, headers || {})
  return getGotScraping().then(function (gs) {
    if (gs) {
      // Task 64: h2 → h1 fallback — CF gates on this host intermittently kill
      // h2 (GOAWAY) while h1 with the same browser JA3 lands (Task 52 pattern).
      function attempt(http2) {
        return gs({
          url: url,
          method: 'GET',
          headers: hdrs,
          timeout: { request: 35000 },
          throwHttpErrors: false,
          followRedirect: true,
          http2: http2,
          headerGeneratorOptions: {
            browsers: ['chrome'],
            devices: ['desktop'],
            operatingSystems: ['windows']
          }
        }).then(function (res) {
          if (res.statusCode >= 400) throw new Error('HTTP ' + res.statusCode + ' for ' + url.slice(0, 60))
          return res.body
        })
      }
      return attempt(true).catch(function () { return attempt(false) })
    }
    return fetch(url, { headers: hdrs }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.text()
    })
  })
}

function httpPost(url, body, headers) {
  var hdrs = Object.assign({
    'User-Agent': UA,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9'
  }, headers || {})
  return getGotScraping().then(function (gs) {
    if (gs) {
      function attempt(http2) {
        return gs({
          url: url,
          method: 'POST',
          headers: hdrs,
          body: body,
          timeout: { request: 35000 },
          throwHttpErrors: false,
          followRedirect: true,
          http2: http2,
          headerGeneratorOptions: {
            browsers: ['chrome'],
            devices: ['desktop'],
            operatingSystems: ['windows']
          }
        }).then(function (res) {
          if (res.statusCode >= 400) throw new Error('HTTP ' + res.statusCode)
          try { return JSON.parse(res.body) } catch (e) { throw new Error('JSON parse failed: ' + e.message) }
        })
      }
      return attempt(true).catch(function () { return attempt(false) })
    }
    return fetch(url, {
      method: 'POST',
      headers: hdrs,
      body: body
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
  })
}

// Build a list of search queries to try, in order:
//   1. Full TMDB title (e.g. "Demon Slayer: Kimetsu no Yaiba")
//   2. Main title only — before the first colon (e.g. "Demon Slayer")
//      The watchanimeworld.top search treats colons as separators, so the
//      full title with subtitle only matches the movie (which contains the
//      full subtitle in its title) but never the series (which is just
//      "Demon Slayer" without the subtitle).
//   3. Title with colons replaced by spaces
function buildQueries(title) {
  var queries = [title]
  var colonIdx = title.indexOf(':')
  if (colonIdx > 0) {
    var main = title.substring(0, colonIdx).trim()
    if (main) queries.push(main)
    var joined = title.replace(/:/g, ' ').replace(/\s+/g, ' ').trim()
    if (joined && joined !== title) queries.push(joined)
  }
  var seen = {}
  return queries.filter(function(q) { if (!q || seen[q]) return false; seen[q] = true; return true })
}

function searchSite(title, mediaType) {
  var queries = buildQueries(title)
  var wantedType = mediaType === 'movie' ? 'movies' : 'series'

  // Try queries sequentially — stop at the first one that yields at least
  // one result of the correct type.
  function tryQuery(idx) {
    if (idx >= queries.length) return Promise.resolve([])
    var query = queries[idx]
    var url = BASE + '/?s=' + encodeURIComponent(query)
    return httpGet(url, { 'Referer': BASE + '/' })
      .then(function(html) {
        var results = []
        var re = /href="(https:\/\/watchanimeworld\.(?:top|one)\/(series|movies)\/([^\/\"]+)\/)"/g
        var m
        while ((m = re.exec(html)) !== null) {
          var link = m[1], type = m[2], slug = m[3]
          if (slug && slug !== 'page') {
            results.push({ url: link, type: type, slug: slug })
          }
        }
        // Strict type filter — only keep results of the correct type
        var filtered = results.filter(function(r) { return r.type === wantedType })
        if (filtered.length === 0) {
          // No results of correct type — try next query variant
          return tryQuery(idx + 1)
        }
        return filtered
      })
  }

  return tryQuery(0)
}

function getEpisodeUrl(seriesUrl, season, episode) {
  return httpGet(seriesUrl, { 'Referer': BASE + '/' })
    .then(function(html) {
      var pidM = html.match(/postid-(\d+)/) || html.match(/data-post="(\d+)"/)
      if (!pidM) return null
      var ajaxUrl = BASE + '/wp-admin/admin-ajax.php?action=action_select_season&season=' + season + '&post=' + pidM[1]

      return httpGet(ajaxUrl, { 'Referer': seriesUrl })
        .then(function(epHtml) {
          var suffix = season + 'x' + episode + '/'
          var re = /href="(https:\/\/watchanimeworld\.(?:top|one)\/episode\/([^"]+))"/g
          var m
          while ((m = re.exec(epHtml)) !== null) {
            if (m[1].indexOf(suffix) !== -1) return m[1]
          }
          return null
        })
    })
}

function getStreamFromPage(pageUrl) {
  return httpGet(pageUrl, { 'Referer': BASE + '/' })
    .then(function(html) {
      var iframeM = html.match(/(?:src|data-src)="(https:\/\/play\.zephyrix\.(?:top|org)\/video\/([a-f0-9]+))"/)
      if (!iframeM) return null

      var videoHash = iframeM[2]
      // 3 attempts — the getVideo POST is the main zephyrix rate-limit hit
      // point; a rejected window usually clears within a second or two.
      return withRetry(function () {
        return httpPost(
          PLAYER + '/player/index.php?data=' + videoHash + '&do=getVideo',
          'hash=' + videoHash + '&r=' + encodeURIComponent(BASE + '/'),
          {
            'Referer': BASE + '/',
            'Origin': PLAYER,
            'X-Requested-With': 'XMLHttpRequest'
          }
        ).then(function(data) {
          // Prefer securedLink (master.m3u8?md5=...&expires=...) over videoSource
          // (master.txt). The .txt endpoint returns "security error" unless
          // accessed with the matching md5+expires signature.
          var m3u8 = data.securedLink || data.videoSource
          if (!m3u8) throw new Error('getVideo returned no link (rate-limited?)')

          var contentHashM = m3u8.match(/\/cdn\/hls\/([a-f0-9]+)\//)
          var contentHash  = contentHashM ? contentHashM[1] : videoHash
          var subtitleUrl = PLAYER + '/cdn/down/' + contentHash + '/Subtitle/subtitle_eng.srt'

          return { url: m3u8, subtitle: subtitleUrl }
        })
      }, 3, 1200)
    })
}

// Liveness gate — AnimeWorld streams ship through /proxy (Referer/UA headers
// set on the stream object), so a server-side probe sees exactly what the
// player will see. Upstream 4xx/5xx or an HTML challenge = guaranteed mpv
// error; drop the stream instead of shipping a dead card.
// 5 attempts spread over ~10s — zephyrix CDN 403s arrive in TEMPORAL windows
// (live-measured: same signed URL 403s for a stretch, then 200s 8/8 once the
// window clears). Rapid retries land inside the same window and die with it;
// spaced attempts actually cross it.
function streamAlive(url, headers) {
  var GAPS = [0, 1200, 2000, 3000, 4000]
  function attempt(i) {
    var wait = GAPS[i] || 0
    return new Promise(function (r) { setTimeout(r, wait) }).then(function () {
      return fetch(url, {
        headers: Object.assign({ Range: 'bytes=0-1023' }, headers || {}),
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      })
    }).then(function(res) {
      var ok = res.ok && !/text\/html/i.test(res.headers.get('content-type') || '')
      if (ok) return true
      if (i + 1 >= GAPS.length) return false
      return attempt(i + 1)
    }).catch(function() {
      if (i + 1 >= GAPS.length) return false
      return attempt(i + 1)
    })
  }
  return attempt(0)
}

function getStreams(tmdbId, mediaType, season, episode) {
  return new Promise(function(resolve) {
    var tmdbUrl = 'https://api.themoviedb.org/3/' + (mediaType === 'movie' ? 'movie' : 'tv') + '/' + tmdbId + '?api_key=' + TMDB_KEY

    httpGet(tmdbUrl)
      .then(function(body) { return JSON.parse(body) })
      .then(function(data) {
        var title = data.title || data.name
        return searchSite(title, mediaType)
      })
      .then(function(results) {
        if (!results || results.length === 0) { resolve([]); return null }
        var target = results[0].url

        if (mediaType === 'movie') return getStreamFromPage(target)
        return getEpisodeUrl(target, season, episode).then(function(epUrl) {
          return epUrl ? getStreamFromPage(epUrl) : null
        })
      })
      .then(function(streamData) {
        if (!streamData) { resolve([]); return }

        return streamAlive(streamData.url, {
          'Referer': PLAYER + '/',
          'User-Agent': UA,
        }).then(function(alive) {
          if (!alive) { resolve([]); return }

          resolve([{
          name: '🗡️ AnimeWorld',
          title: 'AnimeWorld • Multi-Audio 1080p',
          url: streamData.url,
          quality: '1080p',
          headers: {
            'Referer': PLAYER + '/',
            'Origin': PLAYER,
            'User-Agent': UA,
            'Connection': 'keep-alive'
          },
          subtitles: streamData.subtitle
            ? [{ url: streamData.subtitle, lang: 'en', name: 'English' }]
            : []
          }])
        })
      })
      .catch(function() {
        resolve([])
      })
  })
}

module.exports = { getStreams }
