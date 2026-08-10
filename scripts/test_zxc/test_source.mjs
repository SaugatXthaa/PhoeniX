// Integration test: use the actual ZXCStream source class
import { ZXCStream } from '/home/z/my-project/src/source/ZXCStream.js';

// Mock fetcher (we don't use it directly in ZXCStream — all HTTP via gotScraping)
const mockFetcher = {
  text: async () => '',
  json: async () => ({}),
  textPost: async () => '',
};

// Mock ctx
const ctx = {
  config: { multi: true },
  hostUrl: 'https://addon.example.com',
};

// Mock TMDB ID
const TESTS = [
  { type: 'movie', id: { id: '155', type: 'movie' }, name: 'The Dark Knight' },
  { type: 'series', id: { id: '1396', type: 'series', season: 1, episode: 1 }, name: 'Breaking Bad S01E01' },
  { type: 'series', id: { id: '95479', type: 'series', season: 1, episode: 1 }, name: 'Jujutsu Kaisen S01E01' },
  { type: 'series', id: { id: '93405', type: 'series', season: 1, episode: 1 }, name: 'Squid Game S01E01' },
];

const source = new ZXCStream(mockFetcher);
console.log(`Source: ${source.id} (${source.label})`);
console.log(`ContentTypes: ${source.contentTypes.join(',')}`);
console.log(`CountryCodes: ${source.countryCodes.join(',')}`);
console.log(`TTL: ${source.ttl}ms\n`);

for (const t of TESTS) {
  console.log(`\n========== ${t.name} ==========`);
  try {
    const results = await source.handleInternal(ctx, t.type, t.id);
    console.log(`Got ${results.length} streams:`);
    for (const r of results.slice(0, 8)) {
      console.log(`  - [${r.format}] ${r.meta.title}`);
      console.log(`    URL: ${r.url.href.slice(0, 100)}...`);
      console.log(`    CC: ${r.meta.countryCodes.join(',')} | H: ${r.meta.height || '?'}`);
    }
    if (results.length > 8) console.log(`  ... and ${results.length - 8} more`);
  } catch (e) {
    console.log(`ERR: ${e.message}`);
    console.log(e.stack);
  }
}
