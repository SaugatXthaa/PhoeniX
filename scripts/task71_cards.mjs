// Task 71: dump ALL merged Dune cards — full badge + title + host per card
const BASE = 'https://ignatiusphoenix.onrender.com';
async function jget(path, timeoutMs = 120000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try { const res = await fetch(BASE + path, { signal: ac.signal }); return { status: res.status, json: await res.json().catch(() => null) }; }
  catch (e) { return { status: 0, error: e?.message }; }
  finally { clearTimeout(t); }
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return '(invalid)'; } };

const r = await jget('/stream/movie/tmdb:693134.json');
const streams = r.json?.streams || [];
console.log(`total cards: ${streams.length}\n`);
streams.forEach((s, i) => {
  const url = s.url || s.externalUrl || '';
  const isProxy = /\/proxy|\/range-proxy|\/reanime-proxy/.test(url);
  console.log(`${String(i + 1).padStart(2)} | ${s.name} | host=${isProxy ? '(self-proxy)' : hostOf(url)} | ext=${!!s.externalUrl}`);
  console.log(`     title: ${(s.title || '').replace(/\n/g, ' ⏎ ').slice(0, 150)}`);
});
