// MoviesDrive Scraper — Returns direct playable GDrive streams
// =================================================================
// Scrapes new2.moviesdrive.christmas → mdrive.lol → hubcloud.cx → GDrive
//
// Flow:
//   1. Search via WordPress REST API: /wp-json/wp/v2/posts?search=<title>
//   2. Fetch movie page → find mdrive.lol/archive/<id>/ links with quality labels
//   3. For each archive: fetch mdrive.lol → find hubcloud.[a-z]+/drive/<id> link
//   4. Resolve hubcloud.cx → gamerxyt.com → hubcloud.cx CDN → workers.dev → GDrive
//   5. Return direct video-downloads.googleusercontent.com URL (playable)
//
// No Playwright, no FlareSolverr — uses hub_extractor for GDrive resolution.

'use strict';

var cheerio = require('cheerio');
var hubExtractor = require('./hub_extractor.cjs');

var PROVIDER_NAME = 'MoviesDrive';
var BASE_URL = 'https://new2.moviesdrive.christmas';
var ARCHIVE_URL = 'https://mdrive.lol';
var TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

function fetchText(url, referer) {
  var headers = { 'User-Agent': UA, 'Accept': 'text/html,application/json' };
  if (referer) headers['Referer'] = referer;
  return fetch(url, { headers: headers, signal: AbortSignal.timeout(15000), redirect: 'follow' })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url.slice(0, 80));
      return res.text();
    });
}

function getTMDBInfo(tmdbId, type) {
  var endpoint = type === 'tv' ? 'tv' : 'movie';
  var url = 'https://api.themoviedb.org/3/' + endpoint + '/' + tmdbId + '?api_key=' + TMDB_API_KEY;
  return fetchText(url)
    .then(function (body) {
      var d = JSON.parse(body);
      if (!d || d.success === false) return null;
      return {
        title: type === 'tv' ? d.name : d.title,
        year: parseInt((d.first_air_date || d.release_date || '').slice(0, 4)) || null,
      };
    })
    .catch(function () { return null; });
}

