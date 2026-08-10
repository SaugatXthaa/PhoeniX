// Deep dive into PenguPlay's JavaScript to find the antova provider definition
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import fs from 'fs';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// Get the main page HTML
const r = await gotScraping.get('https://pengu.uk/configure', {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
});
fs.writeFileSync('/tmp/pengu_configure.html', r.body);
console.log(`HTML saved: ${r.body.length} bytes`);

// Find all script src references
const scriptSrcs = [...r.body.matchAll(/src=["']([^"']+\.js[^"']*)["']/g)];
console.log(`\nScript sources:`);
for (const m of scriptSrcs) console.log(`  ${m[1]}`);

// Find all inline scripts and check for provider definitions
const inlineScripts = [...r.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
console.log(`\nInline scripts: ${inlineScripts.length}`);
for (let i = 0; i < inlineScripts.length; i++) {
  const code = inlineScripts[i][1];
  if (code.length < 50) continue;

  // Search for "antova" or provider-related strings
  const lower = code.toLowerCase();
  if (lower.includes('antova') || lower.includes('provider') || lower.includes('source')) {
    console.log(`\n=== Inline script ${i} (len ${code.length}) — contains provider/antova ===`);

    // Find antova mentions
    const antovaMatches = [...code.matchAll(/antova[^"'\s,;]{0,100}/gi)];
    console.log(`  Antova mentions: ${antovaMatches.length}`);
    for (const m of antovaMatches.slice(0, 10)) console.log(`    ${m[0]}`);

    // Find provider list
    const providerMatches = [...code.matchAll(/["']([a-z0-9_-]+)["']\s*:\s*\{[^}]*name\s*:\s*["']([^"']+)["']/gi)];
    console.log(`  Provider definitions: ${providerMatches.length}`);
    for (const m of providerMatches.slice(0, 20)) console.log(`    ${m[1]} = ${m[2]}`);

    // Find array of provider names
    const arrayMatches = [...code.matchAll(/\[["']([a-z0-9_-]+)["'](?:\s*,\s*["']([a-z0-9_-]+)["'])*\]/gi)];
    console.log(`  Arrays with provider-like strings:`);
    for (const m of arrayMatches.slice(0, 5)) {
      const strs = [...m[0].matchAll(/["']([a-z0-9_-]+)["']/g)].map(x => x[1]);
      if (strs.length > 2) console.log(`    ${strs.join(', ')}`);
    }

    // Save the full inline script for analysis
    fs.writeFileSync(`/tmp/pengu_inline_${i}.js`, code);
  }
}

// Also check for external JS modules (ESM imports)
const importMatches = [...r.body.matchAll(/import\s+(?:[^;]+\s+from\s+)?["']([^"']+)["']/g)];
console.log(`\nESM imports:`);
for (const m of importMatches) console.log(`  ${m[1]}`);

// Check for module preloads
const preloadMatches = [...r.body.matchAll(/<link[^>]*rel=["']modulepreload["'][^>]*href=["']([^"']+)["']/g)];
console.log(`\nModule preloads:`);
for (const m of preloadMatches) console.log(`  ${m[1]}`);
