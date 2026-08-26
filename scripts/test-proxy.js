/**
 * Seekable Proxy Verification Harness
 *
 * Spins up:
 *   1. A synthetic upstream server that serves a 1MB MP4 file with
 *      full Range support (Accept-Ranges, Content-Range, 206 responses)
 *   2. A "dumb" upstream server that returns 200 with NO Range support
 *   3. The PhoeniX proxy endpoint
 *
 * Verifies:
 *   - 206 Partial Content returned for Range requests
 *   - Accept-Ranges: bytes injected
 *   - Content-Range: bytes 0-1023/1048576 injected
 *   - Content-Type: video/mp4 injected
 *   - Range forwarded to upstream (smart upstream case)
 *   - Range synthetic (dumb upstream case)
 *   - HEAD requests handled correctly
 *   - Non-video URLs rejected
 *   - Invalid ranges return 416
 */

const http = require('http');
const {
  builder,
  parseRangeHeader,
  computeAbsoluteRange,
  formatContentRange,
  videoContentTypeFor,
  handleSeekableProxy,
} = require('../addon');
const { getRouter } = require('stremio-addon-sdk');

// === 1. Synthetic upstream: supports Range, serves 1 MB MP4 ===
const UPSTREAM_TOTAL = 1024 * 1024;
const upstreamSmart = http.createServer((req, res) => {
  const range = req.headers['range'];
  if (!range) {
    const buf = Buffer.alloc(UPSTREAM_TOTAL, 0x42);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': UPSTREAM_TOTAL,
      'Accept-Ranges': 'bytes',
    });
    res.end(buf);
    return;
  }
  const parsed = parseRangeHeader(range);
  if (!parsed) {
    res.writeHead(416, { 'Content-Range': `bytes */${UPSTREAM_TOTAL}` });
    res.end();
    return;
  }
  const abs = computeAbsoluteRange(parsed, UPSTREAM_TOTAL);
  if (!abs || abs.start >= UPSTREAM_TOTAL) {
    res.writeHead(416, { 'Content-Range': `bytes */${UPSTREAM_TOTAL}` });
    res.end();
    return;
  }
  const start = abs.start;
  const end = abs.end !== null ? abs.end : UPSTREAM_TOTAL - 1;
  const len = end - start + 1;
  const buf = Buffer.alloc(len, 0x42);
  res.writeHead(206, {
    'Content-Type': 'video/mp4',
    'Content-Length': len,
    'Accept-Ranges': 'bytes',
    'Content-Range': formatContentRange(start, end, UPSTREAM_TOTAL),
  });
  res.end(buf);
});

// === 2. Dumb upstream: returns 200 with no Range support ===
const upstreamDumb = http.createServer((req, res) => {
  const buf = Buffer.alloc(UPSTREAM_TOTAL, 0x42);
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': UPSTREAM_TOTAL,
  });
  res.end(buf);
});

