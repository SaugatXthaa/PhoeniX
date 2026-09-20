// Task 65: dump movielinkbd series candidates + parsed episodes for GoT
const path = require('path');
const mod = require(path.join(process.cwd(), 'src/nuvio/movielinkbd.cjs'));

(async () => {
  const base = 'https://sb3c2t.movielinkbd.pw';
  const posts = await mod.searchContent('Game of Thrones', {}, {});
  console.log('search results:', posts.length);
  for (const p of posts) console.log('  -', p.title, '→', p.path.replace(base, ''));

  const ranked = mod.rankCandidates(posts, { title: 'Game of Thrones', originalTitle: 'Game of Thrones', year: 2011 });
  console.log('\nranked (top 8):');
  for (const r of ranked.slice(0, 8)) console.log('  *', r.title);

  // fetch each of the top 4 (PAGE_CAP) and dump parsed episodes
  for (const c of ranked.slice(0, 6)) {
    try {
      const html = await mod.fetchText ? null : null;
    } catch {}
  }
  // use internal parse via a small inline reimplementation of getStreams page fetch
  const tops = ranked.slice(0, 6);
  for (const c of tops) {
    try {
      const res = await fetch(c.path, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }, signal: AbortSignal.timeout(20000) });
      const html = await res.text();
      const parsed = mod.parseContentPage(html);
      const seasons = {};
      let total = 0;
      for (const ep of parsed.episodes) {
        const nums = ep.sources.map(s => {
          const m = s.name.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
          return m ? `S${m[1]}E${m[2]}` : (ep.number != null ? 'E' + ep.number : 'E?');
        });
        for (const n of nums) { seasons[n] = (seasons[n] || 0) + 1; total++; }
      }
      const keys = Object.keys(seasons).sort((a, b) => {
        const pa = a.match(/S(\d+)/), pb = b.match(/S(\d+)/);
        return (pa ? +pa[1] : 0) - (pb ? +pb[1] : 0);
      });
      console.log(`\n[${c.title}] status=${res.status} eps=${parsed.episodes.length} sources=${total}`);
      console.log('   season/ep span:', keys.slice(0, 12).join(' '), keys.length > 12 ? `...(${keys.length} keys)` : '');
    } catch (e) { console.log(`[${c.title}] fetch err: ${String(e).slice(0, 80)}`); }
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
