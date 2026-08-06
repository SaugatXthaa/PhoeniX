import { unpack } from 'unpacker';
import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('/tmp/flare_test.json', 'utf8'));
const body = data.solution.response;

const packedMatch = body.match(/eval\(function\(p,a,c,k,e,d\).*?\)\)/s);
if (packedMatch) {
  const unpacked = unpack(packedMatch[0]);
  console.log('Unpacked length:', unpacked.length);
  const sources = unpacked.match(/sources:\s*\[\s*\{[^}]*file:\s*["']([^"']+)["']/i);
  console.log('Sources:', sources?.[1]?.substring(0, 80) || 'NONE');
  const m3u8 = unpacked.match(/(https?:\/\/[^"'\s]*\.m3u8[^"'\s]*)/i);
  console.log('M3U8:', m3u8?.[1]?.substring(0, 80) || 'NONE');
  // Show first 500 chars of unpacked
  console.log('First 500:', unpacked.substring(0, 500));
} else {
  console.log('No packed JS found');
}
