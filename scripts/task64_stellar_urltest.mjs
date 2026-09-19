// Task 64: test whether /api/playback-unavailable/<hash>/master.m3u8 is now the REAL stream path
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://stellar.rip';

const candidates = [
  '/api/playback-unavailable/mLRWR4WZjd60vZbEFPgh1W8n/master.m3u8',
  '/api/playback-unavailable/QeHF200JDK1izRLOVctOxXrD/master.m3u8',
];

for (const p of candidates) {
  for (const hdrVariant of ['full', 'minimal', 'noreferer']) {
    const headers = { 'User-Agent': UA };
    if (hdrVariant !== 'noreferer') { headers['Referer'] = BASE + '/en/watch/embed/movie/27205'; headers['Origin'] = BASE; }
    try {
      const res = await fetch(BASE + p, { headers, signal: AbortSignal.timeout(12000) });
      const ct = res.headers.get('content-type');
      const text = await res.text();
      console.log(`${p.slice(28, 60)} [${hdrVariant}] -> ${res.status} ${ct} len=${text.length}`);
      console.log('  first 200:', text.slice(0, 200).replace(/\n/g, ' | '));
      if (res.status === 200 && text.startsWith('#EXTM3U')) {
        // count variants
        const variants = [...text.matchAll(/RESOLUTION=(\d+)x(\d+)/g)].map(m => m[0]);
        console.log('  VARIANTS:', variants.join(', '));
      }
    } catch (e) {
      console.log(`${p} [${hdrVariant}] -> ERR ${e.message}`);
    }
  }
}
