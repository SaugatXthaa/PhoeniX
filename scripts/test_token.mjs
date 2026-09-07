import { gotScraping } from 'got-scraping';

// Step 1: Get embed URL
const vsRes = await gotScraping('https://proxy.garageband.rocks/vs_src.php?type=movie&id=tt1375666', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
const embedUrl = JSON.parse(vsRes.body).src;

// Step 2: Fetch embed page → get playerUrl + token
const embedRes = await gotScraping(embedUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

// Extract token
const tokenMatch = embedRes.body.match(/"token"\s*:\s*"([^"]+)"/);
const token = tokenMatch?.[1];
console.log('Token:', token);

// Extract playerUrl
const playerUrlMatch = embedRes.body.match(/"playerUrl"\s*:\s*"([^"]+)"/);
const playerUrl = playerUrlMatch?.[1]?.replace(/\\u0026/g, '&');
console.log('Player URL:', playerUrl);

// Step 3: Fetch the player page — it might set a cookie with the token
const fullPlayerUrl = 'https://cloudorchestranova.com' + playerUrl;
const playerRes = await gotScraping(fullPlayerUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': embedUrl },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('\nPlayer page status:', playerRes.statusCode, '| size:', playerRes.body.length);

// Look for token usage in the player page
const tokenInPlayer = playerRes.body.match(/token[=:]["'\s]*([a-f0-9]{20,})/i);
if (tokenInPlayer) console.log('Token in player:', tokenInPlayer[1]);

// Look for set-cookie in response headers
console.log('Set-Cookie:', playerRes.headers['set-cookie']);

// Step 4: Now try the m3u8 with token as query param
const m3u8Url = 'https://peregrinepalaver.space/pl/H4sIAAAAAAAAAw3N226DIBgA4FcCEdsu6cWaItZUVrDg4U75XZziYcvaEp9..17gI58EbEuAItq2aBftoz3uwsh2URgg1Ozecu6o0PjHMLgAo9.m7EWhzSinCmtXbXaExfI0hlndoMCkKZnXJs4z1vNaX2iLaqQ2kRUjZkqHQZ6c6jzozRWxVzEvSOS_Xoz0bgJH6nOGgIuy4atUJF7vel2qLc1s7BI4916OdVoN9glEkP_z.ZEI0UxLKGeITBKXjfaP9uvwarlXEPhQcBleNzd0Awxy0kij1AF.p2I6XO28GrulD8Xc6SaPxz93bFg0CQEAAA--/master.m3u8';

// Try with token as query param
const m3u8WithToken = m3u8Url + '?token=' + token;
console.log('\n=== m3u8 with token param ===');
const r1 = await gotScraping(m3u8WithToken, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://cloudorchestranova.com/' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Status:', r1.statusCode, '| body:', r1.body.slice(0, 200));

// Try with token as header
const r2 = await gotScraping(m3u8Url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://cloudorchestranova.com/', 'Authorization': 'Bearer ' + token },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('\n=== m3u8 with Authorization header ===');
console.log('Status:', r2.statusCode, '| body:', r2.body.slice(0, 200));

// Try with X-Token header
const r3 = await gotScraping(m3u8Url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://cloudorchestranova.com/', 'X-Token': token },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('\n=== m3u8 with X-Token header ===');
console.log('Status:', r3.statusCode, '| body:', r3.body.slice(0, 200));
