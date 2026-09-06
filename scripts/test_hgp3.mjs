import { gotScraping } from 'got-scraping';
import fs from 'fs';

const r = await gotScraping('https://hanerix.com/assets/jquery/hg-p1.js?type=main&u=40&v=20260807213908', {
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131', 'Referer': 'https://hanerix.com/' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

const body = r.body;

// The JS is obfuscated with _0x hex strings. Let me find the string table
// Look for _0x1c7f function which decodes strings
const stringTableMatch = body.match(/function\s+_0x1c7f\([^)]*\)\{[\s\S]{0,5000}/);
if (stringTableMatch) {
  console.log('Found _0x1c7f (string decoder)');
  // The string table is usually an array defined elsewhere
}

// Look for the array of strings (usually defined as a big array)
const arrayMatch = body.match(/\[(["'][^"']{1,50}["'],?\s*){10,}\]/);
if (arrayMatch) {
  console.log('Found string array (first 500):', arrayMatch[0].slice(0, 500));
}

// Look for $.ajax or $.post calls (jQuery)
const ajaxCalls = body.match(/\$\.ajax\([^)]+\)/gi) || body.match(/\$\.post\([^)]+\)/gi) || body.match(/\$\.get\([^)]+\)/gi);
if (ajaxCalls) {
  console.log('\njQuery AJAX calls:');
  for (const a of ajaxCalls) console.log('  ', a.slice(0, 200));
}

// Look for URL string literals
const urlStrings = body.match(/["'`](?:https?:\/\/|\/api\/|\/get\/|\/stream\/|\/file\/|\/dl\/)[^"'`]{5,80}["'`]/gi);
if (urlStrings) {
  console.log('\nURL strings:');
  for (const u of [...new Set(urlStrings)]) console.log('  ', u);
}

// Look for the string that looks like an API path (short, lowercase)
const apiPaths = body.match(/["'`\/][a-z_]{3,20}["'`\/]/g);
if (apiPaths) {
  const filtered = [...new Set(apiPaths)].filter(p => /api|source|file|stream|get|dl|play|video|media/.test(p));
  console.log('\nAPI-like strings:');
  for (const p of filtered.slice(0, 10)) console.log('  ', p);
}

// Save the full JS for manual inspection
fs.writeFileSync('/tmp/hgp1_full.js', body);
console.log('\nFull JS saved to /tmp/hgp1_full.js');
console.log('Total size:', body.length);
