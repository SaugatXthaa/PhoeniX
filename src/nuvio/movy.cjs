// Movy.bz / Vidy.st All-In-One Scraper — Enhanced with got-scraping + curl
// ========================================================================
// Uses the ACTUAL streamcrypto module from vidy.st's JS bundle (module 1549)
// to decrypt responses from api.wecollege.net.
//
// ENHANCEMENTS:
//   1. got-scraping for ALL fetch calls — bypasses Cloudflare TLS fingerprinting
//      by impersonating Chrome's TLS handshake (JA3/JA4 fingerprint)
//   2. curl fallback via child_process — if got-scraping fails, shells out to
//      curl which has a different TLS fingerprint
//   3. JSON error detection — /sources endpoints that return JSON error objects
//      (instead of encrypted base64) are now handled gracefully (fixes Boston/Berlin)
//   4. Content-Type-aware response parsing — only parses as JSON for JSON
//      content types; returns raw text for encrypted (text/plain) responses
//
// All 12 city servers are queried sequentially:
//   Miami, Boston, Seattle, Denver, Austin, Chicago, Dallas,
//   Munich, Berlin, Paris, Delhi, Cancun
//
// Protocol: "streamcrypto" with seed-based XOR cipher
// Architecture: Pure Node.js + got-scraping + curl + the original bundle's decrypt
// No Playwright, no FlareSolverr.

'use strict';

const { execFileSync } = require('child_process');

const PROVIDER_NAME = 'Movy';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const MOVY_API = 'https://api.wecollege.net';
const VIDY_ORIGIN = 'https://www.vidy.st';
const TMDB_API_BASE = 'https://api.themoviedb.org/3';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// All 12 servers
const ALL_SERVERS = [
  'miami', 'boston', 'seattle', 'denver', 'austin',
  'chicago', 'dallas', 'munich', 'berlin', 'paris',
  'delhi', 'cancun',
];

// =================== HTTP FETCHER (got-scraping + curl fallback) ===================

let _gotScraping = null;

async function loadGotScraping() {
  if (_gotScraping !== null) return _gotScraping;
  try {
    const mod = await import('got-scraping');
    _gotScraping = mod.gotScraping || (mod.default && mod.default.gotScraping) || mod.default;
    if (!_gotScraping) _gotScraping = false;
  } catch (e) {
    _gotScraping = false;
  }
  return _gotScraping;
}

// Fetch a URL using got-scraping (bypasses Cloudflare TLS fingerprinting)
async function httpGetGot(url, options) {
  options = options || {};
  const gs = await loadGotScraping();
  if (!gs) return null;

  try {
    const response = await gs({
      url: url,
      headers: Object.assign({
        'User-Agent': UA,
        'Origin': VIDY_ORIGIN,
        'Referer': VIDY_ORIGIN + '/',
      }, options.headers || {}),
      method: options.method || 'GET',
      body: options.body,
      timeout: { request: options.timeout || 15000 },
      retry: { limit: 1 },
      headerGeneratorOptions: {
        browsers: ['chrome'],
        devices: ['desktop'],
        operatingSystems: ['windows'],
      },
    });
    return {
      status: response.statusCode,
      body: response.body,
      contentType: response.headers['content-type'] || '',
    };
  } catch (e) {
    return null;
  }
}

// Fetch a URL using curl (different TLS fingerprint, may bypass blocks)
function httpGetCurl(url, options) {
  options = options || {};
  const headers = Object.assign({
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': VIDY_ORIGIN,
    'Referer': VIDY_ORIGIN + '/',
  }, options.headers || {});

  const args = [
    '-sSk',
    '--max-time', String(options.timeout || 15),
    '-L',
    '--compressed',
    '-w', '\n---CURL_META---\n%{http_code}\n%{content_type}',
  ];

  // Add headers
  Object.keys(headers).forEach(function (key) {
    args.push('-H', key + ': ' + headers[key]);
  });

  // Add body
  if (options.body) {
    args.push('-X', options.method || 'POST');
    args.push('--data-raw', options.body);
  }

  args.push(url);

  try {
    const output = execFileSync('curl', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: (options.timeout || 15) * 1000 + 5000,
      encoding: 'utf8',
    });

    // Parse the response — last 2 lines are HTTP code and content-type
    const metaMarker = '\n---CURL_META---\n';
    const metaIdx = output.lastIndexOf(metaMarker);
    if (metaIdx < 0) return null;

    const body = output.slice(0, metaIdx);
    const meta = output.slice(metaIdx + metaMarker.length).trim().split('\n');
    const status = parseInt(meta[0], 10) || 0;
    const contentType = meta[1] || '';

    return { status: status, body: body, contentType: contentType };
  } catch (e) {
    return null;
  }
}

