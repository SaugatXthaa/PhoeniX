// Clean bounded Playwright RE of the naukriadda chain
import { chromium } from 'playwright';

const sidUrl = process.env.SID_URL;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
const page = await ctx.newPage();

const reqLog = [];
page.on('request', r => { if (r.url().includes('thenaukriadda')) reqLog.push(['>', r.method(), r.url().slice(0, 110)]); });
page.on('response', async r => {
  if (r.url().includes('thenaukriadda')) {
    reqLog.push(['<', r.status(), r.url().slice(0, 110)]);
  }
});

console.log('goto', sidUrl.slice(0, 90));
await page.goto(sidUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2500);
console.log('url now:', page.url().slice(0, 110));

// generate button (starts timer)
try { await page.click('#lp-btn-generate', { timeout: 3000 }); console.log('clicked generate'); } catch { console.log('no generate btn'); }
await page.waitForTimeout(11500); // honor 10s timer
try { await page.click('#lp-btn-continue', { timeout: 3000 }); console.log('clicked continue'); } catch { console.log('no continue btn'); }
await page.waitForTimeout(1500);
// the go button is an <a> with href set — click it
try { await page.click('#lp-btn-go', { timeout: 3000 }); console.log('clicked go'); } catch { console.log('no go btn'); }
try { await page.waitForLoadState('domcontentloaded', { timeout: 20000 }); } catch { }
await page.waitForTimeout(4000);
console.log('after go:', page.url().slice(0, 130));

// if we're on another timer page, repeat once
try { await page.click('#lp-btn-generate', { timeout: 2000 }); await page.waitForTimeout(11500); await page.click('#lp-btn-continue', { timeout: 2000 }); await page.waitForTimeout(1000); await page.click('#lp-btn-go', { timeout: 2000 }); await page.waitForLoadState('domcontentloaded', { timeout: 20000 }); await page.waitForTimeout(3000); console.log('round2 url:', page.url().slice(0, 130)); } catch (e) { console.log('round2 n/a'); }

console.log('FINAL:', page.url().slice(0, 150));
const html = await page.content();
const ext = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]).filter(u => !/thenaukriadda|w3\.org|wp\.|schema|yoast|s\.w\.org|googleapis|gstatic|github|gravatar|emoji|api\.w\.org|vidverto/.test(u));
console.log('external links:', [...new Set(ext)].slice(0, 10));
console.log('--- REQUEST LOG ---');
reqLog.forEach(l => console.log(l.join(' ')));
await browser.close();
