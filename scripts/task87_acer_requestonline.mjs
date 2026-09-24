// Task 87: extract requestOnline + sourceEpisodes call shapes from acermovies.fun inline JS
import fs from 'fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const r = await fetch('https://acermovies.fun/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
const html = await r.text();
fs.writeFileSync('/home/z/my-project/scripts/task87_acer_home.html', html);
console.log('homepage len:', html.length, 'status:', r.status);

// find every occurrence of requestOnline with generous context
for (const m of html.matchAll(/requestOnline/g)) {
  const i = m.index;
  console.log('\n===== requestOnline @', i, '=====');
  console.log(html.slice(Math.max(0, i - 700), i + 700).replace(/\n{2,}/g, '\n'));
}

// also sourceEpisodes context (series path)
const eps = [...html.matchAll(/sourceEpisodes/g)].map(m => m.index);
console.log('\n\nsourceEpisodes occurrences:', eps.length);
for (const i of eps.slice(0, 3)) {
  console.log('\n===== sourceEpisodes @', i, '=====');
  console.log(html.slice(Math.max(0, i - 500), i + 500).replace(/\n{2,}/g, '\n'));
}
