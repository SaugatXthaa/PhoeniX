import { gotScraping } from 'got-scraping';

const imdbId = 'tt1375666';
const results = [];

for (let server = 1; server <= 9; server++) {
  console.log(`\n=== Server ${server} ===`);
  
  // Step 1: Get embed URL with server param
  const vsRes = await gotScraping(`https://proxy.garageband.rocks/vs_src.php?type=movie&id=${imdbId}&server=${server}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
    timeout: { request: 8000 }, throwHttpErrors: false,
  });
  const embedUrl = JSON.parse(vsRes.body).src;
  const origin = new URL(embedUrl).origin;
  
  // Step 2: Fetch API data with stream_urls
  const apiRes = await gotScraping(`https://data.vidsrcme.ru/api.php?type=movie&imdb=${imdbId}&stream_urls`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + '/' },
    timeout: { request: 8000 }, throwHttpErrors: false,
  });
  const apiData = JSON.parse(apiRes.body);
  const fileName = apiData.data?.file_name || '';
  console.log(`  File: ${fileName.slice(0, 60)}`);
  
  // Step 3: Decrypt stream URLs
  if (typeof apiData.data.stream_urls === 'string' && apiData.vs?.wasm_url) {
    const wasmRes = await gotScraping(apiData.vs.wasm_url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
      timeout: { request: 8000 }, throwHttpErrors: false, responseType: 'buffer',
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
    console.log(`  Streams: ${urls.length}`);
    
    // Step 4: Fetch token + check m3u8 for 4K
    if (urls.length > 0) {
      const streamHost = new URL(urls[0]).hostname;
      const tokenRes = await gotScraping(`https://${streamHost}/generate.php`, {
        headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + '/' },
        timeout: { request: 5000 }, throwHttpErrors: false,
      });
      const token = tokenRes.body.trim();
      
      if (token && token.length > 10 && !token.includes('<')) {
        const m3u8Url = urls[0] + '?token=' + token;
        const m3u8Res = await gotScraping(m3u8Url, {
          headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': origin + '/' },
          timeout: { request: 8000 }, throwHttpErrors: false,
        });
        
        if (m3u8Res.statusCode === 200) {
          const resolutions = m3u8Res.body.match(/RESOLUTION=\d+x(\d+)/gi);
          const has4K = m3u8Res.body.includes('3840x2160') || m3u8Res.body.includes('2160');
          console.log(`  Resolutions: ${resolutions?.join(', ') || 'none'}`);
          console.log(`  Has 4K: ${has4K}`);
          
          results.push({
            server,
            host: streamHost,
            fileName: fileName.slice(0, 60),
            resolutions: resolutions?.map(r => r.match(/(\d+)$/)?.[1] + 'p') || [],
            has4K,
            m3u8Url,
          });
        } else {
          console.log(`  M3U8 status: ${m3u8Res.statusCode}`);
        }
      } else {
        console.log(`  Token failed: ${token?.slice(0, 50)}`);
      }
    }
  }
  
  // Small delay to avoid rate limiting
  await new Promise(r => setTimeout(r, 500));
}

console.log('\n\n=== SUMMARY ===');
for (const r of results) {
  console.log(`Server ${r.server}: ${r.host} | ${r.resolutions.join(', ')} | 4K: ${r.has4K} | ${r.fileName}`);
}
