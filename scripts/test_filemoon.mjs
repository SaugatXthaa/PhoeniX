import { gotScraping } from 'got-scraping';

// FileMoon-style hosts typically have an API at /api/source/{file_id}
// Let me check if hanerix.com has this pattern
const hosts = [
  { name: 'hanerix', url: 'https://hanerix.com/e/idai5wak9cv0', host: 'hanerix.com' },
  { name: 'smoothpre', url: 'https://smoothpre.com/v/v51t5m9qymh5', host: 'smoothpre.com' },
  { name: 'bysetayico', url: 'https://bysetayico.com/e/vvyymyjma6cq', host: 'bysetayico.com' },
];

for (const h of hosts) {
  console.log(`\n=== ${h.name} ===`);
  const r = await gotScraping(h.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://pro.iqsmartgames.com/' },
    timeout: { request: 15000 }, throwHttpErrors: false,
  });
  
  // Find file_id from cookies or data attributes
  const fileIdMatch = r.body.match(/file_id['"\s:=]+['"]?(\d+)/);
  if (fileIdMatch) console.log('  file_id:', fileIdMatch[1]);
  
  // Find any /api/ references
  const apis = r.body.match(/\/api\/[a-z0-9/_?=${}.&-]+/gi);
  if (apis) console.log('  API paths:', [...new Set(apis)]);
  
  // Find the player JS file
  const playerJs = r.body.match(/\/assets\/jquery\/[a-z0-9_-]+\.js[^"']*/i);
  if (playerJs) console.log('  Player JS:', playerJs[0]);
  
  // Look for post variables
  const postVars = r.body.match(/\$\.cookie\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]/g);
  if (postVars) for (const v of postVars) console.log('  cookie:', v);
  
  // Look for data-post or data-id
  const dataAttrs = r.body.match(/data-(?:post|id|file|video|source)=["']([^"']+)/gi);
  if (dataAttrs) for (const d of dataAttrs) console.log('  data:', d);
  
  // Show body sample
  console.log('  Body sample (300 chars):', r.body.slice(0, 300));
}
