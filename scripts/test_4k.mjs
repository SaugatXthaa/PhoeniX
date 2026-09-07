import { gotScraping } from 'got-scraping';

// Test multiple movies for 4K
const movies = [
  { name: 'Dune Part Two', imdb: 'tt15239678' },
  { name: 'Inception', imdb: 'tt1375666' },
  { name: 'Spider-Man No Way Home', imdb: 'tt10872600' },
  { name: 'Avengers Endgame', imdb: 'tt4154796' },
  { name: 'Demon Slayer Mugen Train', imdb: 'tt11032374' },
];

for (const movie of movies) {
  console.log(`\n=== ${movie.name} (${movie.imdb}) ===`);
  
  // Fetch API
  const apiRes = await gotScraping(`https://data.vidsrcme.ru/api.php?type=movie&imdb=${movie.imdb}&stream_urls`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
    timeout: { request: 10000 }, throwHttpErrors: false,
  });
  
  if (apiRes.statusCode !== 200) {
    console.log('  API failed:', apiRes.statusCode);
    continue;
  }
  
  const apiData = JSON.parse(apiRes.body);
  const fileName = apiData.data?.file_name || '';
  console.log('  File:', fileName.slice(0, 80));
  
  // Check for 4K indicators
  const has4K = /2160|4k|uhd/i.test(fileName);
  console.log('  Has 4K in filename:', has4K);
  
  // Decrypt stream URLs
  if (apiData.data?.stream_urls && apiData.vs?.wasm_url) {
    try {
      const wasmRes = await gotScraping(apiData.vs.wasm_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
        timeout: { request: 10000 }, throwHttpErrors: false, responseType: 'buffer',
      });
      const wasmModule = await WebAssembly.compile(wasmRes.body);
      const wasmInstance = await WebAssembly.instantiate(wasmModule, {});
      const { memory, alloc, decrypt } = wasmInstance.exports;
      
      const enc = Buffer.from(apiData.data.stream_urls, 'base64');
      const ptr = alloc(enc.length);
      new Uint8Array(memory.buffer, ptr, enc.length).set(enc);
      const outLen = decrypt(ptr, enc.length);
      const output = new TextDecoder().decode(new Uint8Array(memory.buffer, ptr + 12, outLen));
      const urls = output.split('\n').filter(s => s);
      
      console.log('  Stream URLs:', urls.length);
      for (const u of urls) {
        console.log('    ', u.slice(0, 100));
      }
      
      // Fetch one m3u8 and check for 4K resolution
      if (urls.length > 0) {
        const streamHost = new URL(urls[0]).hostname;
        const tokenRes = await gotScraping(`https://${streamHost}/generate.php`, {
          headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://cloudorchestranova.com/' },
          timeout: { request: 8000 }, throwHttpErrors: false,
        });
        const token = tokenRes.body.trim();
        
        if (token && token.length > 10) {
          const m3u8Url = urls[0] + '?token=' + token;
          const m3u8Res = await gotScraping(m3u8Url, {
            headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://cloudorchestranova.com/' },
            timeout: { request: 10000 }, throwHttpErrors: false,
          });
          
          if (m3u8Res.statusCode === 200) {
            // Look for resolution variants
            const resolutions = m3u8Res.body.match(/RESOLUTION=\d+x(\d+)/gi);
            console.log('  M3U8 resolutions:', resolutions || 'none found');
            
            // Check for 4K
            const has4KStream = /3840x2160|2160|4k/i.test(m3u8Res.body);
            console.log('  Has 4K stream:', has4KStream);
            
            // Show all variants
            const variants = m3u8Res.body.split('\n').filter(l => l.startsWith('#EXT-X-STREAM-INF'));
            console.log('  Variants:', variants.length);
            for (const v of variants) {
              const res = v.match(/RESOLUTION=\d+x(\d+)/);
              const bw = v.match(/BANDWIDTH=(\d+)/);
              console.log(`    ${res?.[1] || '?'}p @ ${bw?.[1] || '?'} bps`);
            }
          }
        }
      }
    } catch (e) {
      console.log('  Decrypt error:', e.message);
    }
  }
}
