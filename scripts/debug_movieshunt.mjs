// Debug movieshunt searchSite function
const gs = await import('got-scraping').then(m => m.gotScraping || m.default || m.got).catch(() => null);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const title = 'Dune: Part Two';
const url = 'https://movieshunt.casa/?s=' + encodeURIComponent(title);
console.log('URL:', url);
console.log('got-scraping available:', !!gs);

// Method 1: got-scraping
if (gs) {
  console.log('\n=== Method 1: got-scraping ===');
  try {
    const t0 = Date.now();
    const res = await gs({ url, headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' }, timeout: { request: 15000 }, retry: { limit: 1 } });
    console.log(`Status: ${res.statusCode} in ${Date.now() - t0}ms, body length: ${res.body.length}`);
    // Try the regex
    const links = [...res.body.matchAll(/href="(https:\/\/movieshunt\.casa\/([a-z0-9-]+)\/)"/g)];
    console.log(`Regex matches: ${links.length}`);
    links.slice(0, 5).forEach((m, i) => console.log(`  ${i+1}. slug=${m[2]}`));
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }
}

// Method 2: native fetch
console.log('\n=== Method 2: native fetch ===');
try {
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  const body = await res.text();
  console.log(`Status: ${res.status} in ${Date.now() - t0}ms, body length: ${body.length}`);
  const links = [...body.matchAll(/href="(https:\/\/movieshunt\.casa\/([a-z0-9-]+)\/)"/g)];
  console.log(`Regex matches: ${links.length}`);
  links.slice(0, 5).forEach((m, i) => console.log(`  ${i+1}. slug=${m[2]}`));
} catch (e) {
  console.log(`Error: ${e.message}`);
}

// Method 3: Check what the actual HTML looks like
console.log('\n=== Method 3: Inspect raw HTML ===');
try {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  const body = await res.text();
  // Find all movieshunt.casa links
  const allLinks = [...body.matchAll(/href="(https:\/\/movieshunt\.casa[^"]*)"/g)];
  console.log(`All movieshunt.casa links: ${allLinks.length}`);
  allLinks.slice(0, 10).forEach((m, i) => console.log(`  ${i+1}. ${m[1]}`));
} catch (e) {
  console.log(`Error: ${e.message}`);
}
