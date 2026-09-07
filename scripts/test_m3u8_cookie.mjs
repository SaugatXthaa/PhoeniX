import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

const cookieJar = new CookieJar();

// Step 1: Fetch the cloudorchestranova embed page (sets cookies)
console.log('Step 1: Fetch embed page');
const embedUrl = 'https://cloudorchestranova.com/embed/movie/tt1375666?vs=Py8xtTTHNoBo3Fti3oLh-_tbl7KXfdOnMdS-GjikXU0gv1t2bCU3bWy13YPjIScS-3r2JuIwR91bv5QL9aM1nM7tleOTQVO7Lg2HFevRieIv_u2Zyg';
const embedRes = await gotScraping(embedUrl, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://proxy.garageband.rocks/' },
  cookieJar,
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('  Status:', embedRes.statusCode, '| cookies:', cookieJar.toJSON().cookies.length);

// Step 2: Fetch the player page
console.log('Step 2: Fetch player page');
const cfgMatch = embedRes.body.match(/window\.CFG\s*=\s*(\{[^}]+\})/);
let playerUrl = null;
if (cfgMatch) {
  const cfg = JSON.parse(cfgMatch[1].replace(/\\u0026/g, '&').replace(/\\'/g, "'"));
  playerUrl = cfg.playerUrl;
  console.log('  Player URL:', playerUrl);
}

if (playerUrl) {
  const fullPlayerUrl = playerUrl.startsWith('http') ? playerUrl : 'https://cloudorchestranova.com' + playerUrl;
  const playerRes = await gotScraping(fullPlayerUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': embedUrl },
    cookieJar,
    timeout: { request: 15000 }, throwHttpErrors: false,
  });
  console.log('  Player status:', playerRes.statusCode, '| size:', playerRes.body.length);
  
  // Check cookies after player page
  console.log('  Cookies after player:', cookieJar.toJSON().cookies.length);
  for (const c of cookieJar.toJSON().cookies) {
    console.log('    ', c.key, '=', c.value.slice(0, 50));
  }
}

// Step 3: Now try the m3u8 URL with cookies
const m3u8Url = 'https://peregrinepalaver.space/pl/H4sIAAAAAAAAAw3N226DIBgA4FcCEdsu6cWaItZUVrDg4U75XZziYcvaEp9..17gI58EbEuAItq2aBftoz3uwsh2URgg1Ozecu6o0PjHMLgAo9.m7EWhzSinCmtXbXaExfI0hlndoMCkKZnXJs4z1vNaX2iLaqQ2kRUjZkqHQZ6c6jzozRWxVzEvSOS_Xoz0bgJH6nOGgIuy4atUJF7vel2qLc1s7BI4916OdVoN9glEkP_z.ZEI0UxLKGeITBKXjfaP9uvwarlXEPhQcBleNzd0Awxy0kij1AF.p2I6XO28GrulD8Xc6SaPxz93bFg0CQEAAA--/master.m3u8';

console.log('\nStep 3: Fetch m3u8 with cookies');
const m3u8Res = await gotScraping(m3u8Url, {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://cloudorchestranova.com/' },
  cookieJar,
  timeout: { request: 15000 }, throwHttpErrors: false,
});
console.log('  Status:', m3u8Res.statusCode, '| size:', m3u8Res.body.length);
if (m3u8Res.statusCode === 200) {
  console.log('  Body (first 500):', m3u8Res.body.slice(0, 500));
} else {
  console.log('  Body:', m3u8Res.body.slice(0, 200));
}