function listenAsync(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

// === 3. PhoeniX proxy server (just the /proxy endpoint) ===
const phoenixServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/proxy') {
    const target = u.searchParams.get('url');
    if (!target) {
      res.writeHead(400);
      res.end('missing url');
      return;
    }
    handleSeekableProxy(req, res, target).catch((e) => {
      console.error('proxy crashed', e);
      try { res.writeHead(500); res.end(e.message); } catch (_) {}
    });
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

function httpRequest(method, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers,
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function runTests() {
  console.log('=== SEEKABLE PROXY VERIFICATION ===\n');

  const smartUrl = await listenAsync(upstreamSmart);
  const dumbUrl = await listenAsync(upstreamDumb);
  const phoenixUrl = await listenAsync(phoenixServer);

  console.log(`Smart upstream:  ${smartUrl}/video.mp4`);
  console.log(`Dumb upstream:   ${dumbUrl}/video.mp4`);
  console.log(`PhoeniX proxy:   ${phoenixUrl}/proxy\n`);

  let pass = 0, fail = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS  ${name}`); }
    else      { fail++; console.log(`FAIL  ${name}  ${detail}`); }
  };

  // --- TEST 1: Range request on smart upstream ---
  {
    const target = `${smartUrl}/video.mp4`;
    const proxyUrl = `${phoenixUrl}/proxy?url=${encodeURIComponent(target)}`;
    const r = await httpRequest('GET', proxyUrl, { Range: 'bytes=0-1023' });
    check('T1 smart: status 206', r.status === 206, `got ${r.status}`);
    check('T1 smart: Accept-Ranges=bytes', r.headers['accept-ranges'] === 'bytes', `got ${r.headers['accept-ranges']}`);
    check('T1 smart: Content-Type=video/mp4', r.headers['content-type'] === 'video/mp4', `got ${r.headers['content-type']}`);
    check('T1 smart: Content-Range present', !!r.headers['content-range'], `got ${r.headers['content-range']}`);
    check('T1 smart: Content-Range correct', r.headers['content-range'] === `bytes 0-1023/${UPSTREAM_TOTAL}`, `got ${r.headers['content-range']}`);
    check('T1 smart: Content-Length=1024', r.headers['content-length'] === '1024', `got ${r.headers['content-length']}`);
    check('T1 smart: body length=1024', r.body.length === 1024, `got ${r.body.length}`);
    check('T1 smart: body content correct', r.body.every((b) => b === 0x42));
  }

  // --- TEST 2: Suffix range ---
  {
    const target = `${smartUrl}/video.mp4`;
    const proxyUrl = `${phoenixUrl}/proxy?url=${encodeURIComponent(target)}`;
    const r = await httpRequest('GET', proxyUrl, { Range: 'bytes=-512' });
    check('T2 suffix: status 206', r.status === 206, `got ${r.status}`);
    check('T2 suffix: Content-Range correct', r.headers['content-range'] === `bytes ${UPSTREAM_TOTAL - 512}-${UPSTREAM_TOTAL - 1}/${UPSTREAM_TOTAL}`, `got ${r.headers['content-range']}`);
    check('T2 suffix: Content-Length=512', r.headers['content-length'] === '512', `got ${r.headers['content-length']}`);
  }

  // --- TEST 3: Mid-range ---
  {
    const target = `${smartUrl}/video.mp4`;
    const proxyUrl = `${phoenixUrl}/proxy?url=${encodeURIComponent(target)}`;
    const r = await httpRequest('GET', proxyUrl, { Range: 'bytes=500-1000' });
    check('T3 mid: status 206', r.status === 206, `got ${r.status}`);
    check('T3 mid: Content-Range correct', r.headers['content-range'] === `bytes 500-1000/${UPSTREAM_TOTAL}`, `got ${r.headers['content-range']}`);
    check('T3 mid: Content-Length=501', r.headers['content-length'] === '501', `got ${r.headers['content-length']}`);
    check('T3 mid: body length=501', r.body.length === 501, `got ${r.body.length}`);
  }

  // --- TEST 4: No Range header (full file) ---
  {
    const target = `${smartUrl}/video.mp4`;
    const proxyUrl = `${phoenixUrl}/proxy?url=${encodeURIComponent(target)}`;
    const r = await httpRequest('GET', proxyUrl, {});
    check('T4 full: status 200', r.status === 200, `got ${r.status}`);
    check('T4 full: Accept-Ranges=bytes', r.headers['accept-ranges'] === 'bytes');
    check('T4 full: Content-Length=1048576', r.headers['content-length'] === String(UPSTREAM_TOTAL), `got ${r.headers['content-length']}`);
    check('T4 full: body length=1048576', r.body.length === UPSTREAM_TOTAL, `got ${r.body.length}`);
  }

  // --- TEST 5: Dumb upstream (no Accept-Ranges support) ---
  {
    const target = `${dumbUrl}/video.mp4`;
    const proxyUrl = `${phoenixUrl}/proxy?url=${encodeURIComponent(target)}`;
    const r = await httpRequest('GET', proxyUrl, { Range: 'bytes=0-1023' });
    check('T5 dumb: status 206 (synthetic)', r.status === 206, `got ${r.status}`);
    check('T5 dumb: Accept-Ranges=bytes injected', r.headers['accept-ranges'] === 'bytes');
    check('T5 dumb: Content-Type=video/mp4', r.headers['content-type'] === 'video/mp4');
    check('T5 dumb: Content-Range present', !!r.headers['content-range'], `got ${r.headers['content-range']}`);
  }

  // --- TEST 6: HEAD request ---
  {
    const target = `${smartUrl}/video.mp4`;
    const proxyUrl = `${phoenixUrl}/proxy?url=${encodeURIComponent(target)}`;
    const r = await httpRequest('HEAD', proxyUrl, { Range: 'bytes=0-1023' });
    check('T6 HEAD: status 206', r.status === 206, `got ${r.status}`);
    check('T6 HEAD: empty body', r.body.length === 0);
    check('T6 HEAD: Accept-Ranges present', r.headers['accept-ranges'] === 'bytes');
  }

  // --- TEST 7: Reject non-video URL ---
  {
    const proxyUrl = `${phoenixUrl}/proxy?url=${encodeURIComponent('https://example.com/landing.html')}`;
    const r = await httpRequest('GET', proxyUrl, { Range: 'bytes=0-1023' });
    check('T7 reject: status 400', r.status === 400, `got ${r.status}`);
  }

  // --- TEST 8: 416 on invalid Range ---
  {
    const target = `${smartUrl}/video.mp4`;
    const proxyUrl = `${phoenixUrl}/proxy?url=${encodeURIComponent(target)}`;
    const r = await httpRequest('GET', proxyUrl, { Range: 'bytes=999999999-1000000000' });
    check('T8 invalid range: status 416', r.status === 416, `got ${r.status}`);
  }

  // --- TEST 9: Content-Type detection ---
  check('T9a CT: .mp4 -> video/mp4', videoContentTypeFor('https://x.com/v.mp4') === 'video/mp4');
  check('T9b CT: .mkv -> video/x-matroska', videoContentTypeFor('https://x.com/v.mkv') === 'video/x-matroska');
  check('T9c CT: .m3u8 -> application/x-mpegURL', videoContentTypeFor('https://x.com/v.m3u8') === 'application/x-mpegURL');

  // --- TEST 10: Range header parser ---
  check('T10a parse: bytes=0-', JSON.stringify(parseRangeHeader('bytes=0-')) === JSON.stringify({ start: 0, end: null, suffix: false }));
  check('T10b parse: bytes=500-1000', JSON.stringify(parseRangeHeader('bytes=500-1000')) === JSON.stringify({ start: 500, end: 1000, suffix: false }));
  check('T10c parse: bytes=-500 (suffix)', JSON.stringify(parseRangeHeader('bytes=-500')) === JSON.stringify({ start: null, end: 500, suffix: true }));
  check('T10d parse: invalid', parseRangeHeader('invalid') === null);
  check('T10e parse: empty', parseRangeHeader('') === null);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);

  upstreamSmart.close();
  upstreamDumb.close();
  phoenixServer.close();
  process.exit(fail === 0 ? 0 : 1);
}

runTests().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
