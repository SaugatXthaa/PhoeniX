// Inspect gdflix page to find the actual video URL pattern
// Usage: node scripts/inspect_gdflix.cjs

const { execSync } = require('child_process');

(async () => {
  // Step 1: Get pantyflix API response via curl (bypass CF)
  const apiUrl = 'https://pantyflix.org/api/streamrip/download?type=movie&id=27205';
  const apiJson = execSync(
    `curl -sS --max-time 15 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36" -H "Accept: application/json" -H "Referer: https://pantyflix.org/" "${apiUrl}"`,
    { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
  );
  const data = JSON.parse(apiJson);
  
  // Find a fastdlserver URL
  const fastdl = data.downloads.find(d => d.url.includes('fastdlserver'));
  if (!fastdl) { console.log('No fastdlserver URL'); return; }
  console.log('fastdlserver URL:', fastdl.url.slice(0, 100));
  console.log('quality:', fastdl.quality, 'source:', fastdl.source);
  console.log('');
  
  // Step 2: Use curl to follow the redirect chain
  const html = execSync(
    `curl -sS -L --max-time 15 -A "Mozilla/5.0 Chrome/131" -H "Referer: https://pantyflix.org/" "${fastdl.url}"`,
    { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 }
  );
  
  console.log('HTML length:', html.length);
  const titleM = html.match(/<title>[^<]*<\/title>/i);
  console.log('HTML title:', titleM?.[0] || 'no title');
  
  // Find ALL cloud-dl URLs in the page
  const cloudDlUrls = html.match(/https:\/\/cloud-dl[^"'\s<>]+/gi) || [];
  console.log('\ncloud-dl URLs found:', cloudDlUrls.length);
  cloudDlUrls.slice(0, 8).forEach((u, i) => console.log('  [' + i + ']', u.slice(0, 220)));
  
  // Find ALL busycdn URLs
  const busycdnUrls = html.match(/https?:\/\/[^"'\s<>]*busycdn[^"'\s<>]+/gi) || [];
  console.log('\nbusycdn URLs found:', busycdnUrls.length);
  busycdnUrls.slice(0, 5).forEach((u, i) => console.log('  [' + i + ']', u.slice(0, 220)));
  
  // Find ALL googleusercontent URLs
  const googleUrls = html.match(/https?:\/\/[^"'\s<>]*googleusercontent[^"'\s<>]+/gi) || [];
  console.log('\ngoogleusercontent URLs found:', googleUrls.length);
  googleUrls.slice(0, 3).forEach((u, i) => console.log('  [' + i + ']', u.slice(0, 220)));
  
  // Find download buttons / data-url attributes
  const dataUrls = html.match(/data-url="[^"]+"/gi) || [];
  console.log('\ndata-url attributes:', dataUrls.length);
  dataUrls.slice(0, 5).forEach((u, i) => console.log('  [' + i + ']', u.slice(0, 220)));
  
  // Find onclick handlers
  const onclicks = html.match(/onclick="[^"]+"/gi) || [];
  console.log('\nonclick handlers:', onclicks.length);
  onclicks.slice(0, 5).forEach((u, i) => console.log('  [' + i + ']', u.slice(0, 220)));
  
  // Find buttons with "Download" text
  const btnMatches = html.match(/<button[^>]*>[^<]*[^<]*<\/button>/gi) || [];
  console.log('\nbuttons:', btnMatches.length);
  btnMatches.slice(0, 3).forEach((u, i) => console.log('  [' + i + ']', u.slice(0, 300)));
  
  // Find href attributes pointing to file URLs
  const hrefs = html.match(/href="([^"]+)"/gi) || [];
  console.log('\nhrefs total:', hrefs.length);
  const interesting = hrefs.filter(h => /download|file|gdflix|cloud|fastdl|drive|google/i.test(h));
  console.log('interesting hrefs:', interesting.length);
  interesting.slice(0, 8).forEach((u, i) => console.log('  [' + i + ']', u.slice(0, 220)));
})();
