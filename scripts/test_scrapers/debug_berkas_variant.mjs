// Test Berkas variant URL playback
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// Variant URL from the master m3u8
const variantUrl = 'https://zxcstream.berkas38.workers.dev/?data=4d6JdW4Wgw7s4l3jI_jFiIn6B6qtYUG5Q2fC-JJRxW28_v0ym7YeqWMNfMEMayWrHX_dLs8hBJjXMwCU24sFXMDQ9cZMm5Y4__xp3XYSGMSCRjhrnJmowzDygHhsg-Y_JZQfeDuuXgAxD_zROLCiP0PviFsKaM84J0G0oZmBO2odvEqF8igjbM_T1b5S7DR9jjqtwyzfRbMYz3GpffjjU0gfyBxl7rXHC5stXvzh9qYchfVfN_IBv4wyahShkbbNakd9I4CW5Q39568JmWFH7kiVBbo1l9YHtiOt-84Xb52ktBEyPRDD3hwDdUZtsumD4Fjc8uY2RpH6Y7FivMVo8sZJxzoxG137wva2Zdc1tiFrECdvlP5PECHp8DzNkzSxWIqM6HHbWXUjVqGBNRDj6iT96lXUs8NVh9fGncHV2W8Q8693endpZy9rZ0bRvq_u4SaP695W2Tn5L_XPNH_tQf8jjXzbLepYgLYbCXHBZ7_d9WNyY0i9sGzFScyI44HgbONvZ-By4dlzImrCe86KUiVwmPA-KYLeE6rZBNrBp6t5PlZHVsp7pt1UCu6IgJ1-y-GcUALqJAYhfoXrzQf4Q7QvVtOGQXPKicPTtm9Sj3rFcwer3WfxP7O4kxO0rqjwdQM47TsS4ybimCtToaZc4Xk';

console.log('=== Test variant URL ===');
console.log(`Host: ${new URL(variantUrl).hostname}`);

try {
  const r = await gotScraping.get(variantUrl, {
    headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
    timeout: { request: 20000 }, throwHttpErrors: false, http2: true, followRedirect: true,
  });
  console.log(`Status: ${r.statusCode} | CT: ${r.headers['content-type']} | Body len: ${r.body?.length || 0}`);
  if (r.statusCode === 200) {
    console.log(`First 500 chars:\n${r.body.slice(0, 500)}`);
    // Check if it's an HLS playlist with segments
    if (r.body.startsWith('#EXTM3U')) {
      const lines = r.body.split('\n').filter(l => l.trim() && !l.startsWith('#'));
      console.log(`\nSegment/variant URLs: ${lines.length}`);
      for (const l of lines.slice(0, 3)) {
        console.log(`  ${l.slice(0, 100)}`);
      }
    }
  } else if (r.statusCode >= 400) {
    console.log(`Body: ${r.body?.slice(0, 300)}`);
  }
} catch (e) {
  console.log(`ERR: ${e.message}`);
}
