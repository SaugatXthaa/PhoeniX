// Check PenguPlay configure page for provider/source list
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

const r = await gotScraping.get('https://pengu.uk/configure', {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});
console.log(`Status: ${r.statusCode} | Body len: ${r.body.length}`);

// Search for provider names, language options, etc.
const text = r.body;

// Look for select/option elements (provider dropdowns)
const optionMatches = [...text.matchAll(/<option[^>]*value=["']([^"']+)["'][^>]*>([^<]+)<\/option>/g)];
console.log(`\nOptions found: ${optionMatches.length}`);
for (const m of optionMatches.slice(0, 30)) {
  console.log(`  value="${m[1]}" | label="${m[2]}"`);
}

// Look for provider/source names
const providerMatches = [...text.matchAll(/(?:provider|source|lang|audio|dub|sub)["\s:=]+["']?([a-zA-Z0-9_-]+)["']?/gi)];
console.log(`\nProvider/lang mentions:`);
const seen = new Set();
for (const m of providerMatches) {
  if (!seen.has(m[1]) && m[1].length > 2 && m[1].length < 30) {
    seen.add(m[1]);
    console.log(`  ${m[1]}`);
  }
}

// Look for data attributes
const dataMatches = [...text.matchAll(/data-[\w-]+=["']([^"']+)["']/g)];
console.log(`\nData attributes:`);
const seenData = new Set();
for (const m of dataMatches.slice(0, 50)) {
  if (!seenData.has(m[1]) && m[1].length > 2 && m[1].length < 40) {
    seenData.add(m[1]);
    console.log(`  ${m[1]}`);
  }
}

// Check for JavaScript that defines providers
const scriptMatches = [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
console.log(`\nInline scripts: ${scriptMatches.length}`);
for (const s of scriptMatches) {
  if (s[1].includes('provider') || s[1].includes('source') || s[1].includes('lang')) {
    // Find provider definitions
    const providers = [...s[1].matchAll(/["']([a-z0-9_-]+)["']\s*:\s*["']([a-z0-9\s_-]+)["']/gi)];
    for (const p of providers.slice(0, 20)) {
      console.log(`  ${p[1]} = ${p[2]}`);
    }
  }
}
