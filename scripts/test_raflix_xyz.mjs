import { gotScraping } from 'got-scraping';

const r = await gotScraping('https://raflix.xyz/assets/index-C7FeQiGI.js', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});
const js = r.body;
console.log('JS size:', js.length);

// Find ALL server/provider configurations
const serverConfigs = [...js.matchAll(/\{[^{}]*id:\s*["']([^"']+)["'][^{}]*name:\s*["']([^"']+)["'][^{}]*\}/g)];
console.log('\nServer configs:');
for (const m of serverConfigs.slice(0, 10)) {
  console.log('  id:', m[1], '| name:', m[2]);
}

// Find the gS function (origin resolver)
const gsMatch = js.match(/gS\s*=\s*function[^}]{0,500}/);
if (gsMatch) console.log('\ngS function:', gsMatch[0].slice(0, 300));

// Find ALL origin/base URLs
const origins = [...js.matchAll(/origin:\s*["']([^"']+)["']/g)];
console.log('\nOrigins:');
for (const m of [...new Set(origins.map(m => m[1]))]) console.log('  ', m);

// Find ALL URL templates with /player/ or /movie/ or /tv/
const templates = [...js.matchAll(/`[^`]*(?:\/player\/|\/movie\/|\/tv\/)[^`]*`/g)];
console.log('\nURL templates:');
for (const m of [...new Set(templates.map(m => m[0]))]) console.log('  ', m.slice(0, 200));

// Find the server list (array of server objects)
const serverList = js.match(/\[\s*\{[^[\]]*id:\s*["'][^"']+["'][^[\]]*\}[\s\S]*?\]/);
if (serverList) {
  console.log('\nServer list:', serverList[0].slice(0, 500));
}

// Find the function that builds player URLs
const playerFns = [...js.matchAll(/(?:L3|k3|P3)\s*=\s*function[^}]{0,500}/g)];
console.log('\nPlayer URL functions:');
for (const m of playerFns) console.log('  ', m[0].slice(0, 200));

// Find ALL external URLs
const urls = [...js.matchAll(/["'](https?:\/\/[^"']{5,100})["']/g)];
console.log('\nExternal URLs:');
for (const m of [...new Set(urls.map(m => m[1]))]) {
  if (!m.includes('google') && !m.includes('font') && !m.includes('cloudflare') && 
      !m.includes('jsdelivr') && !m.includes('unpkg') && !m.includes('w3.org') &&
      !m.includes('schema') && !m.includes('react') && !m.includes('github') &&
      !m.includes('mozilla') && !m.includes('microsoft') && !m.includes('x.com') && 
      !m.includes('youtube') && !m.includes('tmdb') && !m.includes('vercel') &&
      !m.includes('heavenlysuspicious') && !m.includes('radix-ui') && !m.includes('flagcdn')) {
    console.log('  ', m);
  }
}
