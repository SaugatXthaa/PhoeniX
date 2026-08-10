// Probe player.zxcprime.xyz embed patterns with real TMDB IDs
import { gotScraping } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://player.zxcprime.xyz';

// Test cases
const TESTS = [
  { type: 'movie', tmdb: 155, name: 'The Dark Knight' },
  { type: 'tv', tmdb: 1396, s: 1, e: 1, name: 'Breaking Bad S01E01' },
  { type: 'movie', tmdb: 693134, name: 'Dune Part Two' },
  { type: 'tv', tmdb: 95479, s: 1, e: 1, name: 'Jujutsu Kaisen S01E01' },
  { type: 'tv', tmdb: 93405, s: 1, e: 1, name: 'Squid Game S01E01' },
];

// Try common URL patterns
const PATTERNS = [
  '/movie/{id}',
  '/tv/{id}/{s}/{e}',
  '/embed/movie/{id}',
  '/embed/tv/{id}/{s}/{e}',
  '/watch/movie/{id}',
  '/watch/tv/{id}/{s}/{e}',
  '/api/movie/{id}',
  '/api/tv/{id}/{s}/{e}',
  '/api/source/movie/{id}',
  '/api/source/tv/{id}/{s}/{e}',
  '/api/stream/movie/{id}',
  '/api/stream/tv/{id}/{s}/{e}',
  '/api/play/movie/{id}',
  '/api/play/tv/{id}/{s}/{e}',
];

for (const pat of PATTERNS) {
  const url = pat
    .replace('{id}', '155')
    .replace('{s}', '1')
    .replace('{e}', '1');
  const full = `${BASE}${url}`;
  console.log(`\n--- ${pat} → ${full}`);
  try {
    const res = await gotScraping.get(full, {
      headers: { 'User-Agent': UA, 'Accept': '*/*' },
      timeout: { request: 12000 },
      throwHttpErrors: false,
      followRedirect: true,
      maxRedirects: 5,
    });
    console.log(`Status: ${res.statusCode} | Final: ${res.url} | Len: ${res.body.length}`);
    if (res.statusCode === 200) {
      // Print first part of body
      const ct = res.headers['content-type'] || '';
      console.log(`CT: ${ct}`);
      if (ct.includes('json') || ct.includes('text/plain')) {
        console.log(`Body: ${res.body.slice(0, 1500)}`);
      } else {
        console.log(`Body snippet: ${res.body.slice(0, 800)}`);
      }
    }
  } catch (e) {
    console.log(`Err: ${e.message}`);
  }
}
