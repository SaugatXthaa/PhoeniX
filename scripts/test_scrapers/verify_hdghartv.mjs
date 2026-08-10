// Verify HDGharTV stream URLs are playable
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

// Fresh URLs (need to fetch them right before testing)
const API_BASE = 'https://hdghartv.cc/api';

async function getFreshStream(tmdbTitle) {
  const searchRes = await gotScraping.get(`${API_BASE}/search?q=${encodeURIComponent(tmdbTitle)}`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': 'https://hdghartv.cc/' },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  const data = JSON.parse(searchRes.body);
  if (!data.movies?.length) return null;
  const movieRes = await gotScraping.get(`${API_BASE}/movies/public/${data.movies[0]._id}`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': 'https://hdghartv.cc/' },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  const movie = JSON.parse(movieRes.body);
  return movie.streamingLinks?.filter(l => l.isActive !== false && l.url);
}

console.log('=== Test: Dune (movie) ===');
const links = await getFreshStream('Dune');
if (links) {
  console.log(`Got ${links.length} links`);
  for (const l of links) {
    console.log(`\n[${l.quality}] ${l.url.slice(0, 80)}...`);
    // Try HEAD first
    try {
      const headRes = await gotScraping.head(l.url, {
        headers: { ...hg.getHeaders({ httpVersion: '2' }) },
        timeout: { request: 8000 }, throwHttpErrors: false, http2: true, followRedirect: true,
      });
      console.log(`  HEAD: ${headRes.statusCode} | CT: ${headRes.headers['content-type']} | CL: ${headRes.headers['content-length']}`);
    } catch (e) {
      console.log(`  HEAD ERR: ${e.message}`);
    }
    // Try GET (m3u8 should return text)
    try {
      const getRes = await gotScraping.get(l.url, {
        headers: { ...hg.getHeaders({ httpVersion: '2' }) },
        timeout: { request: 8000 }, throwHttpErrors: false, http2: true, followRedirect: true,
      });
      console.log(`  GET: ${getRes.statusCode} | CT: ${getRes.headers['content-type']} | Body len: ${getRes.body.length}`);
      if (getRes.statusCode === 200) {
        console.log(`  First 200 chars: ${getRes.body.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`  GET ERR: ${e.message}`);
    }
  }
}
