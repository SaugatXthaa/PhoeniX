// Task 86e: RE cinehdplus series page — why does vimeus/legacy extraction zero?
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
import fs from 'fs';

const res = await fetch('https://cinehdplus.surf/peliculas/21771-breaking-bad-ver-online-hd.html', {
  headers: { 'User-Agent': UA, Referer: 'https://cinehdplus.surf/' },
  signal: AbortSignal.timeout(20000),
});
const html = await res.text();
console.log('status', res.status, 'len', html.length);
fs.writeFileSync('/tmp/chp_series.html', html);

console.log('has vimeus.com:', html.includes('vimeus.com'));
console.log('has view_key:', /view_key=([A-Za-z0-9_-]+)/.test(html));
console.log('has var tmdb:', /var\s+tmdb/.test(html));
console.log('has var tmdbRaw:', /var\s+tmdbRaw/.test(html));
console.log('has data-num:', html.includes('data-num'));
console.log('has mirrors:', html.includes('mirrors'));
console.log('has data-link:', html.includes('data-link'));

// dump all script-ish content around players
const vm = html.match(/vimeus[^"']{0,120}/g);
console.log('vimeus refs:', vm && vm.slice(0, 5));
const vk = html.match(/view_key=[A-Za-z0-9_-]+/g);
console.log('view_key vals:', vk && vk.slice(0, 3));
const tmb = html.match(/var\s+tmdb[^;]{0,80}/g);
console.log('tmdb vars:', tmb && tmb.slice(0, 5));

// iframe/embed hints
const ifr = [...html.matchAll(/<iframe[^>]+src="([^"]+)"/g)].map(m => m[1]);
console.log('iframes:', ifr.slice(0, 8));

// any player markup classes
const cls = [...new Set([...html.matchAll(/class="([^"]*(?:player|mirror|embed|option|server)[^"]*)"/gi)].map(m => m[1]))];
console.log('player-ish classes:', cls.slice(0, 15));
