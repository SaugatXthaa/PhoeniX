import { gotScraping } from 'got-scraping';

// The mresult from embedhelper2.php
const mresult = 'eyJzbXdoIjoiaWRhaTV3YWs5Y3YwIiwiZmxscyI6InY1MXQ1bTlxeW1oNSIsImZsbW4iOiJ2dnl5bXlqbWE2Y3EiLCJycG1zaHJlIjoia3lyY2F4IiwidXBuc2hyIjoicG52NWtkIiwic3RybXAyIjoidHVpZndpIn0=';
const decoded = JSON.parse(Buffer.from(mresult, 'base64').toString('utf-8'));
console.log('Decoded mresult:', decoded);

// The sources from embedhelper2.php
const sources = {
  smwh: { siteUrl: 'https://hanerix.com/e/', id: decoded.smwh, friendlyName: 'streamhg' },
  flls: { siteUrl: 'https://smoothpre.com/v/', id: decoded.flls, friendlyName: 'earnvids' },
  flmn: { siteUrl: 'https://bysetayico.com/e/', id: decoded.flmn, friendlyName: 'byse' },
  rpmshre: { siteUrl: 'https://multimovies.rpmhub.site/#', id: decoded.rpmshre, friendlyName: 'rpmshare' },
  strmp2: { siteUrl: 'https://multimovies.p2pplay.pro/#', id: decoded.strmp2, friendlyName: 'streamp2p' },
  upnshr: { siteUrl: 'https://server1.uns.bio/#', id: decoded.upnshr, friendlyName: 'upnshare' },
};

// Test each provider
for (const [key, src] of Object.entries(sources)) {
  const embedUrl = src.siteUrl + src.id;
  console.log(`\n=== ${src.friendlyName} (${key}) ===`);
  console.log('URL:', embedUrl);
  try {
    const r = await gotScraping(embedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://pro.iqsmartgames.com/' },
      timeout: { request: 10000 }, throwHttpErrors: false, followRedirect: true,
    });
    console.log('Status:', r.statusCode, '| size:', r.body.length);
    // Look for m3u8/mp4
    const m3u8 = r.body.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi);
    const mp4 = r.body.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi);
    if (m3u8) console.log('  m3u8:', m3u8[0].slice(0, 150));
    if (mp4) console.log('  mp4:', mp4[0].slice(0, 150));
    // Look for sources/file
    const fileMatch = r.body.match(/file\s*:\s*"[^"]+"/gi);
    if (fileMatch) console.log('  file:', fileMatch[0].slice(0, 150));
    const sourcesMatch = r.body.match(/sources?\s*[:=]\s*\[[^\]]{1,500}/gi);
    if (sourcesMatch) console.log('  sources:', sourcesMatch[0].slice(0, 200));
    // Look for API calls
    const apiCalls = r.body.match(/\/api\/[a-z0-9/_?=&.-]+/gi);
    if (apiCalls) console.log('  API:', [...new Set(apiCalls)].slice(0, 3));
  } catch (e) {
    console.log('Error:', e.message);
  }
}
