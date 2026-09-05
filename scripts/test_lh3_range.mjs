// Get lh3 URL and test Range support
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.NODE_PATH = path.resolve('/home/z/my-project/src');

const { MoviesDriveV2 } = await import('/home/z/my-project/src/source/MoviesDriveV2.js');
const { Fetcher } = await import('/home/z/my-project/src/utils/Fetcher.js');
const { TmdbId } = await import('/home/z/my-project/src/utils/id.js');

const fetcher = new Fetcher();
const source = new MoviesDriveV2(fetcher);
source.ttl = 0;
const parsedId = TmdbId.fromString('27205');
const ctx = { type: 'movie', id: 'tmdb:27205', hostUrl: 'http://localhost:11470' };
const results = await source.handleInternal(ctx, 'movie', parsedId);

let lh3Url = null;
for (const r of results) {
  if (r.url.hostname.includes('googleusercontent')) {
    lh3Url = r.url.href;
    break;
  }
}

if (!lh3Url) {
  console.log('No googleusercontent URL found');
  process.exit(1);
}

console.log('URL:', lh3Url.slice(0, 150));
console.log('');

// Test Range support
console.log('=== Without Range ===');
const out1 = execSync(`curl -sI -A "Mozilla/5.0 Chrome/131" "${lh3Url}" --max-time 10`, { encoding: 'utf-8' });
console.log(out1.split('\n').slice(0, 12).join('\n'));

console.log('=== With Range: bytes=0-1024 ===');
const out2 = execSync(`curl -sI -A "Mozilla/5.0 Chrome/131" -H "Range: bytes=0-1024" "${lh3Url}" --max-time 10`, { encoding: 'utf-8' });
console.log(out2.split('\n').slice(0, 12).join('\n'));

console.log('=== With Range: bytes=1048576-2097152 ===');
const out3 = execSync(`curl -sI -A "Mozilla/5.0 Chrome/131" -H "Range: bytes=1048576-2097152" "${lh3Url}" --max-time 10`, { encoding: 'utf-8' });
console.log(out3.split('\n').slice(0, 12).join('\n'));
