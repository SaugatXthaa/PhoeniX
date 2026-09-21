// Task 72: cineby.by movie page — what does it embed NOW?
import { gotScraping } from 'got-scraping';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

// Dune: Part Two on cineby.by — find its slug from the search API or direct URL pattern
// Livewire pages: https://cineby.by/movie/<slug or tmdbid>
const page = await gotScraping.get('https://cineby.by/movie/693134', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  timeout: { request: 25000 }, throwHttpErrors: false, http2: false,
});
console.log(`cineby.by/movie/693134: ${page.statusCode} ${page.body.length}B`);
const h = page.body.toString();

// iframe / embed / vidking / player references
const iframes = [...h.matchAll(/<iframe[^>]+src="([^"]+)"/g)].map(m => m[1]);
console.log('iframes:', iframes.slice(0, 5));
const vk = [...new Set([...h.matchAll(/[a-z0-9.-]*vidking[a-z0-9.-]*|[a-z0-9.-]*speedracelight[a-z0-9.-]*/gi)].map(m => m[0]))];
console.log('vidking/srl refs:', vk);
// any server= or /embed/ patterns
// any URL that looks like an embed/player/watch target
const embedUrls = [...new Set([...h.matchAll(/https?:\/\/[^\s"')<>]{10,140}/gi)].map(m => m[0]))].filter(u => /embed|player|watch/i.test(u));
console.log('embed-ish urls:', embedUrls.slice(0, 8));
// livewire snapshot url for the player component
const lw = [...new Set([...h.matchAll(/livewire[^"'\s]{0,80}/gi)].map(m => m[0]))].slice(0, 4);
console.log('livewire refs:', lw);

// videasy.to DoH
for (const d of ['videasy.to', 'www.videasy.to', 'player.videasy.net', 'vidking.com']) {
  try {
    const q = await fetch(`https://1.1.1.1/dns-query?name=${d}&type=A`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) }).then(r => r.json());
    console.log(`DoH ${d}: status=${q.Status} ${(q.Answer || []).map(a => a.data).join(',')}`);
  } catch (e) { console.log(`DoH ${d}: ERR`); }
}

// vidking.com content check (parked or real player?)
const vkcom = await gotScraping.get('https://vidking.com/', {
  headers: { 'User-Agent': UA }, timeout: { request: 15000 }, throwHttpErrors: false, http2: false,
}).catch(e => null);
if (vkcom) console.log(`vidking.com: ${vkcom.statusCode} ${vkcom.body.length}B | ${vkcom.body.toString().replace(/\s+/g, ' ').slice(0, 100)}`);
