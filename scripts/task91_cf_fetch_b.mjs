const { fetchWithCurl, curlArgsFor } = await import('/home/z/my-project/ignatiusphoenix/src/utils/cf-fetch.cjs');
import { execFileSync } from 'child_process';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ID = 'v2nR5TEd7BKsl-LthitvAUkabqrDwuG8Y5HHJxm9Da42dgK2ftg6VGQFkc-47ZGmMSUtLT7eGcaV0hmCfjD03VJyEF';
const url = `https://cinefreak.net/generate.php?id=${ID}`;

// a) fetchWithCurl (module)
try {
  const buf = await fetchWithCurl(url, { maxTimeSec: 12, userAgent: UA });
  const body = buf ? buf.toString('utf8') : '';
  console.log(`fetchWithCurl: ${body.length}B hasGo=${/\bgo=(\d{9,12}\.[0-9a-fA-F]{8,40})/.test(body)} head=${body.slice(0, 60).replace(/\n/g, ' ')}`);
} catch (e) { console.log('fetchWithCurl FAIL:', e.message); }

// b) raw curl via execFileSync (same as bash)
try {
  const out = execFileSync('curl', ['-s', '-A', UA, url, '--max-time', '12'], { maxBuffer: 20 * 1024 * 1024 });
  const body = out.toString('utf8');
  console.log(`execFileSync curl: ${body.length}B hasGo=${/\bgo=(\d{9,12}\.[0-9a-fA-F]{8,40})/.test(body)}`);
} catch (e) { console.log('execFileSync FAIL:', e.message); }

// c) print the args the module builds
console.log('curlArgsFor:', JSON.stringify(curlArgsFor(url, { userAgent: UA })));