// Smart fetch: try got-scraping first, fall back to curl, then plain fetch
async function smartFetch(url, options) {
  options = options || {};

  // Try 1: got-scraping (Chrome TLS fingerprint)
  const gsResult = await httpGetGot(url, options);
  if (gsResult && gsResult.status >= 200 && gsResult.status < 500) {
    return gsResult;
  }

  // Try 2: curl (different TLS fingerprint)
  const curlResult = httpGetCurl(url, options);
  if (curlResult && curlResult.status >= 200 && curlResult.status < 500) {
    return curlResult;
  }

  // Try 3: plain Node.js fetch (last resort)
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: Object.assign({
        'User-Agent': UA,
        'Origin': VIDY_ORIGIN,
        'Referer': VIDY_ORIGIN + '/',
      }, options.headers || {}),
      body: options.body,
      signal: AbortSignal.timeout(options.timeout ? options.timeout * 1000 : 15000),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text,
      contentType: res.headers.get('content-type') || '',
    };
  } catch (e) {
    return null;
  }
}

// =================== STREAMCRYPTO MODULE (from vidy.st bundle) ===================

const MODULE_1549_SRC = `
function(e,t,a){
  a.d(t,{i:function(){return _},b:function(){return b}});
  (r=n||(n={})).NONE="NONE",r.MIAMI="MIAMI",r.BOSTON="BOSTON",r.SEATTLE="SEATTLE",r.DENVER="DENVER",r.AUSTIN="AUSTIN",r.CHICAGO="CHICAGO",r.DALLAS="DALLAS",r.MUNICH="MUNICH",r.BERLIN="BERLIN",r.PARIS="PARIS",r.CANCUN="CANCUN",r.DELHI="DELHI";
  var r,n,s=a(2432);
  let o=new Map;
  function i(e){return new URL(e).origin}
  async function d(e,t){
    var a;let r=i(e),n="".concat(r,"|").concat(t),d=Date.now(),l=o.get(n);
    if(l&&l.expiresAt-5e3>d)return l.seed;
    let u=await(0,s.Wg)("".concat(r,"/seed"),{params:{mediaId:t},retry:1}),c=null!==(a=u.ttlMs)&&void 0!==a?a:3e4;
    return o.set(n,{seed:u.seed,expiresAt:d+c}),u.seed
  }
  let l=[1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598601,607225278,1426881987,1925078388,2162078206,2614888103,3248222580],u=[109,118,109,49],c=e=>(e*(e+1)&1)==0,m=e=>(e*(e+1)&1)==1;
  function p(e){return e>>>=0,e^=e>>>16,e=Math.imul(e,2246822507)>>>0,e^=e>>>13,e=Math.imul(e,3266489909)>>>0,(e^=e>>>16)>>>0}
  function g(e,t){return(e>>>=0,0==(t&=31))?e>>>0:(e<<t|e>>>32-t)>>>0}
  async function b(e,t,a,r){
    if(void 0===a)throw Error("mediaId is required to decode sources");
    let n=async()=>{
      let r=await d(e,a);
      return function(e,t,a){
        var r;let n=function(e){let t=e.replace(/-/g,"+").replace(/_/g,"/").padEnd(4*Math.ceil(e.length/4),"=");if("function"==typeof atob){let e=atob(t),a=new Uint8Array(e.length);for(let t=0;t<e.length;t++)a[t]=e.charCodeAt(t);return a}return new Uint8Array(globalThis.Buffer.from(t,"base64"))}(e),s=function(e,t,a){let r=function(e,t){if(m(e.length))return{S:function(e){let t=Array(256);for(let e=0;e<256;e++)t[e]=e;let a=0;for(let r=0;r<256;r++){a=a+t[r]+e.charCodeAt(r%e.length)&255;let n=t[r];t[r]=t[a],t[a]=n}return t}(e),acc:function(e){let t=1732584193;for(let a=0;a<e.length;a++)t=g((t^Math.imul(e.charCodeAt(a),l[15&a]))>>>0,5);return p(t)}(e)};let a=Array(61),r=p(function(e){let t=2166136261;for(let a=0;a<e.length;a++)t=Math.imul(t^e.charCodeAt(a),16777619)>>>0;return p(t)}(e)^p(t>>>0^2654435769))>>>0;for(let e=0;e<8;e++)if(c(e)){let t=r%61;r=g(r+2654435769>>>0,7+(7&e)),a[t]=(r^p(r))>>>0,r=p(r+t>>>0)}else a[e]=l[15&e];return{S:a,acc:p(2779096485^r)>>>0}}(e,t),n=new Uint8Array(a),s=0;for(let e=0;e<a;){let t=function(e,t){var a,r;let n=e.S,s=e.acc,o=s%61,i=0-Number(o in n),d=n[o]>>>0,l=(((a=s)^(r=(d^Math.imul(2654435769,t+1)>>>0)>>>0))>>>0|(a&r&i)>>>0)>>>0;return s=p((l=(g(l+s>>>0,31&o)^g(s,31&Math.imul(o,7)))>>>0)+2654435769>>>0),n[o]=s>>>0,e.acc=s,s>>>0}(r,s++);n[e++]=255&t,e<a&&(n[e++]=t>>>8&255),e<a&&(n[e++]=t>>>16&255),e<a&&(n[e++]=t>>>24&255)}return n}(t,a,n.length);for(let e=0;e<n.length;e++)n[e]^=s[e];for(let e=0;e<u.length;e++)if(n[e]!==u[e])throw Error("decrypt failed: bad seed or tampered payload");return r=n.subarray(u.length),"undefined"!=typeof TextDecoder?new TextDecoder("utf-8").decode(r):globalThis.Buffer.from(r).toString("utf8")}(await(0,s.Wg)(e,{params:{...t,enc:"2",seed:r},retry:0}),r,a)
    };
    try{return await n()}catch(t){var b,I;if(401===(null!==(I=null==t?void 0:null===(b=t.response)||void 0===b?void 0:b.status)&&void 0!==I?I:null==t?void 0:t.status))return o.delete("".concat(i(e),"|").concat(a)),await n();throw t}
  }
  var I=a(5056),f=a(886);
  let _=[{name:"Miami"},{name:"Boston"},{name:"Seattle"},{name:"Denver"},{name:"Austin"},{name:"Chicago"},{name:"Dallas"},{name:"Munich"},{name:"Berlin"},{name:"Paris"},{name:"Delhi"},{name:"Cancun"}]
}
`;

