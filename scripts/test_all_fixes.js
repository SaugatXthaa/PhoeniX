// Verify Cinejoy still works + Source.js cache TTL for empty results
'use strict';

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

async function testCinejoyStillWorks() {
  console.log('\n========== CINEJOY still works on Supergirl 2026 ==========');
  const CINEJOY_PATH = path.join(__dirname, '..', 'src', 'nuvio', 'cinejoy_v2.cjs');
  delete require_.cache[require_.resolve(CINEJOY_PATH)];
  const mod = require_(CINEJOY_PATH);
  const Scraper = mod.CinejoyScraper;
  const scraper = new Scraper();

  const t0 = Date.now();
  try {
    const streams = await Promise.race([
      scraper.getMovieStreams('1081003', 'Lisbon'),
      new Promise(r => setTimeout(() => r({ __timeout: true }), 25000)),
    ]);
    const dt = Date.now() - t0;
    if (streams?.__timeout) {
      console.log(`  TIMEOUT after ${dt}ms`);
      return;
    }
    console.log(`  Cinejoy Lisbon: returned ${Array.isArray(streams) ? streams.length : 0} streams in ${dt}ms`);
    if (Array.isArray(streams)) for (const s of streams.slice(0, 3)) {
      console.log(`    -> ${s.quality} ${s.url?.slice(0, 80)}`);
    }
    if (streams && streams.length > 0) {
      console.log('  ✅ PASS: Cinejoy still works after fixes');
    } else {
      console.log('  ❌ FAIL: Cinejoy no longer returns streams');
    }
  } catch (e) {
    console.error(`  ERROR:`, e?.message || e);
  }
}

async function testZinkMoviesFastFail() {
  console.log('\n========== ZINKMOVIES fails fast (under 10s) when rate-limited ==========');
  const ZINK_PATH = path.join(__dirname, '..', 'src', 'nuvio', 'zinkmovies_v2.cjs');
  delete require_.cache[require_.resolve(ZINK_PATH)];
  const mod = require_(ZINK_PATH);
  const Scraper = mod.ZinkMoviesScraper;
  const scraper = new Scraper(15000);

  const t0 = Date.now();
  try {
    const streams = await scraper.getMovieStreams('1081003');
    const dt = Date.now() - t0;
    console.log(`  ZinkMovies: returned ${streams?.length || 0} streams in ${dt}ms`);
    if (dt < 10000) {
      console.log(`  ✅ PASS: ZinkMovies failed fast in ${dt}ms (was 96s+ before)`);
    } else {
      console.log(`  ⚠️  ZinkMovies took ${dt}ms — slower than expected`);
    }
  } catch (e) {
    const dt = Date.now() - t0;
    console.error(`  ERROR after ${dt}ms:`, e?.message || e);
    if (dt < 10000) {
      console.log(`  ✅ PASS: ZinkMovies failed fast in ${dt}ms (was 96s+ before)`);
    } else {
      console.log(`  ⚠️  ZinkMovies took ${dt}ms to fail — slower than expected`);
    }
  }
}

async function testSourceCacheTtl() {
  console.log('\n========== Source.js cache TTL for empty results ==========');
  const { Source } = await import('../src/source/Source.js');

  // Build a fake Source that returns [] on first call, real data on second
  class FakeSource extends Source {
    constructor() {
      super();
      this.id = 'fake';
      this.label = 'Fake';
      this.ttl = 5 * 60 * 1000; // 5 minutes — the previous default
      this.callCount = 0;
    }
    async handleInternal() {
      this.callCount++;
      // First call: simulate a transient failure (empty result)
      // Second call: return a real stream
      if (this.callCount === 1) return [];
      return [{ url: new URL('https://example.com/stream.m3u8'), meta: { title: 'real stream' } }];
    }
  }

  const fake = new FakeSource();
  const ctx = { hostUrl: new URL('https://example.com') };
  const id = { id: 12345 };

  // First call: returns [] (empty), should be cached with SHORT ttl (60s)
  const r1 = await fake.handle(ctx, 'movie', id);
  console.log(`  Call 1: returned ${r1.length} streams (callCount=${fake.callCount})`);

  // Wait 100ms — within 60s empty-TTL window
  await new Promise(r => setTimeout(r, 100));

  // Second call: should still return cached [] (within 60s window)
  const r2 = await fake.handle(ctx, 'movie', id);
  console.log(`  Call 2 (after 100ms): returned ${r2.length} streams (callCount=${fake.callCount})`);
  if (fake.callCount === 1) {
    console.log('  ✅ Empty result was cached (callCount did not increment)');
  } else {
    console.log('  ❌ Empty result was NOT cached');
  }

  // Wait 61s — past the 60s empty-TTL, should trigger re-fetch and return real stream
  console.log('  Waiting 61s to verify cache expiry...');
  const start = Date.now();
  await new Promise(r => setTimeout(r, 61000));
  const r3 = await fake.handle(ctx, 'movie', id);
  console.log(`  Call 3 (after ${(Date.now()-start)/1000}s): returned ${r3.length} streams (callCount=${fake.callCount})`);
  if (fake.callCount === 2 && r3.length === 1) {
    console.log('  ✅ PASS: Empty cache expired after ~60s and re-fetched real data');
  } else {
    console.log(`  ❌ FAIL: callCount=${fake.callCount}, r3.length=${r3.length}`);
  }
}

(async () => {
  await testCinejoyStillWorks().catch(e => console.error('uncaught:', e));
  await testZinkMoviesFastFail().catch(e => console.error('uncaught:', e));
  await testSourceCacheTtl().catch(e => console.error('uncaught:', e));
  console.log('\n========== DONE ==========');
  process.exit(0);
})();
