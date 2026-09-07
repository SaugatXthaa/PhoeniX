import { gotScraping } from 'got-scraping';

// Fetch vs_src.php to get a fresh embed URL
const vsRes = await gotScraping('https://proxy.garageband.rocks/vs_src.php?type=movie&id=tt1375666', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const vsData = JSON.parse(vsRes.body);
const embedUrl = vsData.src;
console.log('Embed URL:', embedUrl.slice(0, 100));

// Fetch the embed page
const embedRes = await gotScraping(embedUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('Embed status:', embedRes.statusCode, '| size:', embedRes.body.length);

// Extract the FULL CFG (not just first {})
const cfgMatch = embedRes.body.match(/window\.CFG\s*=\s*(\{.*?\});/s);
if (cfgMatch) {
  const cfgStr = cfgMatch[1].replace(/\\u0026/g, '&').replace(/\\'/g, "'");
  console.log('\nFull CFG:');
  // Try to parse as JSON
  try {
    const cfg = JSON.parse(cfgStr);
    console.log(JSON.stringify(cfg, null, 2).slice(0, 2000));
  } catch (e) {
    console.log('Parse error, raw CFG:', cfgStr.slice(0, 1000));
  }
}

// Also look for the player URL and any token in the page
const playerUrlMatch = embedRes.body.match(/playerUrl['"]\s*:\s*['"]([^'"]+)/);
if (playerUrlMatch) console.log('\nPlayer URL:', playerUrlMatch[1]);

// Look for any token/cookie
const tokenMatch = embedRes.body.match(/(?:token|key|auth|api_key)['"]\s*:\s*['"]([^'"]+)/gi);
if (tokenMatch) {
  console.log('\nTokens found:');
  for (const t of tokenMatch) console.log('  ', t);
}