// =================== WEBPACK MODULE LOADER ===================

const _moduleCache = {};

function fakeRequire(id) {
  if (_moduleCache[id]) return _moduleCache[id].exports;
  const m = (_moduleCache[id] = { exports: {} });

  if (id === 886) {
    m.exports = { D: { MOVIE: 'movie', TV: 'tv' } };
  } else if (id === 5056) {
    m.exports = { V: MOVY_API };
  } else if (id === 2432) {
    // ENHANCED s.Wg — uses got-scraping + curl fallback
    // Content-Type-aware: only parses as JSON for JSON responses,
    // returns raw text for encrypted (text/plain) responses
    m.exports = {
      Wg: async function (url, opts) {
        const params = (opts && opts.params) || {};
        const urlObj = new URL(url);
        Object.keys(params).forEach(function (k) {
          urlObj.searchParams.set(k, params[k]);
        });
        const fullUrl = urlObj.toString();

        // Smart fetch: got-scraping → curl → plain fetch
        const result = await smartFetch(fullUrl, { timeout: 12 });

        if (!result) {
          throw new Error('All fetch methods failed for ' + fullUrl);
        }

        // Check if the response is an error (non-200)
        if (result.status !== 200) {
          // Try to parse as JSON error
          try {
            const errObj = JSON.parse(result.body);
            if (errObj.error || errObj.message) {
              throw new Error('HTTP ' + result.status + ': ' + (errObj.message || errObj.error));
            }
          } catch (parseErr) {
            // Not JSON, just a raw error
          }
          throw new Error('HTTP ' + result.status + ' for ' + fullUrl.slice(0, 80));
        }

        // Content-Type-aware response parsing:
        // - application/json → parse as JSON (for /seed endpoint)
        // - text/plain or other → return raw text (for encrypted /sources)
        const ct = (result.contentType || '').toLowerCase();
        if (ct.includes('json') || ct.includes('javascript')) {
          try {
            return JSON.parse(result.body);
          } catch (e) {
            // Fall through to return as text
          }
        }

        // Check if it looks like JSON (starts with { or [)
        const trimmed = (result.body || '').trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          // It's JSON — but check if it's an error response
          try {
            const parsed = JSON.parse(result.body);
            // If the parsed result has an error field, it's an error
            // Return as object (s.Wg returns objects for JSON endpoints)
            return parsed;
          } catch (e) {
            // Not valid JSON — return as text (encrypted payload)
          }
        }

        // Return as raw text (this is the encrypted base64 payload)
        return result.body;
      },
    };
  } else {
    m.exports = {};
  }
  return m.exports;
}
fakeRequire.d = function (exports, getters) {
  Object.keys(getters).forEach(function (name) {
    Object.defineProperty(exports, name, {
      enumerable: true,
      get: getters[name],
    });
  });
};

