import { gotScraping } from 'got-scraping';
const UA = 'Mozilla/5.0 Chrome/131';

const r = await gotScraping('https://new3.moviesdrive.christmas/your-name-2016/', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  timeout: { request: 15000 }, throwHttpErrors: false,
});

// Find mdrive.lol links
const mdriveLinks = [...r.body.matchAll(/<a[^>]+href="(https:\/\/mdrive\.lol\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
console.log('mdrive.lol links:', mdriveLinks.length);
for (const m of mdriveLinks.slice(0, 10)) {
  const text = m[2].replace(/<[^>]+>/g, '').trim();
  console.log('  href:', m[1]);
  console.log('  text:', text);
  console.log('');
}

// Also look for ANY external download links (not just mdrive.lol)
const externalLinks = [...r.body.matchAll(/<a[^>]+href="(https?:\/\/(?!new3\.moviesdrive|fonts\.|catimages|gmpg|t\.me|www\.imdb|moviedrive|moviesdrive|moviesdrives)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
console.log('\nOther external links:', externalLinks.length);
for (const m of externalLinks.slice(0, 10)) {
  const text = m[2].replace(/<[^>]+>/g, '').trim();
  if (text && text.length < 100) {
    console.log('  href:', m[1].slice(0, 120));
    console.log('  text:', text);
  }
}
