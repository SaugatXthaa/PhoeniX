/**
 * Batch-patch all source modules to accept the new context object.
 * Updates resolve(imdbId) -> resolve(ctxInput) with a normalizeContext wrapper.
 */

const fs = require('fs');
const path = require('path');

const SOURCES_DIR = path.join(__dirname, '..', 'sources');

// The normalizeContext wrapper to inject
const WRAPPER = `
/** Normalize input to a context object (supports both old string and new object API). */
function normalizeContext(input) {
  if (typeof input === 'string') {
    const parsed = utils.parseId(input);
    if (!parsed) return null;
    return {
      imdb: parsed.imdb,
      raw: input,
      title: null,
      year: null,
      type: parsed.isSeries ? 'series' : 'movie',
      season: parsed.season,
      episode: parsed.episode,
      isSeries: parsed.isSeries,
    };
  }
  return input;
}
`;

// Files already updated (lookmovie2 was manually rewritten)
const SKIP = new Set(['lookmovie2.js']);

const files = fs.readdirSync(SOURCES_DIR).filter((f) => f.endsWith('.js') && !SKIP.has(f));

let updated = 0;
let skipped = 0;

for (const file of files) {
  const filepath = path.join(SOURCES_DIR, file);
  let content = fs.readFileSync(filepath, 'utf8');

  // Skip if already patched
  if (content.includes('normalizeContext')) {
    skipped++;
    continue;
  }

  // Check if the file has the pattern: async function resolve(imdbId) {
  const oldPattern = /async function resolve\(imdbId\)\s*\{/;
  if (!oldPattern.test(content)) {
    console.log(`SKIP (no match): ${file}`);
    skipped++;
    continue;
  }

  // Replace the function signature
  content = content.replace(
    oldPattern,
    `${WRAPPER}\nasync function resolve(ctxInput) {\n  const ctx = normalizeContext(ctxInput);\n  if (!ctx) return [];\n  const imdbId = ctx.raw || ctx.imdb;`
  );

  // Also need to handle the `const parsed = utils.parseId(imdbId);` line
  // that follows in most files - it will still work since imdbId is set above
  // but we want to use ctx.title when available

  fs.writeFileSync(filepath, content, 'utf8');
  updated++;
  console.log(`PATCHED: ${file}`);
}

console.log(`\nDone: ${updated} patched, ${skipped} skipped`);
