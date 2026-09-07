import { gotScraping } from 'got-scraping';

// Fetch the movie page and look for ALL server configurations
const r = await gotScraping('https://www.imdbplay.tech/movie/27205', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

const html = r.body;

// Find ALL server-related data in the page
// Look for data attributes, JSON configs, or inline scripts
const serverPatterns = [
  /server[_-]?\d+[^}]{0,500}/gi,
  /source[_-]?\d+[^}]{0,500}/gi,
  /stream[_-]?\d+[^}]{0,500}/gi,
];

// Look for JSON data that might contain server URLs
const jsonBlocks = html.match(/\{[^{}]*server[^{}]*\}/gi);
if (jsonBlocks) {
  console.log('JSON blocks with "server":', jsonBlocks.length);
  for (const b of jsonBlocks.slice(0, 5)) console.log('  ', b.slice(0, 200));
}

// Look for the server switch function and how it loads different servers
const switchFn = html.match(/(?:switch|select|set|change)Server[^{]*\{[^}]{0,1000}/i);
if (switchFn) {
  console.log('\nSwitch server function:', switchFn[0].slice(0, 500));
}

// Look for ALL iframe/embed URLs
const allUrls = [...html.matchAll(/https?:\/\/[^"'<>\s]+/gi)];
const embedUrls = [...new Set(allUrls.map(m => m[0]))].filter(u => 
  !u.includes('imdbplay.tech') && !u.includes('google') && !u.includes('font') && 
  !u.includes('cloudflare') && !u.includes('jsdelivr') && !u.includes('unpkg') &&
  !u.includes('w3.org') && !u.includes('schema') && !u.includes('react') &&
  !u.includes('github') && !u.includes('mozilla') && !u.includes('microsoft') &&
  !u.includes('youtube') && !u.includes('image.tmdb') && !u.includes('warnerbros') &&
  !u.includes('x.com')
);
console.log('\nExternal URLs:', embedUrls.length);
for (const u of embedUrls) console.log('  ', u.slice(0, 200));

// Look for the TanStack Start server function that loads streams
// The page uses serverFn pattern — search for it
const serverFns = [...html.matchAll(/serverFn[^"]{0,200}/gi)];
console.log('\nServer function references:', serverFns.length);
for (const m of serverFns.slice(0, 3)) console.log('  ', m[0].slice(0, 150));

// Look for the actual stream loading code
const streamCode = html.match(/(?:loadStream|playVideo|setSource|initPlayer|startPlayback)[^;]{0,500}/i);
if (streamCode) console.log('\nStream loading code:', streamCode[0].slice(0, 300));

// Check if there's a __TSR_DATA__ or similar data blob with server configs
const tsrData = html.match(/(?:__TSR|__NEXT|__INITIAL|window\.__)[A-Z_]*\s*=\s*[^;]{5,500}/);
if (tsrData) console.log('\nApp data:', tsrData[0].slice(0, 300));

// Dump the server button area
const serverArea = html.match(/Server\s*1.*?Server\s*9[^<]*/i);
if (serverArea) console.log('\nServer area:', serverArea[0].slice(0, 500));

// Look for ALL button data attributes
const buttons = [...html.matchAll(/<button[^>]*(?:Server|server)[^>]*>/gi)];
console.log('\nServer buttons:', buttons.length);
for (const b of buttons.slice(0, 3)) {
  console.log('  ', b[0].slice(0, 200));
}
