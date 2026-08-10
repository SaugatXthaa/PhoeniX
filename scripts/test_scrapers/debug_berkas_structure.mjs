// Check if Berkas master m3u8 has direct segments or variant playlists
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// Use the master URL from the previous test (still fresh)
const masterUrl = 'https://zxcstream.berkas17.workers.dev/?data=m1zSCJWCpCYbqV2Cip_sTUIx9Z5kHN8zh4jAUsUpiZljb3c2PAQFPNSdV9l4Y-7s3mh4J8w4C7lBd8G0T-wVK3a3eR1iX9nBjJeugRb7-SJ1x9cL8jzVO1T-X8pwDb1bDc4g06yTbNb7';

const r = await gotScraping.get(masterUrl, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});

if (r.statusCode === 200) {
  console.log('=== Master m3u8 content ===');
  console.log(r.body);

  // Check if it has #EXT-X-STREAM-INF (variant playlists) or #EXTINF (direct segments)
  const hasVariants = r.body.includes('#EXT-X-STREAM-INF');
  const hasSegments = r.body.includes('#EXTINF');
  console.log(`\nHas variant playlists: ${hasVariants}`);
  console.log(`Has direct segments: ${hasSegments}`);

  if (hasVariants) {
    // Try fetching the first variant with a longer timeout
    const lines = r.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const variantUrl = lines[i+1]?.trim();
        if (variantUrl) {
          console.log(`\n=== Trying variant with 30s timeout ===`);
          console.log(`URL: ${variantUrl.slice(0, 100)}...`);
          try {
            const vr = await gotScraping.get(variantUrl, {
              headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
              timeout: { request: 30000 }, throwHttpErrors: false, http2: true,
            });
            console.log(`Status: ${vr.statusCode} | CT: ${vr.headers['content-type']} | Body len: ${vr.body?.length || 0}`);
            if (vr.statusCode === 200) {
              console.log(`First 500: ${vr.body.slice(0, 500)}`);
            } else {
              console.log(`Body: ${vr.body?.slice(0, 200)}`);
            }
          } catch (e) {
            console.log(`ERR: ${e.message}`);
          }
          break;
        }
      }
    }
  }
}
