// Task 79: does the playback-unavailable stream_url actually serve content
// when fetched IMMEDIATELY (same session, <30s token window)?
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mod = require('/home/z/my-project/phoenix-analysis/src/nuvio/stellarrip.cjs');

const STELLAR_RIP = 'https://stellar.rip';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const mediaId = 693134, mediaType = 'movie', tvSlug = '';
  const { token: requestToken, embedPath, cookieJar } = await mod.getRequestToken(mediaId, mediaType, null, null);
  const streamToken = await mod.getStreamToken(mediaId, mediaType, tvSlug, requestToken, cookieJar, embedPath);
  console.log('tokens acquired');

  // single server, immediate fetch of whatever URL comes back
  const srv = mod.SERVERS.find(s => s.id === 's0');
  const encRes = await fetch(STELLAR_RIP + '/api/encrypt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': STELLAR_RIP, 'Referer': STELLAR_RIP + embedPath, 'User-Agent': UA, ...(cookieJar && { Cookie: cookieJar }) },
    body: JSON.stringify({ data: { mediaId, mediaType, tv_slug: tvSlug, source: srv.id }, endpoint: 'stream-encrypted', requestToken }),
    signal: AbortSignal.timeout(12000),
  });
  const encData = await encRes.json();
  console.log('encrypt ok, url:', encData.url?.slice(0, 60));
  const opaqueUrl = encData.url + (encData.url.includes('?') ? '&' : '?') +
    'requestToken=' + encodeURIComponent(requestToken) + '&token=' + encodeURIComponent(streamToken);
  const streamRes = await fetch(STELLAR_RIP + opaqueUrl, {
    headers: { 'Referer': STELLAR_RIP + embedPath, 'User-Agent': UA },
    signal: AbortSignal.timeout(12000),
  });
  const streamData = await streamRes.json();
  const streamUrl = streamData?.data?.stream_url;
  console.log('stream_url:', streamUrl?.slice(0, 80));

  if (streamUrl) {
    // fetch it IMMEDIATELY — follow redirects, dump what comes back
    const t0 = Date.now();
    const res = await fetch(STELLAR_RIP + streamUrl, {
      headers: { 'Referer': STELLAR_RIP + embedPath, 'User-Agent': UA, 'Origin': STELLAR_RIP },
      redirect: 'follow', signal: AbortSignal.timeout(12000),
    });
    const text = await res.text();
    console.log(`immediate fetch: HTTP ${res.status} @${Date.now() - t0}ms finalUrl=${res.url.slice(0, 100)}`);
    console.log('content-type:', res.headers.get('content-type'));
    console.log('body[:400]:', text.slice(0, 400));
  }
})();
