// Task 64: local harness for anime sources (mirrors /debug/source)
import { Fetcher } from '../src/utils/index.js';
import { AnimeKai } from '../src/source/AnimeKai.js';
import { TmdbId } from '../src/utils/index.js';

const logger = { info: () => { }, warn: () => { }, error: () => { }, debug: () => { } };
const fetcher = new Fetcher(logger);
const kai = new AnimeKai(fetcher);

const ctx = {
  hostUrl: new URL('https://localhost'),
  id: '',
  ip: '127.0.0.1',
  config: { multi: 'on', en: 'on' },
};

const rawId = process.argv[2] || '95479:1:1';
const parsedId = TmdbId.fromString(rawId);
const results = await Promise.race([
  kai.handleInternal(ctx, 'series', parsedId),
  new Promise(r => setTimeout(() => r({ __timeout: true }), 45000)),
]);
if (results.__timeout) { console.log('TIMEOUT'); process.exit(0); }
console.log('RESULT:', results.length);
for (const r of results.slice(0, 4)) {
  console.log('-', r.meta?.title?.slice(0, 80));
  console.log('  url:', (r.url?.href || '').slice(0, 90));
  const subs = r.meta?.subtitles || [];
  console.log('  subs:', subs.length, subs[0] ? subs[0].lang : '');
}
