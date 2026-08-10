// Test HDGharTV with anime + kdrama + multiple titles to confirm coverage
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const API_BASE = 'https://hdghartv.cc/api';
const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

async function searchAndCount(query) {
  const r = await gotScraping.get(`${API_BASE}/search?q=${encodeURIComponent(query)}`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': 'https://hdghartv.cc/' },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  if (r.statusCode !== 200) return { query, status: r.statusCode, movies: 0, series: 0 };
  const d = JSON.parse(r.body);
  return {
    query, status: 200,
    movies: d.movies?.length || 0,
    series: d.series?.length || 0,
    movieTitles: (d.movies || []).slice(0, 3).map(m => `${m.title} (tmdb=${m.tmdbId}, ${m.releaseDate?.slice(0,4)})`),
    seriesTitles: (d.series || []).slice(0, 3).map(s => `${s.title} (tmdb=${s.tmdbId})`),
  };
}

const QUERIES = [
  'Breaking Bad', 'Jujutsu Kaisen', 'Squid Game', 'Demon Slayer',
  'The Dark Knight', 'Inception', 'Dune Part Two', 'Avengers Endgame',
  'Naruto', 'One Piece', 'Attack on Titan', 'Demon Slayer Mugen Train',
];

for (const q of QUERIES) {
  const r = await searchAndCount(q);
  console.log(`\n${q}: movies=${r.movies} series=${r.series}`);
  if (r.movieTitles?.length) console.log(`  movies: ${r.movieTitles.join(' | ')}`);
  if (r.seriesTitles?.length) console.log(`  series: ${r.seriesTitles.join(' | ')}`);
}
