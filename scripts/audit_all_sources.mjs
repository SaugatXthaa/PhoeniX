// Comprehensive source audit:
//   1. List all sources registered in createSources()
//   2. For each source, check:
//      - Source file exists in src/source/
//      - Nuvio scraper file exists in src/nuvio/ (if applicable)
//      - Source ID is in NUVIO_SOURCE_IDS (if it's a Nuvio source)
//      - Scraper module loads and exports getStreams
//   3. Identify orphan nuvio/*.cjs scrapers (not registered)
//   4. Identify Nuvio source IDs missing from NUVIO_SOURCE_IDS

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const PROJECT_ROOT = path.join(__dirname, '..');
const SRC = path.join(PROJECT_ROOT, 'src');

// ─── Step 1: Load all registered sources ────────────────────────────────
const { createSources } = await import(path.join(SRC, 'source', 'index.js'));
const mockFetcher = { json: async () => ({}), head: async () => { throw new Error('mock'); } };
const sources = createSources(mockFetcher);

console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`STEP 1: ${sources.length} sources registered in createSources()`);
console.log(`══════════════════════════════════════════════════════════════════════`);
sources.forEach((s, i) => {
  console.log(`${String(i+1).padStart(2)}. ${s.id.padEnd(15)} | ${s.label.padEnd(20)} | types=${JSON.stringify(s.contentTypes).padEnd(20)} | domainKey=${s.domainKey}`);
});

// ─── Step 2: Check each source file exists ──────────────────────────────
console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`STEP 2: Verify source files exist in src/source/`);
console.log(`══════════════════════════════════════════════════════════════════════`);
const SOURCE_DIR = path.join(SRC, 'source');
const allSourceFiles = fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith('.js') && f !== 'index.js' && f !== 'Source.js');

const missingFiles = [];
const extraFiles = [];
for (const s of sources) {
  // Find the file that defines this source by className → filename
  const className = s.constructor.name;
  const expectedFile = className + '.js';
  const fullPath = path.join(SOURCE_DIR, expectedFile);
  if (!fs.existsSync(fullPath)) {
    missingFiles.push({ id: s.id, className, expectedFile });
  }
}
console.log(`Missing source files: ${missingFiles.length === 0 ? 'NONE ✅' : missingFiles.length}`);
missingFiles.forEach(m => console.log(`  ❌ ${m.id} (${m.className}) expected at ${m.expectedFile}`));

// ─── Step 3: Check Nuvio scrapers ───────────────────────────────────────
console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`STEP 3: Nuvio scrapers in src/nuvio/`);
console.log(`══════════════════════════════════════════════════════════════════════`);
const NUVIO_DIR = path.join(SRC, 'nuvio');
const nuvioFiles = fs.readdirSync(NUVIO_DIR).filter(f => f.endsWith('.cjs'));
console.log(`Total .cjs files in src/nuvio/: ${nuvioFiles.length}`);

// Load NuvioExtractor's NUVIO_SOURCE_IDS set
const { NuvioExtractor } = await import(path.join(SRC, 'extractor', 'NuvioExtractor.js'));
const extractor = new NuvioExtractor(mockFetcher, { log: () => {} });

// For each registered source, check if it's a Nuvio source (has providerPath or nuvio reference)
console.log(`\nChecking which sources are Nuvio-backed:`);
const nuvioSources = [];
for (const s of sources) {
  // Try to detect Nuvio sources by checking if they have a providerPath
  // or by inspecting the source file for nuvio references
  const className = s.constructor.name;
  const sourceFile = path.join(SOURCE_DIR, className + '.js');
  if (fs.existsSync(sourceFile)) {
    const content = fs.readFileSync(sourceFile, 'utf8');
    if (content.includes('nuvio/') || content.includes('NuvioSource') || content.includes('buildStreamResults') || content.includes('callNuvioProvider')) {
      const supported = extractor.supports({}, null, { sourceId: s.id, nuvioProvider: true });
      nuvioSources.push({ id: s.id, className, supported });
      const flag = supported ? '✅' : '❌ NOT IN NUVIO_SOURCE_IDS';
      console.log(`  ${flag} ${s.id.padEnd(15)} (${className})`);
    }
  }
}

const missingNuvioRegistration = nuvioSources.filter(s => !s.supported);
console.log(`\nNuvio sources missing from NUVIO_SOURCE_IDS: ${missingNuvioRegistration.length === 0 ? 'NONE ✅' : missingNuvioRegistration.length}`);
missingNuvioRegistration.forEach(m => console.log(`  ❌ ${m.id} (${m.className}) — extractor won't route these streams`));

// ─── Step 4: Check for orphan nuvio scrapers ────────────────────────────
console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`STEP 4: Orphan nuvio scrapers (not referenced by any source)`);
console.log(`══════════════════════════════════════════════════════════════════════`);

