import { gotScraping } from 'got-scraping';
import fs from 'fs';

// Download the JS
const r = await gotScraping('https://hanerix.com/assets/jquery/hg-p1.js?type=main&u=40&v=20260807213908', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://hanerix.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

const js = r.body;
fs.writeFileSync('/tmp/hgp1_raw.js', js);

// The obfuscated JS has a string array and a decoder function
// Let me try to extract the string array and decode it

// Find the string array (usually at the beginning)
const arrayMatch = js.match(/\[([\s\S]{100,5000}?)\]/);
if (arrayMatch) {
  // Try to eval the array
  try {
    const arr = eval(arrayMatch[0]);
    console.log('String array length:', arr.length);
    console.log('First 20 strings:', arr.slice(0, 20));
    
    // Look for URL-like strings
    const urlStrings = arr.filter(s => /https?:\/\//.test(s) || /\/api\//.test(s) || /\.m3u8/.test(s) || /\.mp4/.test(s));
    console.log('\nURL-like strings:');
    for (const u of urlStrings) console.log('  ', u);
    
    // Look for API path strings
    const apiStrings = arr.filter(s => /^[a-z_]{3,20}$/.test(s) && /api|source|file|stream|get|dl|play|video|media|embed/.test(s));
    console.log('\nAPI-like strings:');
    for (const s of apiStrings) console.log('  ', s);
  } catch (e) {
    console.log('Eval error:', e.message);
  }
}

// Also look for $.ajax setup
const ajaxSetup = js.match(/\$\.ajaxSetup\([^)]+\)/gi);
if (ajaxSetup) console.log('\najaxSetup:', ajaxSetup);

// Look for beforeSend or headers setup
const headers = js.match(/headers\s*:\s*\{[^}]+\}/gi);
if (headers) {
  console.log('\nHeaders:');
  for (const h of headers.slice(0, 5)) console.log('  ', h);
}
