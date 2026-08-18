// Mimic AnimeWorld source's findAnime EXACTLY using cheerio
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';

const BASE_URL = 'https://watchanimeworld.top';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const normalize = (s) => (s || '').toLowerCase()
  .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

async function main() {
  const query = 'Demon Slayer';
  const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
  console.log('Fetching:', searchUrl);

  const res = await gotScraping.get(searchUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    timeout: { request: 15000 },
    throwHttpErrors: false,
    followRedirect: true,
  });
  console.log('Status:', res.statusCode, 'Length:', res.body.length);

  const html = res.body;
  const $ = cheerio.load(html);

  // Mimic source's selector and regex
  const wantedType = 'series';
  const nameNorm = normalize('Demon Slayer: Kimetsu no Yaiba');
  console.log('nameNorm:', nameNorm);

  const candidates = [];
  const seen = new Set();
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(new RegExp(`${BASE_URL}/(series|movies)/([^/?#]+)/?`));
    if (!match) return;
    const type = match[1];
    const slug = match[2];
    if (type !== wantedType) return;
    if (slug === 'page' || seen.has(slug)) return;
    seen.add(slug);

    const text = normalize($(el).text());
    console.log(`  Found: type=${type} slug=${slug} text="${text}" (href: ${href.slice(0, 80)})`);

    if (!text || text.length <= 3) return;
    let score = 0;
    if (text === nameNorm) score = 100;
    else if (nameNorm.startsWith(text) && text.length >= 6) score = 92;
    else if (text.includes(nameNorm)) score = 90;
    else if (nameNorm.includes(text) && text.length >= 6) score = 85;
    else {
      const nameWords = nameNorm.split(' ').filter(w => w.length > 2);
      const textWords = text.split(' ').filter(w => w.length > 2);
      if (nameWords.length > 0 && textWords.length > 0) {
        const common = nameWords.filter(w => textWords.includes(w));
        const overlap = common.length / Math.max(nameWords.length, textWords.length);
        if (overlap >= 0.5) score = overlap * 80;
      }
    }
    if (score > 0) {
      candidates.push({ url: href, score, text, slug });
    }
  });

  console.log(`\nCandidates: ${candidates.length}`);
  for (const c of candidates) {
    console.log(`  score=${c.score} text="${c.text}" slug=${c.slug}`);
  }
}

main().catch(console.error);
