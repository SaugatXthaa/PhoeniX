/**
 * Pre-Flight Verification Harness
 *
 * Spins up synthetic upstreams that cover every code path:
 *   - healthy   : 206 + Accept-Ranges + video/mp4
 *   - no_ranges : 200 + video/mp4 but no Accept-Ranges
 *   - no_ct     : 200 + Accept-Ranges but text/html Content-Type
 *   - forbidden : 403 on first 2 attempts, 206 on 3rd (UA rotation)
 *   - dead_404  : 404 always
 *   - dead_500  : 500 always
 *   - slow      : responds after 12s (probe timeout is 8s)
 *
 * Verifies that validateAndFixStream() returns the correct verdict
 * for each scenario.
 */

const http = require('http');
const { validateAndFixStream, classifyProbeResponse, buildLocalizedHeaders } = require('../addon');

function listenAsync(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

// === 1. HEALTHY upstream: 206 + Accept-Ranges + video/mp4 ===
const healthy = http.createServer((req, res) => {
  const range = req.headers['range'] || 'bytes=0-5';
  const m = range.match(/bytes=(\d+)-(\d+)/);
  const start = m ? parseInt(m[1], 10) : 0;
  const end = m ? parseInt(m[2], 10) : 5;
  const len = end - start + 1;
  res.writeHead(206, {
    'Content-Type': 'video/mp4',
    'Content-Length': len,
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/1048576`,
  });
  res.end(Buffer.alloc(len, 0x42));
});

// === 2. NO_RANGES upstream: 200 + video/mp4 but NO Accept-Ranges ===
const noRanges = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': 1024,
    // no Accept-Ranges
  });
  res.end(Buffer.alloc(1024, 0x42));
});

// === 3. NO_CT upstream: 200 + Accept-Ranges but text/html Content-Type ===
const noCt = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'Content-Length': 1024,
    'Accept-Ranges': 'bytes',
  });
  res.end(Buffer.alloc(1024, 0x42));
});

// === 4. FORBIDDEN upstream: 403 for first 2 attempts, 206 on 3rd ===
let forbiddenAttempts = 0;
const forbidden = http.createServer((req, res) => {
  forbiddenAttempts++;
  if (forbiddenAttempts <= 2) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  res.writeHead(206, {
    'Content-Type': 'video/mp4',
    'Content-Length': 6,
    'Accept-Ranges': 'bytes',
    'Content-Range': 'bytes 0-5/1048576',
  });
  res.end(Buffer.alloc(6, 0x42));
});

// === 5. DEAD_404 upstream ===
const dead404 = http.createServer((req, res) => {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// === 6. DEAD_500 upstream ===
const dead500 = http.createServer((req, res) => {
  res.writeHead(500, { 'Content-Type': 'text/plain' });
  res.end('Internal Server Error');
});

// === 7. SLOW upstream: responds after 12s (probe times out at 8s) ===
const slow = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 6 });
    res.end(Buffer.alloc(6, 0x42));
  }, 12000);
});

async function runTests() {
  console.log('=== PRE-FLIGHT VERIFICATION HARNESS ===\n');

  const healthyUrl = await listenAsync(healthy);
  const noRangesUrl = await listenAsync(noRanges);
  const noCtUrl = await listenAsync(noCt);
  const forbiddenUrl = await listenAsync(forbidden);
  const dead404Url = await listenAsync(dead404);
  const dead500Url = await listenAsync(dead500);
  const slowUrl = await listenAsync(slow);

  console.log(`healthy:    ${healthyUrl}/v.mp4`);
  console.log(`no_ranges:  ${noRangesUrl}/v.mp4`);
  console.log(`no_ct:      ${noCtUrl}/v.mp4`);
  console.log(`forbidden:  ${forbiddenUrl}/v.mp4`);
  console.log(`dead_404:   ${dead404Url}/v.mp4`);
  console.log(`dead_500:   ${dead500Url}/v.mp4`);
  console.log(`slow:       ${slowUrl}/v.mp4\n`);

  let pass = 0, fail = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`PASS  ${name}`); }
    else      { fail++; console.log(`FAIL  ${name}  ${detail}`); }
  };

  // --- T1: Healthy stream ---
  {
    const v = await validateAndFixStream(`${healthyUrl}/v.mp4`, 'example.com');
    check('T1 healthy: ok=true', v.ok === true, JSON.stringify(v));
    check('T1 healthy: seekable=true', v.seekable === true);
    check('T1 healthy: fixedUrl unchanged', v.fixedUrl === `${healthyUrl}/v.mp4`);
    check('T1 healthy: contentTypeTag=video/mp4', v.contentTypeTag === 'video/mp4');
  }

  // --- T2: No Accept-Ranges -> route through proxy ---
  {
    const v = await validateAndFixStream(`${noRangesUrl}/v.mp4`, 'example.com');
    check('T2 no_ranges: ok=true', v.ok === true, JSON.stringify(v));
    check('T2 no_ranges: seekable=false', v.seekable === false);
    check('T2 no_ranges: fixedUrl contains /proxy?url=', v.fixedUrl.includes('/proxy?url='));
    check('T2 no_ranges: notes mention proxy routing',
      v.notes && v.notes.some((n) => n.includes('proxy')));
  }

  // --- T3: Missing video Content-Type -> append phoenix_ct=1 ---
  {
    const v = await validateAndFixStream(`${noCtUrl}/v.mp4`, 'example.com');
    check('T3 no_ct: ok=true', v.ok === true, JSON.stringify(v));
    check('T3 no_ct: fixedUrl contains phoenix_ct=1', v.fixedUrl.includes('phoenix_ct=1'));
    check('T3 no_ct: notes mention phoenix_ct',
      v.notes && v.notes.some((n) => n.includes('phoenix_ct')));
    // Should also be routed through proxy since accept-ranges=no but text/html...
    // wait, no - it has Accept-Ranges: bytes, so seekable=true. Just CT fix.
    check('T3 no_ct: seekable=true', v.seekable === true);
  }

  // --- T4: 403 self-heal via UA rotation ---
  {
    forbiddenAttempts = 0;
    const v = await validateAndFixStream(`${forbiddenUrl}/v.mp4`, 'example.com');
    check('T4 forbidden: ok=true (after retries)', v.ok === true, JSON.stringify(v));
    check('T4 forbidden: 2 failed attempts noted',
      v.notes && v.notes.filter((n) => n.includes('403')).length === 2);
    check('T4 forbidden: 3 total attempts made', forbiddenAttempts === 3);
  }

  // --- T5: 404 dead link dropped ---
  {
    const v = await validateAndFixStream(`${dead404Url}/v.mp4`, 'example.com');
    check('T5 404: ok=false', v.ok === false, JSON.stringify(v));
    check('T5 404: reason=dead_link', v.reason === 'dead_link');
  }

  // --- T6: 500 upstream broken dropped ---
  {
    const v = await validateAndFixStream(`${dead500Url}/v.mp4`, 'example.com');
    check('T6 500: ok=false', v.ok === false, JSON.stringify(v));
    check('T6 500: reason=upstream_broken', v.reason === 'upstream_broken');
  }

  // --- T7: Timeout dropped ---
  {
    const start = Date.now();
    const v = await validateAndFixStream(`${slowUrl}/v.mp4`, 'example.com');
    const elapsed = Date.now() - start;
    check('T7 slow: ok=false', v.ok === false, JSON.stringify(v));
    check('T7 slow: reason starts with network_', (v.reason || '').startsWith('network_'));
    check('T7 slow: completed in < 15s', elapsed < 15000, `took ${elapsed}ms`);
  }

  // --- T8: Invalid URL rejected ---
  {
    const v = await validateAndFixStream('https://example.com/landing.html', 'example.com');
    check('T8 invalid: ok=false', v.ok === false);
    check('T8 invalid: reason=invalid_url', v.reason === 'invalid_url');
  }

  // --- T9: Non-existent host ---
  {
    const v = await validateAndFixStream(
      'https://nonexistent-host-12345.invalid/v.mp4',
      'nonexistent-host-12345.invalid'
    );
    check('T9 NXDOMAIN: ok=false', v.ok === false, JSON.stringify(v));
    check('T9 NXDOMAIN: reason starts with network_', (v.reason || '').startsWith('network_'));
  }

  // --- T10: classifyProbeResponse unit tests ---
  {
    const c1 = classifyProbeResponse({
      status: 206,
      headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': 'bytes 0-5/100' },
    });
    check('T10a classify: isVideoType=true', c1.isVideoType === true);
    check('T10a classify: supportsRanges=true', c1.supportsRanges === true);

    const c2 = classifyProbeResponse({
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    check('T10b classify: isVideoType=false (text/html)', c2.isVideoType === false);
    check('T10b classify: supportsRanges=false', c2.supportsRanges === false);

    const c3 = classifyProbeResponse({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
    check('T10c classify: octet-stream isVideoType=true', c3.isVideoType === true);

    const c4 = classifyProbeResponse({
      status: 200,
      headers: {}, // empty content-type
    });
    check('T10d classify: empty CT isVideoType=true', c4.isVideoType === true);
  }

  // --- T11: localized headers built correctly ---
  {
    const h = buildLocalizedHeaders('streamex.sh', 'TestUA/1.0');
    check('T11a headers: User-Agent set', h['User-Agent'] === 'TestUA/1.0');
    check('T11b headers: Referer matches domain', h['Referer'] === 'https://streamex.sh/');
    check('T11c headers: Origin matches domain', h['Origin'] === 'https://streamex.sh');
    check('T11d headers: Host set', h['Host'] === 'streamex.sh');
    check('T11e headers: Range accepts video types', h['Accept'].includes('video/mp4'));
    check('T11f headers: Sec-Fetch-Dest=video', h['Sec-Fetch-Dest'] === 'video');
  }

  // --- T12: preflightBatch drops dead links and keeps good ones ---
  {
    const { preflightBatch } = require('../addon');
    const candidates = [
      { name: 'Healthy', title: 'Healthy', url: `${healthyUrl}/v.mp4` },
      { name: 'Dead',    title: 'Dead',    url: `${dead404Url}/v.mp4` },
      { name: 'Broken',  title: 'Broken',  url: `${dead500Url}/v.mp4` },
      { name: 'NoRange', title: 'NoRange', url: `${noRangesUrl}/v.mp4` },
    ];
    const results = await preflightBatch(candidates);
    check('T12 batch: 2 survivors (Healthy + NoRange)', results.length === 2, `got ${results.length}`);
    check('T12 batch: survivor 0 is Healthy', results[0] && results[0].name === 'Healthy');
    check('T12 batch: survivor 1 is NoRange', results[1] && results[1].name === 'NoRange');
    check('T12 batch: NoRange routed through proxy', results[1] && results[1].url.includes('/proxy?url='));
    check('T12 batch: Healthy seekable=true', results[0] && results[0].seekable === true);
    check('T12 batch: NoRange seekable=false', results[1] && results[1].seekable === false);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);

  healthy.close();
  noRanges.close();
  noCt.close();
  forbidden.close();
  dead404.close();
  dead500.close();
  slow.close();
  process.exit(fail === 0 ? 0 : 1);
}

runTests().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
