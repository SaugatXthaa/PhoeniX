// ================================================================
// AnimeWorld India — Android TV Optimized
// ================================================================

var TMDB_KEY = 'd80ba92bc7cefe3359668d30d06f3305'
var BASE     = 'https://watchanimeworld.top'
var PLAYER   = 'https://play.zephyrix.top'
var UA       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function httpGet(url, headers) {
  return fetch(url, {
    headers: Object.assign({ 'User-Agent': UA }, headers || {})
  }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return r.text()
  })
}

function httpPost(url, body, headers) {
  return fetch(url, {
    method: 'POST',
    headers: Object.assign({
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded'
    }, headers || {}),
    body: body
  }).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return r.json()
  })
}

function searchSite(title, mediaType) {
  var url = BASE + '/?s=' + encodeURIComponent(title)
  return httpGet(url, { 'Referer': BASE + '/' })
    .then(function(html) {
      var results = []
      var re = /href="(https:\/\/watchanimeworld.top\/(series|movies)\/([^\/\"]+)\/)"/g
      var m
      while ((m = re.exec(html)) !== null) {
        var link = m[1], type = m[2], slug = m[3]
        if (slug && slug !== 'page') {
          results.push({ url: link, type: type, slug: slug })
        }
      }
      return results.filter(function(r) {
        return mediaType === 'movie' ? r.type === 'movies' : r.type === 'series'
      })
    })
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
          var re = /href="(https:\/\/watchanimeworld.top\/episode\/([^"]+))"/g
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
      var iframeM = html.match(/(?:src|data-src)="(https:\/\/play.zephyrix.top\/video\/([a-f0-9]+))"/)
      if (!iframeM) return null

      var videoHash = iframeM[2]
      return httpPost(
        PLAYER + '/player/index.php?data=' + videoHash + '&do=getVideo',
        'hash=' + videoHash + '&r=' + encodeURIComponent(BASE + '/'),
        {
          'Referer': BASE + '/',
          'Origin': PLAYER,
          'X-Requested-With': 'XMLHttpRequest'
        }
      ).then(function(data) {
        var m3u8 = data.videoSource || data.securedLink
        if (!m3u8) return null

        var contentHashM = m3u8.match(/\/cdn\/hls\/([a-f0-9]+)\//)
        var contentHash  = contentHashM ? contentHashM[1] : videoHash
        var subtitleUrl = PLAYER + '/cdn/down/' + contentHash + '/Subtitle/subtitle_eng.srt'

        return { url: m3u8, subtitle: subtitleUrl }
      })
    })
}

function getStreams(tmdbId, mediaType, season, episode) {
  return new Promise(function(resolve) {
    var tmdbUrl = 'https://api.themoviedb.org/3/' + (mediaType === 'movie' ? 'movie' : 'tv') + '/' + tmdbId + '?api_key=' + TMDB_KEY

    fetch(tmdbUrl)
      .then(function(r) { return r.json() })
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
      .catch(function() {
        resolve([])
      })
  })
}

module.exports = { getStreams }
