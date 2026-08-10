// Test HDGharTV scraper API
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const API_BASE = 'https://hdghartv.cc/api';
const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US', 'en'] });

async function test() {
  // Step 1: Search for "Dune"
  console.log('=== /search?q=dune ===');
  const searchRes = await gotScraping.get(`${API_BASE}/search?q=dune`, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': 'https://hdghartv.cc/' },
    timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  });
  console.log(`Status: ${searchRes.statusCode}`);
  if (searchRes.statusCode !== 200) {
    console.log(`Body: ${searchRes.body.slice(0, 500)}`);
    return;
  }
  const data = JSON.parse(searchRes.body);
  console.log(`movies: ${data.movies?.length || 0}, series: ${data.series?.length || 0}, total: ${data.total}`);
  if (data.movies?.[0]) {
    console.log(`First movie:`, JSON.stringify({
      _id: data.movies[0]._id,
      title: data.movies[0].title,
      tmdbId: data.movies[0].tmdbId,
      releaseDate: data.movies[0].releaseDate,
    }, null, 2));
  }
  if (data.series?.[0]) {
    console.log(`First series:`, JSON.stringify({
      _id: data.series[0]._id,
      title: data.series[0].title,
      tmdbId: data.series[0].tmdbId,
    }, null, 2));
  }

  // Step 2: Get movie detail
  if (data.movies?.[0]?._id) {
    const movieId = data.movies[0]._id;
    console.log(`\n=== /movies/public/${movieId} ===`);
    const movieRes = await gotScraping.get(`${API_BASE}/movies/public/${movieId}`, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': 'https://hdghartv.cc/' },
      timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
    });
    console.log(`Status: ${movieRes.statusCode}`);
    if (movieRes.statusCode === 200) {
      const movie = JSON.parse(movieRes.body);
      console.log(`Title: ${movie.title}`);
      console.log(`TMDB ID: ${movie.tmdbId}`);
      console.log(`Streaming links: ${movie.streamingLinks?.length || 0}`);
      if (movie.streamingLinks?.[0]) {
        console.log(`First link:`, JSON.stringify(movie.streamingLinks[0], null, 2));
      }
    } else {
      console.log(`Body: ${movieRes.body.slice(0, 500)}`);
    }
  }

  // Step 3: Get series detail
  if (data.series?.[0]?._id) {
    const seriesId = data.series[0]._id;
    console.log(`\n=== /series/public/${seriesId} ===`);
    const seriesRes = await gotScraping.get(`${API_BASE}/series/public/${seriesId}`, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json', 'Referer': 'https://hdghartv.cc/' },
      timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
    });
    console.log(`Status: ${seriesRes.statusCode}`);
    if (seriesRes.statusCode === 200) {
      const series = JSON.parse(seriesRes.body);
      console.log(`Title: ${series.title}`);
      console.log(`Seasons: ${series.seasons?.length || 0}`);
      if (series.seasons?.[0]) {
        console.log(`First season:`, JSON.stringify({
          seasonNumber: series.seasons[0].seasonNumber,
          episodes: series.seasons[0].episodes?.length,
        }));
        if (series.seasons[0].episodes?.[0]?.streamingLinks?.[0]) {
          console.log(`First ep link:`, JSON.stringify(series.seasons[0].episodes[0].streamingLinks[0], null, 2));
        }
      }
    } else {
      console.log(`Body: ${seriesRes.body.slice(0, 500)}`);
    }
  }
}

test().catch(e => console.error('ERR:', e.message));
