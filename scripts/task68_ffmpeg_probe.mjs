// Task 68: ffmpeg (mpv libavformat truth) probe of the final zephyrix m3u8
// with delivery headers, retrying across rate-limit windows.
import { execFile } from 'child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PLAYER = 'https://play.zephyrix.org';

// fresh resolve via the provider
const { getStreams } = await import('../src/nuvio/animeworld.cjs');
const streams = await getStreams(810693, 'movie');
if (!streams.length) { console.log('no stream resolved'); process.exit(1); }
const s = streams[0];
console.log('resolved:', s.title, '\nurl:', s.url.slice(0, 100));

for (let i = 1; i <= 4; i++) {
  const out = await new Promise((resolve) => {
    const args = ['-headers', `Referer: ${PLAYER}/\r\nUser-Agent: ${UA}\r\n`, '-user_agent', UA, '-referer', PLAYER + '/',
      '-rw_timeout', '15000000', '-i', s.url, '-t', '4', '-f', 'null', '-'];
    execFile('ffmpeg', args, { timeout: 45000 }, (err, stdout, stderr) => {
      resolve({ err: err && err.message, stderr });
    });
  });
  const errText = out.stderr || '';
  const dur = (errText.match(/Duration: (\S+)/) || [])[1];
  const opened = (errText.match(/Opening '([^']+)' for reading/) || []).slice(-1)[0];
  const audioStreams = (errText.match(/Stream #\d+:\d+.*Audio: [^,]+/g) || []).length;
  const videoStreams = (errText.match(/Stream #\d+:\d+.*Video: [^,]+/g) || []).length;
  const err403 = /403|Forbidden/i.test(errText) && !/Duration/i.test(errText);
  console.log(`[attempt ${i}] 403-block=${err403} | duration=${dur || '-'} | video=${videoStreams} audio=${audioStreams}`);
  if (dur) {
    console.log('  first opened:', opened);
    console.log('  audio lines:', (errText.match(/Stream #\d+:\d+.*Audio: [^\n]*/g) || []).slice(0, 5).map(l => l.replace(/^.*Audio: /, 'Audio: ').slice(0, 60)));
  }
  if (dur && audioStreams >= 2) { console.log('PLAYABLE + MULTI-AUDIO CONFIRMED'); break; }
  if (i < 4) await new Promise(r => setTimeout(r, 5000));
}
