// Test CineFreak URL resolution for all qualities including 4K
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

async function fetchPage(url) {
  const res = await gotScraping.get(url, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'text/html' },
    timeout: { request: 15000 }, throwHttpErrors: false, followRedirect: true,
  });
  return res.statusCode === 200 ? res.body : null;
}

const detailUrl = 'https://cinefreak.net/spider-man-homecoming-2017-dual-audio-hindi-dubbed-english-bluray-480p-720p-1080p-2160p-full-movie-download-watch-online-gdrive-esub-cinefreak/';
const html = await fetchPage(detailUrl);
const $ = cheerio.load(html);

const links = [];
$('a.dlbtn').each((_, el) => {
  const href = $(el).attr('href');
  if (!href || !href.includes('generate.php')) return;
  const isDownload = $(el).hasClass('dlbtn-download');
  if (!isDownload) return;
  let quality = 'HD';
  const $container = $(el).closest('.dlbtn-container');
  if ($container.length) {
    const h4Text = $container.prev('h4.movie-title').text().trim() ||
                   $container.find('h4').text().trim();
    if (h4Text) {
      const resMatch = h4Text.match(/(\d{3,4})p/i);
      if (resMatch) quality = `${resMatch[1]}p`;
      // Also check for 4K
      if (/4k|2160p/i.test(h4Text)) quality = '4K';
      console.log(`h4: "${h4Text}" → quality: ${quality}`);
    }
  }
  links.push({ quality, href });
});

console.log(`\nTotal download links: ${links.length}`);

// Try resolving each link
for (const dl of links) {
  console.log(`\n=== Resolving ${dl.quality} ===`);
  const b64Match = dl.href.match(/id=([^&]+)/);
  if (!b64Match) { console.log('  No base64 id'); continue; }

  let decoded;
  try { decoded = Buffer.from(b64Match[1], 'base64').toString('utf8'); }
  catch { console.log('  Base64 decode failed'); continue; }
  console.log(`  Decoded: ${decoded.slice(0, 80)}`);

  const cinecloudUrl = decoded.replace('newgo32', '').replace('/f/', '/x/');
  if (!cinecloudUrl.includes('cinecloud.site')) { console.log('  Not cinecloud URL'); continue; }
  console.log(`  Cinecloud: ${cinecloudUrl.slice(0, 80)}`);

  const ccHtml = await fetchPage(cinecloudUrl);
  if (!ccHtml) { console.log('  Cinecloud page failed'); continue; }

  const iframeMatch = ccHtml.match(/<iframe[^>]+src="([^"]+)"/);
  if (!iframeMatch) { console.log('  No iframe found'); continue; }
  console.log(`  Iframe: ${iframeMatch[1].slice(0, 80)}`);

  const idMatch = iframeMatch[1].match(/id=([^&]+)/);
  if (!idMatch) { console.log('  No id param'); continue; }

  let streamUrl;
  try { streamUrl = decodeURIComponent(decodeURIComponent(idMatch[1])); }
  catch { try { streamUrl = decodeURIComponent(idMatch[1]); } catch { console.log('  URL decode failed'); continue; } }

  console.log(`  Stream URL: ${streamUrl.slice(0, 100)}`);

  // Test if stream URL works
  try {
    const r = await gotScraping.head(streamUrl, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }) },
      timeout: { request: 8000 }, throwHttpErrors: false, followRedirect: true,
    });
    console.log(`  HEAD: ${r.statusCode} | CT: ${r.headers['content-type']} | CL: ${r.headers['content-length']}`);
  } catch (e) { console.log(`  HEAD ERR: ${e.message}`); }
}
