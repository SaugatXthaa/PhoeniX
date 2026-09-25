// Validate the &go= 302 step of resolveGenerateToken in isolation (node, native fetch manual redirect)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ID = 'v2nR5TEd7BKsl-LthitvAUkabqrDwuG8Y5HHJxm9Da42dgK2ftg6VGQFkc-47ZGmMSUtLT7eGcaV0hmCfjD03VJyEF';
const GO = '1790326548.40c357e40b1f91932aa6044db733e71e';
const finalUrl = `https://cinefreak.net/generate.php?id=${ID}&go=${GO}`;
try {
  const res = await fetch(finalUrl, {
    redirect: 'manual',
    headers: { 'User-Agent': UA, Referer: 'https://cinefreak.net/' },
    signal: AbortSignal.timeout(12000),
  });
  const location = res.headers.get('location') || '';
  console.log(`native fetch: ${res.status} location=${location}`);
  const m = location.match(/cinecloud\.site\/f\/([a-z0-9]+)/i);
  console.log('fileid extracted:', m ? m[1] : 'NONE');
} catch (e) { console.log('FAIL:', e.message); }
