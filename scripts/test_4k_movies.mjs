import { gotScraping } from 'got-scraping';

const movies = [
  { name: 'Dune Part Two', imdb: 'tt15239678' },
  { name: 'Avatar Way of Water', imdb: 'tt1630029' },
  { name: 'Oppenheimer', imdb: 'tt15398776' },
  { name: 'The Batman', imdb: 'tt1877830' },
  { name: 'Top Gun Maverick', imdb: 'tt1745960' },
  { name: 'John Wick 4', imdb: 'tt10366206' },
];

for (const movie of movies) {
  const apiRes = await gotScraping(`https://data.vidsrcme.ru/api.php?type=movie&imdb=${movie.imdb}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131' },
    timeout: { request: 8000 }, throwHttpErrors: false,
  });
  
  if (apiRes.statusCode === 200) {
    const data = JSON.parse(apiRes.body);
    const fileName = data.data?.file_name || '';
    const has4K = /2160|4k|uhd/i.test(fileName);
    console.log(`${movie.name}: ${fileName.slice(0, 70)} | 4K: ${has4K}`);
  } else {
    console.log(`${movie.name}: API ${apiRes.statusCode}`);
  }
  
  await new Promise(r => setTimeout(r, 500));
}
