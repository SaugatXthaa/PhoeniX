// Definitive Playwright RE of naukriadda chain with REAL button flow
import { chromium } from 'playwright';

const sidUrl = process.env.SID_URL;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
const page = await ctx.newPage();

const keyReqs = [];
page.on('request', r => {
  const u = r.url();
  if (/thenaukriadda\.in\/\?|thenaukriadda\.in\/(?!wp-|wp-|cdn-cgi)/.test(u) && !/wp-|kadence|uploads|cdn-cgi|emoji|vidverto/.test(u)) {
    keyReqs.push({ dir: '>', method: r.method(), url: u.slice(0, 130), headers: r.headers() });
  }
});
page.on('response', r => {
  const u = r.url();
  if (/thenaukriadda\.in\/\?|thenaukriadda\.in\/(?!wp-|cdn-cgi)/.test(u) && !/wp-|kadence|uploads|cdn-cgi|emoji|vidverto/.test(u)) {
    keyReqs.push({ dir: '<', status: r.status(), url: u.slice(0, 130) });
  }
});

console.log('L0 goto');
await page.goto(sidUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
// auto-submit happens; wait for stage1 timer (6s)
await page.waitForTimeout(7500);
console.log('L1 url:', page.url().slice(0, 100));
// click "Click here to continue" (lp-s1-form submit)
try {
  await page.click('#lp-s1-form button', { timeout: 5000 });
  console.log('L2 clicked continue (s1)');
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
} catch (e) { console.log('L2 fail:', e.message.slice(0, 60)); }
await page.waitForTimeout(2500);
console.log('L3 url:', page.url().slice(0, 100));
// generate button (starts 10s timer)
try { await page.click('#lp-btn-generate', { timeout: 4000 }); console.log('L4 clicked generate'); } catch (e) { console.log('L4 fail:', e.message.slice(0, 60)); }
await page.waitForTimeout(11500);
try { await page.click('#lp-btn-continue', { timeout: 4000 }); console.log('L5 clicked continue'); } catch (e) { console.log('L5 fail:', e.message.slice(0, 60)); }
await page.waitForTimeout(1200);
try { await page.click('#lp-btn-go', { timeout: 4000 }); console.log('L6 clicked go'); } catch (e) { console.log('L6 fail:', e.message.slice(0, 60)); }
try { await page.waitForLoadState('domcontentloaded', { timeout: 25000 }); } catch { }
await page.waitForTimeout(5000);
console.log('FINAL URL:', page.url().slice(0, 150));
const html = await page.content();
const ext = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]).filter(u => !/thenaukriadda|w3\.org|wp\.|schema|yoast|s\.w\.org|googleapis|gstatic|github|gravatar|emoji|api\.w\.org|vidverto/.test(u));
console.log('EXTERNAL:', [...new Set(ext)].slice(0, 10));
const txt = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
console.log('TEXT:', txt.slice(0, 300));
console.log('--- KEY REQS ---');
for (const r of keyReqs) {
  if (r.dir === '>') console.log('>', r.method, r.url, '| ck:', (r.headers.cookie || '').slice(0, 130), '| ref:', (r.headers.referer || '').slice(0, 60));
  else console.log('<', r.status, r.url);
}
await browser.close();
