import { gotScraping } from 'got-scraping';

const movies = [
  { name: 'Interstellar', imdb: 'tt0816692' },
  { name: 'Blade Runner 2049', imdb: 'tt1856101' },
  { name: 'Mad Max Fury Road', imdb: 'tt1392190' },
  { name: 'Gemini Man', imdb: 'tt1025100' }, // Known 4K release
  { name: 'The Revenant', imdb: 'tt1663202' },
];

for (const movie of movies) {
  const apiRes = await gotScraping(`https://data.vidsrcme.ru/api.php?type=movie&imdb=${movie.imdb}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
    timeout: { request: 8000 }, throwHttpErrors: false,
  });
  if (apiRes.statusCode === 200) {
    const data = JSON.parse(apiRes.body);
    const fileName = data.data?.file_name || '';
    console.log(`${movie.name}: ${fileName.slice(0, 80)}`);
  }
  await new Promise(r => setTimeout(r, 300));
}
