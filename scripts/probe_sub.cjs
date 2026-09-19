
(async () => {
  let _gsMod = null;
  try { _gsMod = await import('got-scraping'); } catch (e) { console.log('IMPORT FAILED:', e.message); _gsMod = false; }
  console.log('gs loaded:', !!_gsMod, typeof (_gsMod && _gsMod.gotScraping));
  const subInfo = 'https://qqqcdn.cloud/subtitles/fs/token/1g5uvpf.json';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
  for (let h = 0; h < 3; h++) {
    try {
      const gr = await _gsMod.gotScraping(subInfo, { headers: { 'User-Agent': UA, Referer: 'https://mfw09.org/' }, timeout: { request: 10000 }, throwHttpErrors: false, http2: h !== 1 });
      console.log('attempt', h, gr.statusCode, typeof gr.body === 'string' ? gr.body.length : typeof gr.body);
      if (gr.statusCode === 200) { console.log('BODY OK'); break; }
    } catch (e) { console.log('attempt', h, 'THREW:', e.message.slice(0, 80)); }
  }
})();