// Search via WordPress REST API — much more reliable than HTML search
function findMoviePage(title, year) {
  var searchUrl = BASE_URL + '/wp-json/wp/v2/posts?search=' + encodeURIComponent(title) + '&_fields=link,title,slug';
  return fetchText(searchUrl)
    .then(function (body) {
      var posts = JSON.parse(body);
      if (!Array.isArray(posts) || posts.length === 0) return null;

      var bestMatch = null;
      var bestScore = 0;

      posts.forEach(function (post) {
        var postTitle = post.title && post.title.rendered ? post.title.rendered : '';
        var link = post.link;
        var score = 0;

        // Decode HTML entities
        postTitle = postTitle.replace(/&#\d+;/g, '').replace(/&amp;/g, '&').replace(/&#038;/g, '&');

        var lowerTitle = postTitle.toLowerCase();
        var lowerSearch = title.toLowerCase();

        // Exact title match
        if (lowerTitle.includes(lowerSearch)) score += 50;

        // Year match
        if (year && postTitle.includes(String(year))) score += 30;

        // Penalize different years
        var yearMatches = postTitle.match(/\b(19|20)\d{2}\b/g);
        if (yearMatches && year) {
          yearMatches.forEach(function (y) {
            if (Math.abs(parseInt(y) - year) > 1) score -= 15;
          });
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = link;
        }
      });

      return bestScore >= 50 ? bestMatch : null;
    })
    .catch(function () { return null; });
}

// Parse the movie page to find archive links with quality labels
function findArchiveLinks(moviePageUrl) {
  return fetchText(moviePageUrl)
    .then(function (html) {
      var $ = cheerio.load(html);
      var archives = [];
      var seenIds = {};

      // Find all links to mdrive.lol/archive/
      $('a[href*="mdrive.lol/archive/"]').each(function () {
        var href = $(this).attr('href') || '';
        var label = $(this).text().trim() || '';

        // Also look at the surrounding heading for quality info
        var parentHeading = $(this).closest('h1, h2, h3, h4, h5, h6');
        var headingText = parentHeading.text().trim();
        var contextLabel = headingText || label;

        // Extract archive ID
        var idMatch = href.match(/\/archive\/(\d+)/);
        if (!idMatch) return;
        var archiveId = idMatch[1];
        if (seenIds[archiveId]) return;
        seenIds[archiveId] = true;

        // Parse quality from context
        var quality = '1080p';
        var contextLower = contextLabel.toLowerCase();
        if (contextLower.includes('2160p') || contextLower.includes('4k')) quality = '2160p';
        else if (contextLower.includes('1080p')) quality = '1080p';
        else if (contextLower.includes('720p')) quality = '720p';
        else if (contextLower.includes('480p')) quality = '480p';

        // Parse size from context
        var sizeMatch = contextLabel.match(/\[?([\d.]+)\s*(GB|MB)\]?/i);
        var size = sizeMatch ? sizeMatch[1] + ' ' + sizeMatch[2].toUpperCase() : '';

        // Parse codec
        var codec = '';
        if (contextLower.includes('hevc') || contextLower.includes('x265') || contextLower.includes('h265')) codec = 'HEVC';
        else if (contextLower.includes('x264') || contextLower.includes('h264')) codec = 'x264';

        // Build full archive URL
        var fullUrl = ARCHIVE_URL + '/archive/' + archiveId + '/';

        archives.push({
          url: fullUrl,
          id: archiveId,
          quality: quality,
          codec: codec,
          size: size,
          label: contextLabel,
        });
      });

      // Also check for direct hubcloud links (older posts)
      $('a[href*="hubcloud.[a-z]+/drive/"]').each(function () {
        var href = $(this).attr('href') || '';
        var label = $(this).text().trim() || '';
        var parentHeading = $(this).closest('h1, h2, h3, h4, h5, h6');
        var headingText = parentHeading.text().trim();
        var contextLabel = headingText || label;

        var quality = '1080p';
        var contextLower = contextLabel.toLowerCase();
        if (contextLower.includes('2160p') || contextLower.includes('4k')) quality = '2160p';
        else if (contextLower.includes('1080p')) quality = '1080p';
        else if (contextLower.includes('720p')) quality = '720p';
        else if (contextLower.includes('480p')) quality = '480p';

        var sizeMatch = contextLabel.match(/\[?([\d.]+)\s*(GB|MB)\]?/i);
        var size = sizeMatch ? sizeMatch[1] + ' ' + sizeMatch[2].toUpperCase() : '';

        var codec = '';
        if (contextLower.includes('hevc') || contextLower.includes('x265')) codec = 'HEVC';
        else if (contextLower.includes('x264') || contextLower.includes('h264')) codec = 'x264';

        archives.push({
          url: href,
          id: 'direct-' + archives.length,
          quality: quality,
          codec: codec,
          size: size,
          label: contextLabel,
          isDirectHubcloud: true,
        });
      });

      // Also check for hubcloud search-recover links (older posts use hubcloud.foo)
      // These need an API call to resolve to actual drive/<id> URLs
      $('a[href*="hubcloud"][href*="search-recover"]').each(function () {
        var href = $(this).attr('href') || '';
        var label = $(this).text().trim() || '';
        var parentHeading = $(this).closest('h1, h2, h3, h4, h5, h6');
        var headingText = parentHeading.text().trim();
        var contextLabel = headingText || label;

        // Decode the base64 q parameter to get the search query
        var qMatch = href.match(/q=([^&]+)/);
        var searchQuery = '';
        if (qMatch) {
          try {
            // Pad base64 and decode
            var b64 = qMatch[1].replace(/-/g, '+').replace(/_/g, '/');
            b64 = b64.padEnd(4 * Math.ceil(b64.length / 4), '=');
            searchQuery = Buffer.from(b64, 'base64').toString('utf8');
          } catch (e) {}
        }

        var quality = '1080p';
        var contextLower = contextLabel.toLowerCase();
        if (contextLower.includes('2160p') || contextLower.includes('4k')) quality = '2160p';
        else if (contextLower.includes('1080p')) quality = '1080p';
        else if (contextLower.includes('720p')) quality = '720p';
        else if (contextLower.includes('480p')) quality = '480p';

        var sizeMatch = contextLabel.match(/\[?([\d.]+)\s*(GB|MB)\]?/i);
        var size = sizeMatch ? sizeMatch[1] + ' ' + sizeMatch[2].toUpperCase() : '';

        var codec = '';
        if (contextLower.includes('hevc') || contextLower.includes('x265')) codec = 'HEVC';
        else if (contextLower.includes('x264') || contextLower.includes('h264')) codec = 'x264';

        // Replace hubcloud.foo with hubcloud.cx (cx doesn't have CF challenge)
        var fixedUrl = href.replace(/hubcloud\.foo/g, 'hubcloud.cx');

        archives.push({
          url: fixedUrl,
          id: 'search-' + archives.length,
          quality: quality,
          codec: codec,
          size: size,
          label: contextLabel,
          isSearchRecover: true,
          searchQuery: searchQuery,
        });
      });

      return archives;
    });
}

// Resolve an archive link to a direct GDrive URL
function resolveArchiveLink(archive) {
  // If it's a direct hubcloud.cx/drive/<id> link, resolve it directly
  if (archive.isDirectHubcloud) {
    return hubExtractor.resolveHubcloudUrl(archive.url)
      .then(function (gdriveUrl) {
        return { url: gdriveUrl, source: 'HubCloud' };
      })
      .catch(function () { return null; });
  }

  // If it's a search-recover link, call the API to find the actual drive URL
  if (archive.isSearchRecover) {
    // The search-recover URL has a base64-encoded q parameter.
    // The API expects the DECODED query (e.g. "Inception 2010 480p", not "SW5jZXB0aW9u...")
    // Extract from_ac token and build API URL with decoded q
    var fromAcMatch = archive.url.match(/from_ac=([^&]+)/);
    var fromAc = fromAcMatch ? fromAcMatch[1] : '';
    var apiUrl = 'https://hubcloud.cx/drive/search-recover.php?api=search&q=' +
      encodeURIComponent(archive.searchQuery || '') +
      '&page=1&from_ac=' + fromAc;

    return fetchText(apiUrl, BASE_URL + '/')
      .then(function (body) {
        try {
          var data = JSON.parse(body);
          if (data.hits && data.hits.length > 0) {
            // HubCloud honeypot detection:
            // When the requested movie has been DMCA-removed from HubCloud,
            // the search-recover.php API returns a fake "honeypot" file —
            // "Three Thousand Years of Longing (2022)" with file ID
            // '9fm1fbqq04e9qq_'. This happens regardless of what movie was
            // searched. We detect and skip honeypot hits so we don't return
            // streams for the wrong movie.
            var isHoneypot = function (hit) {
              var url = String(hit.url || '');
              var fileName = String(hit.file_name || '').toLowerCase();
              // Honeypot by file ID
              if (url.indexOf('9fm1fbqq04e9qq_') !== -1) return true;
              // Honeypot by file name (catches future ID changes)
              if (fileName.indexOf('three thousand years of longing') !== -1) return true;
              return false;
            };
            // Find first non-honeypot hit
            var realHit = null;
            for (var i = 0; i < data.hits.length; i++) {
              if (data.hits[i].url && !isHoneypot(data.hits[i])) {
                realHit = data.hits[i];
                break;
              }
            }
            if (realHit) {
              return realHit.url; // hubcloud.cx/drive/<id>
            }
            // All hits were honeypot — movie is DMCA'd on HubCloud
            console.log('[MoviesDrive] All API hits were honeypot (DMCA\'d content) — skipping');
            return null;
          }
        } catch (e) {}
        return null;
      })
      .then(function (hubcloudDriveUrl) {
        if (!hubcloudDriveUrl) return null;
        return hubExtractor.resolveHubcloudUrl(hubcloudDriveUrl)
          .then(function (gdriveUrl) {
            return { url: gdriveUrl, source: 'HubCloud' };
          })
          .catch(function () { return null; });
      })
      .catch(function () { return null; });
  }

  // Otherwise, fetch the mdrive.lol archive page and find the hubcloud link
  return fetchText(archive.url, BASE_URL + '/')
    .then(function (html) {
      var $ = cheerio.load(html);
      var hubcloudUrl = null;

      $('a[href*="hubcloud.[a-z]+/drive/"]').each(function () {
        hubcloudUrl = $(this).attr('href');
      });

      if (!hubcloudUrl) {
        // Try hubcloud.foo as fallback (may be CF-blocked)
        $('a[href*="hubcloud"]').each(function () {
          var href = $(this).attr('href') || '';
          if (href.includes('/drive/') && !href.includes('search-recover')) {
            hubcloudUrl = href;
          }
        });
      }

      if (!hubcloudUrl) return null;

      return hubExtractor.resolveHubcloudUrl(hubcloudUrl)
        .then(function (gdriveUrl) {
          return { url: gdriveUrl, source: 'HubCloud' };
        })
        .catch(function () { return null; });
    })
    .catch(function () { return null; });
}

function getStreams(tmdbId, type, season, episode) {
  var isMovie = type !== 'tv';
  if (!tmdbId) return [];

  console.log('[MoviesDrive] Request: tmdb=' + tmdbId + ' type=' + type);

  return getTMDBInfo(tmdbId, type)
    .then(function (info) {
      if (!info || !info.title) {
        console.log('[MoviesDrive] Could not resolve TMDB info');
        return [];
      }
      console.log('[MoviesDrive] TMDB: ' + info.title + ' (' + info.year + ')');

      return findMoviePage(info.title, info.year)
        .then(function (pageUrl) {
          if (!pageUrl) {
            console.log('[MoviesDrive] No matching page found');
            return [];
          }
          console.log('[MoviesDrive] Found page: ' + pageUrl.slice(0, 60));

          return findArchiveLinks(pageUrl)
            .then(function (archives) {
              console.log('[MoviesDrive] Found ' + archives.length + ' archive links');

              // Resolve each archive link in parallel (limit to 6 at a time)
              var batchSize = 6;
              var results = [];

              function processBatch(startIdx) {
                if (startIdx >= archives.length) return Promise.resolve();

                var batch = archives.slice(startIdx, startIdx + batchSize);
                return Promise.all(
                  batch.map(function (archive) {
                    return resolveArchiveLink(archive)
                      .then(function (resolved) {
                        if (!resolved || !resolved.url) return null;
                        return { archive: archive, resolved: resolved };
                      });
                  })
                ).then(function (batchResults) {
                  results = results.concat(batchResults);
                  return processBatch(startIdx + batchSize);
                });
              }

              return processBatch(0).then(function () {
                var streams = [];
                results.forEach(function (r) {
                  if (!r) return;
                  var a = r.archive;
                  var titleLine = info.title + ' (' + info.year + ') ' + a.quality;
                  if (a.size) titleLine += ' ' + a.size;
                  if (a.codec) titleLine += ' ' + a.codec;

                  streams.push({
                    name: PROVIDER_NAME + ' - ' + a.quality + (a.codec ? ' ' + a.codec : ''),
                    title: titleLine,
                    url: r.resolved.url,
                    quality: a.quality,
                    type: 'video/mkv',
                    headers: { 'User-Agent': UA },
                    behaviorHints: {
                      bingeGroup: 'moviesdrive-' + a.quality + (a.codec ? '-' + a.codec : ''),
                    },
                  });
                });

                console.log('[MoviesDrive] Returning ' + streams.length + ' playable streams');
                return streams;
              });
            });
        });
    })
    .catch(function (e) {
      console.log('[MoviesDrive] Error: ' + e.message);
      return [];
    });
}

module.exports = { getStreams: getStreams };

if (require.main === module) {
  (async () => {
    var args = process.argv.slice(2);
    var tmdbId = args[0] || '27205';
    var type = args[1] || 'movie';
    console.log('=== MoviesDrive Scraper ===');
    var streams = await getStreams(tmdbId, type);
    console.log('\nTotal: ' + streams.length);
    streams.forEach(function (s, i) {
      console.log('[' + i + '] ' + s.name + ' | ' + s.quality);
      console.log('    URL: ' + s.url.slice(0, 120));
    });
  })();
}