// Load the module and get b()
let _bFunction = null;
function loadB() {
  if (_bFunction) return _bFunction;
  const moduleFn = eval('(' + MODULE_1549_SRC + ')');
  const fakeModule = { exports: {} };
  moduleFn(fakeModule, fakeModule.exports, fakeRequire);
  _bFunction = fakeModule.exports.b;
  return _bFunction;
}

// =================== API CLIENT ===================

// Get TMDB info
async function getTMDBInfo(tmdbId, type) {
  const endpoint = type === 'tv' ? 'tv' : 'movie';
  const url =
    TMDB_API_BASE +
    '/' +
    endpoint +
    '/' +
    tmdbId +
    '?api_key=' +
    TMDB_API_KEY +
    '&append_to_response=external_ids';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const d = await res.json();
    return {
      title: type === 'tv' ? d.name : d.title,
      year: parseInt((d.first_air_date || d.release_date || '').slice(0, 4)) || null,
      imdbId: (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || null,
    };
  } catch (e) {
    return null;
  }
}

// Fetch from a single server using the ACTUAL b() function
async function fetchFromServer(server, tmdbId, type, season, episode, tmdbInfo) {
  try {
    const b = loadB();
    const url = MOVY_API + '/' + server + '/sources';

    // Build params — MUST include episodeId=1 and seasonId=1 even for movies
    const params = {
      title: encodeURIComponent(tmdbInfo.title || ''),
      mediaType: type === 'tv' ? 'tv' : 'movie',
      year: tmdbInfo.year || null,
      episodeId: episode || 1,
      seasonId: season || 1,
      tmdbId: String(tmdbId),
      imdbId: tmdbInfo.imdbId || undefined,
    };

    // Remove undefined values
    Object.keys(params).forEach(function (k) {
      if (params[k] === undefined || params[k] === null) delete params[k];
    });

    const result = await b(url, params, String(tmdbId), null);

    // Parse the decrypted JSON
    const parsed = JSON.parse(result);
    return { server: server, data: parsed, status: 200 };
  } catch (e) {
    return { server: server, error: e.message };
  }
}

// Parse a source entry
function parseSourceEntry(source, server, info) {
  const streams = [];
  if (!source || !source.url) return streams;

  let quality = source.quality || source.label || '';
  const q = String(quality).toLowerCase();
  if (q.includes('2160') || q.includes('4k') || q.includes('uhd')) quality = '2160p';
  else if (q.includes('1080')) quality = '1080p';
  else if (q.includes('720')) quality = '720p';
  else if (q.includes('480')) quality = '480p';
  else if (!quality) quality = 'HD';

  let type = source.type || '';
  let streamType;
  if (type === 'mp4' || type === 'mkv') streamType = 'video/mp4';
  else if (type === 'hls' || type === 'm3u8' || source.url.includes('.m3u8'))
    streamType = 'application/vnd.apple.mpegurl';
  else if (source.url.endsWith('.mp4') || source.url.endsWith('.mkv'))
    streamType = 'video/mp4';
  else streamType = 'application/vnd.apple.mpegurl';

  const label = source.label || source.quality || server + ' ' + quality;

  streams.push({
    name: PROVIDER_NAME + ' - ' + server + ' (' + label + ')',
    title: (info.title || 'unknown') + ' [' + server + ']',
    url: source.url,
    quality: quality,
    type: streamType,
    headers: { 'User-Agent': UA, 'Referer': VIDY_ORIGIN + '/' },
    behaviorHints: { bingeGroup: 'movy-' + server + '-' + quality },
  });

  return streams;
}