// Read all source files to find which .cjs modules are referenced
const referencedModules = new Set();
for (const f of allSourceFiles) {
  const content = fs.readFileSync(path.join(SOURCE_DIR, f), 'utf8');
  // Match patterns like: nuvio/<name>.cjs  or  `<name>.cjs`  or  moduleName: '<name>'
  const matches = content.matchAll(/nuvio\/([a-zA-Z0-9_-]+)\.cjs|module:\s*['"]([a-zA-Z0-9_-]+)['"]/g);
  for (const m of matches) {
    if (m[1]) referencedModules.add(m[1]);
    if (m[2]) referencedModules.add(m[2]);
  }
}
// Also check NuvioSource.js for opts.module references
const nuvioSourceContent = fs.readFileSync(path.join(SOURCE_DIR, 'NuvioSource.js'), 'utf8');

const orphans = [];
for (const f of nuvioFiles) {
  const baseName = f.replace(/\.cjs$/, '');
  // Skip Wrapper files that just re-export another module
  if (baseName.endsWith('Wrapper')) {
    continue;
  }
  // Skip files that are explicitly required by a Wrapper
  const isWrapped = nuvioFiles.some(other => {
    if (other === f) return false;
    try {
      const c = fs.readFileSync(path.join(NUVIO_DIR, other), 'utf8');
      return c.includes(baseName + '.cjs') || c.includes(baseName + '.js') || c.includes(baseName);
    } catch { return false; }
  });
  if (!referencedModules.has(baseName) && !isWrapped) {
    orphans.push(baseName);
  }
}
console.log(`Orphan nuvio scrapers (not referenced by any source): ${orphans.length === 0 ? 'NONE ✅' : orphans.length}`);
orphans.forEach(o => console.log(`  ⚠️  ${o}.cjs — not referenced in any source file`));

// ─── Step 5: Try loading each nuvio scraper ─────────────────────────────
console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`STEP 5: Load each referenced nuvio scraper module`);
console.log(`══════════════════════════════════════════════════════════════════════`);

const brokenScrapers = [];
for (const s of nuvioSources) {
  const className = s.constructor?.name || '';
  // Find the .cjs module path from the source file
  const sourceFile = path.join(SOURCE_DIR, className + '.js');
  if (!fs.existsSync(sourceFile)) continue;
  const content = fs.readFileSync(sourceFile, 'utf8');
  // Find module name: could be opts.module or hardcoded path
  let moduleName = null;
  const m1 = content.match(/moduleName\s*=\s*opts\.module/);
  if (m1) {
    // It's set via opts.module — find the value in index.js
    const indexContent = fs.readFileSync(path.join(SOURCE_DIR, 'index.js'), 'utf8');
    const re = new RegExp(`new ${className}\\(\\s*fetcher\\s*,\\s*\\{[^}]*module:\\s*['"]([^'"]+)['"]`, 's');
    const m = indexContent.match(re);
    if (m) moduleName = m[1];
  }
  if (!moduleName) {
    const m = content.match(/nuvio['"]?,?\s*['"]([a-zA-Z0-9_-]+)\.cjs['"]/);
    if (m) moduleName = m[1];
  }
  if (!moduleName) {
    // Check for hardcoded path with module name
    const m = content.match(/module:\s*['"]([a-zA-Z0-9_-]+)['"]/);
    if (m) moduleName = m[1];
  }
  if (!moduleName) {
    // Try to find PROVIDER_PATH or similar
    const m = content.match(/PROVIDER_PATH\s*=\s*path\.join\([^)]+,\s*['"]([a-zA-Z0-9_-]+)['"]/);
    if (m) moduleName = m[1];
  }
  if (!moduleName) {
    // Check if it uses callNuvioProvider
    if (content.includes('callNuvioProvider')) {
      const indexContent = fs.readFileSync(path.join(SOURCE_DIR, 'index.js'), 'utf8');
      const re = new RegExp(`new ${className}\\([\\s\\S]*?module:\\s*['"]([^'"]+)['"]`, 's');
      const m = indexContent.match(re);
      if (m) moduleName = m[1];
    }
  }
  if (!moduleName) {
    console.log(`  ⚠️  ${s.id} (${className}) — could not determine module name`);
    continue;
  }
  const scraperPath = path.join(NUVIO_DIR, moduleName + '.cjs');
  if (!fs.existsSync(scraperPath)) {
    console.log(`  ❌ ${s.id} (${className}) → ${moduleName}.cjs — FILE NOT FOUND`);
    brokenScrapers.push({ id: s.id, module: moduleName, error: 'file not found' });
    continue;
  }
  try {
    delete require_.cache[require_.resolve(scraperPath)];
    const mod = require_(scraperPath);
    if (typeof mod.getStreams !== 'function') {
      console.log(`  ❌ ${s.id} (${className}) → ${moduleName}.cjs — no getStreams export`);
      brokenScrapers.push({ id: s.id, module: moduleName, error: 'no getStreams export' });
    } else {
      console.log(`  ✅ ${s.id.padEnd(15)} (${className.padEnd(20)}) → ${moduleName}.cjs loads OK`);
    }
  } catch (e) {
    console.log(`  ❌ ${s.id} (${className}) → ${moduleName}.cjs — load error: ${e.message}`);
    brokenScrapers.push({ id: s.id, module: moduleName, error: e.message });
  }
}

// ─── Summary ────────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════════════════════════════════════`);
console.log(`SUMMARY`);
console.log(`══════════════════════════════════════════════════════════════════════`);
console.log(`Total sources registered:        ${sources.length}`);
console.log(`Total source files in src/source: ${allSourceFiles.length}`);
console.log(`Total nuvio scrapers:             ${nuvioFiles.length}`);
console.log(`Nuvio-backed sources:             ${nuvioSources.length}`);
console.log(`Missing source files:             ${missingFiles.length}`);
console.log(`Missing NuvioExtractor wiring:    ${missingNuvioRegistration.length}`);
console.log(`Orphan nuvio scrapers:            ${orphans.length}`);
console.log(`Broken nuvio scrapers:            ${brokenScrapers.length}`);

if (missingFiles.length === 0 && missingNuvioRegistration.length === 0 && brokenScrapers.length === 0) {
  console.log(`\n✅ All sources properly registered and all scrapers load.`);
} else {
  console.log(`\n⚠️  Issues found — see details above.`);
}
