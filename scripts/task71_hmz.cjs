// Task 71: replay hindmoviez chain from sandbox → get final workers.dev URL → probe 401 class
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
(async () => {
  // Step 1: the f.php URL from the production log
  const fphp = 'https://hshare.ink/?id=Dune.Part.Two.2024.1080p.10Bit.WEB-DL.Hindi.English.Msubs..mkv';
  console.log('step1 GET', fphp);
  const r1 = await fetch(fphp, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  const b1 = await r1.text();
  console.log(`  → ${r1.status}, ${b1.length} bytes, final URL: ${r1.url.slice(0, 90)}`);
  // look for the direct link / next hop in the page
  const links = [...b1.matchAll(/https?:\/\/[a-z0-9.-]+\.workers\.dev[^"'\s<>]*/gi)].map(m => m[0]);
  console.log('  workers.dev links found:', [...new Set(links)].slice(0, 3));
  const hcloud = [...b1.matchAll(/https?:\/\/hcloud\.ink[^"'\s<>]*/gi)].map(m => m[0]);
  console.log('  hcloud links:', [...new Set(hcloud)].slice(0, 2));
  let target = [...new Set(links)][0];
  if (!target && hcloud.length) {
    console.log('step2 GET hcloud redirect page:', hcloud[0].slice(0, 90));
    const r2 = await fetch(hcloud[0], { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const b2 = await r2.text();
    console.log(`  → ${r2.status}, ${b2.length} bytes, final: ${r2.url.slice(0, 90)}`);
    const links2 = [...b2.matchAll(/https?:\/\/[a-z0-9.-]+\.workers\.dev[^"'\s<>]*/gi)].map(m => m[0]);
    console.log('  workers.dev links:', [...new Set(links2)].slice(0, 3));
    target = [...new Set(links2)][0];
    if (!target) {
      // maybe the page constructs the download via JS — dump a snippet
      console.log('  page snippet:', b2.slice(0, 400).replace(/\n/g, ' '));
    }
  }
  if (target) {
    console.log('\nPROBE final URL:', target.slice(0, 100));
    const r3 = await fetch(target, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    console.log(`  sandbox probe → ${r3.status} ct=${r3.headers.get('content-type')} cd=${(r3.headers.get('content-disposition') || '').slice(0, 60)}`);
    try { await r3.body.cancel(); } catch {}
    // headerless
    const r4 = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    console.log(`  sandbox headerless → ${r4.status}`);
    try { await r4.body.cancel(); } catch {}
  } else {
    console.log('no final URL resolved from sandbox');
  }
})();