// Main entry: get streams from all 12 servers sequentially
async function getStreams(tmdbId, type, season, episode) {
  const isMovie = type !== 'tv';

  if (!isMovie && (season == null || episode == null)) {
    console.log('[Movy] TV request without season/episode — returning empty');
    return [];
  }
  if (!tmdbId) {
    console.log('[Movy] Empty TMDB ID — returning empty');
    return [];
  }

  console.log(
    '[Movy] Request: tmdb=' +
      tmdbId +
      ' type=' +
      type +
      (isMovie ? '' : ' S' + season + 'E' + episode)
  );

  // Get TMDB info
  let info;
  try {
    info = await Promise.race([
      getTMDBInfo(tmdbId, type),
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error('TMDB timeout'));
        }, 10000);
      }),
    ]);
  } catch (e) {
    console.log('[Movy] TMDB fetch error: ' + e.message);
    return [];
  }
  if (!info || !info.title) {
    console.log('[Movy] Could not resolve TMDB info');
    return [];
  }
  console.log('[Movy] TMDB: ' + info.title + ' (' + info.year + ')');

  // Fetch from all 12 servers IN PARALLEL (was sequential — too slow at 94s)
  // Parallel fetch reduces total time to ~5-8s (the slowest server's response time)
  // instead of 12 * (response_time + 500ms delay) = 94s.
  console.log('[Movy] Fetching from ' + ALL_SERVERS.length + ' servers in parallel...');
  const results = await Promise.all(
    ALL_SERVERS.map(function (server) {
      return fetchFromServer(server, tmdbId, type, season, episode, info);
    })
  );

  // Parse results
  const allStreams = [];
  const serverStatus = [];
  for (const r of results) {
    if (r.error) {
      serverStatus.push(r.server + ': ERROR (' + r.error.slice(0, 80) + ')');
      continue;
    }
    if (r.data && r.data.sources) {
      const parsedStreams = [];
      for (const source of r.data.sources) {
        const s = parseSourceEntry(source, r.server, info);
        parsedStreams.push.apply(parsedStreams, s);
      }
      if (parsedStreams.length > 0) {
        allStreams.push.apply(allStreams, parsedStreams);
        serverStatus.push(r.server + ': ' + parsedStreams.length + ' streams');
      } else {
        serverStatus.push(r.server + ': 0 streams');
      }
    } else {
      serverStatus.push(r.server + ': no sources');
    }
  }

  console.log(
    '[Movy] ' +
      allStreams.length +
      ' streams from ' +
      ALL_SERVERS.length +
      ' servers'
  );
  serverStatus.forEach(function (s) {
    console.log('  ' + s);
  });

  return allStreams;
}

module.exports = {
  getStreams: getStreams,
  listServers: function () {
    return ALL_SERVERS.slice();
  },
  getTMDBInfo: getTMDBInfo,
  fetchFromServer: fetchFromServer,
  smartFetch: smartFetch,
  _loadB: loadB,
};

// CLI test
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const tmdbId = args[0] || '27205';
    const type = args[1] || 'movie';
    const season = args[2] ? parseInt(args[2], 10) : null;
    const episode = args[3] ? parseInt(args[3], 10) : null;

    console.log('=== Movy All-In-One (Enhanced with got-scraping + curl) ===');
    const streams = await getStreams(tmdbId, type, season, episode);
    console.log('\n=== RESULT ===');
    console.log('Total streams: ' + streams.length);
    streams.forEach(function (s, i) {
      console.log('\n[' + i + '] ' + s.name);
      console.log('    Quality: ' + s.quality);
      console.log('    Type: ' + s.type);
      console.log('    URL: ' + s.url.slice(0, 100));
    });
  })();
}
