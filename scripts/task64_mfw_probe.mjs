// Task 64: reverse mfw09.org embed player
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const embedUrl = process.argv[2] || 'https://mfw09.org/e/gvg3ptu77cry?sub.info=https://qqqcdn.cloud/subtitles/fs/token/1g5uvpf.json';

const r = await fetch(embedUrl, { headers: { 'User-Agent': UA, 'Referer': 'https://player.zxcprime.xyz/' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
const html = await r.text();
console.log('status:', r.status, 'final:', r.url.slice(0, 100), 'len:', html.length);
console.log('--- head 600 ---');
console.log(html.slice(0, 600));
console.log('--- iframes/sources ---');
for (const m of html.matchAll(/(?:iframe[^>]*src|source[^>]*src|data-\w+)="([^"]+)"/g)) console.log('  attr:', m[1].slice(0, 120));
const media = [...html.matchAll(/https?:\/\/[^"'\s\\<>]+?\.(?:m3u8|mp4)(?:\?[^"'\s\\<>]*)?/gi)].map(m => m[0]);
console.log('media urls:', media.slice(0, 6));
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
console.log('scripts:', scripts.join('\n  '));
// look for inline player config
const cfg = html.match(/(?:sources?|file|src|hls)\s*[:=]\s*["'\[][^;]{0,300}/gi);
if (cfg) cfg.slice(0, 10).forEach(c => console.log('cfg:', c.slice(0, 200)));
// save full html
import { writeFileSync } from 'fs';
writeFileSync('/home/z/my-project/phoenix-analysis/scripts/task64/mfw_embed.html', html);
