// Check if AniLibria has other API versions or if the HLS stream has alternate audio
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// 1. Check the TS segment — maybe it has multiple audio PIDs (MPEG-TS can carry multiple audio tracks)
const tsUrl = 'https://cache.libria.fun/videos/media/ts/8789/1/1080/fff0.ts';
console.log('=== Fetch first TS segment ===');
const r = await gotScraping.get(tsUrl, {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
  timeout: { request: 15000 }, throwHttpErrors: false, http2: true,
  responseType: 'buffer',
});
console.log(`Status: ${r.statusCode} | CT: ${r.headers['content-type']} | CL: ${r.headers['content-length']}`);
if (Buffer.isBuffer(r.body)) {
  // Check for multiple audio PIDs in MPEG-TS
  // Each TS packet is 188 bytes, starts with 0x47
  // Audio PIDs are in PMT (Program Map Table)
  // Look for audio stream descriptors
  const buf = r.body;
  console.log(`Segment size: ${buf.length} bytes`);
  console.log(`First byte: 0x${buf[0].toString(16)} (should be 0x47 for MPEG-TS)`);

  // Count PAT/PMT packets to understand stream structure
  let patCount = 0, pmtCount = 0, audioPids = new Set(), videoPids = new Set();
  for (let i = 0; i < buf.length; i += 188) {
    if (buf[i] !== 0x47) continue;
    const pid = ((buf[i+1] & 0x1F) << 8) | buf[i+2];
    if (pid === 0) patCount++; // PAT
    // We'd need to parse PAT→PMT→PIDs properly, but let's just count unique PIDs
    if (pid > 0 && pid < 0x1FFF) {
      const payloadUnitStart = (buf[i+1] & 0x40) !== 0;
      if (payloadUnitStart) {
        // Check adaptation field control
        const afc = (buf[i+3] >> 4) & 0x03;
        let offset = 4;
        if (afc === 2 || afc === 3) {
          const afLen = buf[i+4];
          offset = 5 + afLen;
        }
        if (afc === 1 || afc === 3) {
          // Check stream type in PMT
          // This is simplified — just look for audio stream types
          if (offset < 188 && buf[i+offset] === 0x00 && buf[i+offset+1] === 0x02) {
            // PMT
            pmtCount++;
            // Parse PMT for audio streams
            const sectionLen = ((buf[i+offset+2] & 0x0F) << 8) | buf[i+offset+3];
            let pmtOffset = offset + 8; // skip table header
            const endOffset = offset + 3 + sectionLen - 4; // -4 for CRC
            while (pmtOffset < endOffset && pmtOffset < 188) {
              const streamType = buf[i+pmtOffset];
              const esPid = ((buf[i+pmtOffset+1] & 0x1F) << 8) | buf[i+pmtOffset+2];
              const esInfoLen = ((buf[i+pmtOffset+3] & 0x0F) << 8) | buf[i+pmtOffset+4];
              // Audio stream types: 0x03/0x04 (MPEG), 0x0F (AAC), 0x11 (AAC LATM)
              if ([0x03, 0x04, 0x0F, 0x11, 0x81].includes(streamType)) {
                audioPids.add(esPid);
              }
              if ([0x01, 0x02, 0x10, 0x1B, 0x24, 0x25, 0x27].includes(streamType)) {
                videoPids.add(esPid);
              }
              pmtOffset += 5 + esInfoLen;
            }
          }
        }
      }
    }
  }
  console.log(`PAT packets: ${patCount}`);
  console.log(`PMT packets: ${pmtCount}`);
  console.log(`Audio PIDs found: ${audioPids.size} → ${[...audioPids].map(p => '0x'+p.toString(16)).join(', ')}`);
  console.log(`Video PIDs found: ${videoPids.size} → ${[...videoPids].map(p => '0x'+p.toString(16)).join(', ')}`);
}

// 2. Check the API for other versions
console.log('\n=== Check API v2 ===');
const v2Res = await gotScraping.get('https://anilibria.top/api/v2/anime/releases/jujutsu-kaisen', {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
  timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
});
console.log(`v2 status: ${v2Res.statusCode} | body: ${v2Res.body?.slice(0, 200)}`);

// 3. Check the old anilibria.tv API (might still work for some endpoints)
console.log('\n=== Check old anilibria.tv API ===');
const oldRes = await gotScraping.get('https://api.anilibria.tv/v2/getRelease?code=jujutsu-kaisen', {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
  timeout: { request: 10000 }, throwHttpErrors: false, http2: true, followRedirect: true,
});
console.log(`Old API status: ${oldRes.statusCode} | body: ${oldRes.body?.slice(0, 200)}`);

// 4. Check if there's a separate "fandub" or "voice" endpoint
console.log('\n=== Check /anime/releases/{alias}/fandub ===');
const fandubRes = await gotScraping.get('https://anilibria.top/api/v1/anime/releases/jujutsu-kaisen/fandub', {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
  timeout: { request: 10000 }, throwHttpErrors: false, http2: true,
});
console.log(`Fandub status: ${fandubRes.statusCode} | body: ${fandubRes.body?.slice(0, 300)}`);
