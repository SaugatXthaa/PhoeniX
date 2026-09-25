// Task 93: reproduce the Inception 4khdhub zero — extractor-level logging,
// incl. the Task 92 liveness-gate drop warnings that never reach /debug/source.
import { createFetchHandler } from '../src/utils/FetchHandler.js';
import { createExtractors } from '../src/extractor/index.js';
import { ExtractorRegistry } from '../src/extractor/Registry.js';

const logs = [];
const logger = {
  log: (...a) => { logs.push(a.join(' ')); },
  warn: (...a) => { logs.push('WARN: ' + a.join(' ')); },
  error: (...a) => { logs.push('ERR: ' + a.join(' ')); },
  debug: () => {},
};

const fetcher = createFetchHandler({}, logger);
const extractors = createExtractors(fetcher, logger);
const registry = new ExtractorRegistry(logger, extractors);

const url = process.argv[2];
if (!url) { console.error('usage: node task93_hubcloud_repro.mjs <hubcloud-or-4khdhub-url>'); process.exit(1); }

console.log('--- probing:', url.slice(0, 120));
const ctx = { referer: 'https://4khdhub.one/' };
try {
  const out = await registry.handle(ctx, new URL(url), { sourceLabel: 'repro', sourceId: 'repro' }, true);
  console.log('results:', out.length);
  for (const r of out) {
    console.log('  ->', (r.label || r.extractorId || '?'), String(r.url?.href || r.url).slice(0, 110));
  }
} catch (e) {
  console.error('HANDLE ERROR:', e?.message || e);
}
console.log('--- extractor/logs mentioning hubcloud/drop:');
for (const l of logs) {
  if (/hubcloud|drop|dead|liveness/i.test(l)) console.log('  ', l.slice(0, 160));
}
process.exit(0);
