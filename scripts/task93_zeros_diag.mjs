// Task 93: deep diagnosis of zxcstream / netlio / animeflix / nowhdtime zeros.
import { Fetcher } from '../src/utils/Fetcher.js';
import { ImdbId } from '../src/utils/index.js';

const realFetcher = new Fetcher(console);

const logs = [];
const logger = {
  log: (...a) => logs.push(a.join(' ')),
  info: (...a) => logs.push(a.join(' ')),
  warn: (...a) => logs.push('WARN: ' + a.join(' ')),
  error: (...a) => logs.push('ERR: ' + a.join(' ')),
  debug: () => {},
};

const { createSources } = await import('../src/source/index.js');
const fetcher = realFetcher;
const sources = createSources(fetcher);

const targets = (process.argv[2] || 'zxcstream,netlio,animeflix,nowhdtime').split(',');
const ID = process.argv[3] || 'tt1375666'; // Inception imdb
const TYPE = process.argv[4] || 'movie';

// TMDB key absent in sandbox → mock find/movie endpoints per title
const TMDB = {
  'tt1375666': { id: 27205, title: 'Inception', release_date: '2010-07-15' },
  'tt15239678': { id: 693134, title: 'Dune: Part Two', release_date: '2024-02-27' },
};
const wrappedFetcher = new Proxy(fetcher, {
  get(t, prop) {
    if (prop !== 'json') return t[prop]?.bind ? t[prop].bind(t) : t[prop];
    return async (ctx, url, options) => {
      const u = String(url);
      const imdb = Object.keys(TMDB).find(k => u.includes(`/find/${k}`));
      if (u.includes('api.themoviedb.org') && imdb) {
        if (u.includes('/find/')) return { movie_results: [TMDB[imdb]], tv_results: [] };
        return { ...TMDB[imdb], imdb_id: imdb, external_ids: { imdb_id: imdb } };
      }
      return t.json(ctx, url, options);
    };
  },
});

for (const id of targets) {
  const src = sources.find(s => s.id === id);
  if (!src) { console.log(`[${id}] NOT IN REGISTRY`); continue; }
  logs.length = 0;
  const t0 = Date.now();
  try {
    const res = await Promise.race([
      src.handleInternal({ config: { multi: 'on', en: 'on' } }, TYPE, ImdbId.fromString(ID)),
      new Promise(r => setTimeout(() => r(null), 32000)),
    ]);
    console.log(`\n===== [${id}] ${res ? res.length : 'TIMEOUT>32s'} results (${Date.now() - t0}ms) =====`);
  } catch (e) {
    console.log(`\n===== [${id}] ERROR: ${e?.message || e} (${Date.now() - t0}ms) =====`);
  }
  for (const l of logs.slice(0, 22)) console.log('  ', l.slice(0, 150));
}
process.exit(0);
