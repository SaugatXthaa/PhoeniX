// Task 79: stellar.rip verbose chain dump — find where the website flow
// diverges from our scraper (token+PoW work; per-server resolve returns null).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mod = require('/home/z/my-project/phoenix-analysis/src/nuvio/stellarrip.cjs');

const STELLAR_RIP = 'https://stellar.rip';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const mediaId = 693134, mediaType = 'movie', tvSlug = '';
  const { token: requestToken, embedPath, cookieJar } = await mod.getRequestToken(mediaId, mediaType, null, null);
  console.log('requestToken:', requestToken.slice(0, 40) + '...', 'embedPath:', embedPath);
  const streamToken = await mod.getStreamToken(mediaId, mediaType, tvSlug, requestToken, cookieJar, embedPath);
  console.log('streamToken:', String(streamToken).slice(0, 40) + '...');

  const servers = mod.SERVERS.slice(0, 4);
  for (const srv of servers) {
    console.log(`\n===== SERVER ${srv.id} (${srv.name}) =====`);
    const body = JSON.stringify({ data: { mediaId, mediaType, tv_slug: tvSlug, source: srv.id }, endpoint: 'stream-encrypted', requestToken });
    try {
      const encRes = await fetch(STELLAR_RIP + '/api/encrypt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': STELLAR_RIP, 'Referer': STELLAR_RIP + embedPath, 'User-Agent': UA, ...(cookieJar && { Cookie: cookieJar }) },
        body, signal: AbortSignal.timeout(12000),
      });
      console.log('encrypt status:', encRes.status, 'retry-after:', encRes.headers.get('retry-after'));
      const encText = await encRes.text();
      console.log('encrypt body[:300]:', encText.slice(0, 300));
      let encData = null;
      try { encData = JSON.parse(encText); } catch {}
      if (encData?.url) {
        const opaqueUrl = encData.url + (encData.url.includes('?') ? '&' : '?') +
          'requestToken=' + encodeURIComponent(requestToken) + '&token=' + encodeURIComponent(streamToken);
        const streamRes = await fetch(STELLAR_RIP + opaqueUrl, {
          headers: { 'Referer': STELLAR_RIP + embedPath, 'User-Agent': UA },
          signal: AbortSignal.timeout(12000),
        });
        console.log('stream-encrypted status:', streamRes.status);
        const stText = await streamRes.text();
        console.log('stream body[:300]:', stText.slice(0, 300));
      }
    } catch (e) {
      console.log('ERROR:', e.message);
    }
    await new Promise(r => setTimeout(r, 1200));
  }
})();
