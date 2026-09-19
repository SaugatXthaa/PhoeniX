// Task 64: kmphotos download99 signed-link verification
import https from 'https';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function get(url, { depth = 0, range } = {}) {
  return new Promise(resolve => {
    const headers = { 'User-Agent': UA };
    if (range) headers['Range'] = range;
    https.get(url, { headers, rejectUnauthorized: false, timeout: 20000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), { depth: depth + 1, range }));
      }
      let n = 0; let head = null; let body = '';
      const wantBody = !range;
      res.on('data', c => {
        if (wantBody) body += c;
        if (!head) head = c.slice(0, 12);
        n += c.length;
        if (n > (wantBody ? 200000 : 4096)) res.destroy();
      });
      const finish = () => resolve({ status: res.statusCode, ct: res.headers['content-type'], cr: res.headers['content-range'], head: head ? [...head] : null, body });
      res.on('end', finish);
      res.on('close', finish);
    }).on('error', e => resolve({ err: e.message }));
  });
}

const base = 'https://z1.kmphotos.cv/download99.php?file=Inception.2010.BluRay.1080p.10bit.HQ.Dual.Audio.Hindi.English.x264.MSubs.KMMOVIES.COM.mkv';
const page = await get(base);
console.log('page:', page.status, page.ct, 'len', page.body.length);
const links = [...page.body.matchAll(/href="(\?file=[^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
console.log('links:', links.length);
for (const l of links) {
  const url = 'https://z1.kmphotos.cv/download99.php' + l;
  const r = await get(url, { range: 'bytes=0-4095' });
  const label = l.match(/dl=(\w+)/)?.[1] || 'unknown';
  console.log(`[${label}] status=${r.status} ct=${r.ct} cr=${r.cr || 'n/a'} head=${JSON.stringify(r.head)}`);
}
