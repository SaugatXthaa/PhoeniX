// src/source/hd-hub-helper.js
// Ported from research/webstreamr-mbg/src/source/hd-hub-helper.ts and RedirectDecoder.ts

import rot13Cipher from 'rot13-cipher';

const WP_HTTP_MAX_RETRIES = 5;
const WP_HTTP_RETRY_DELAY_MS = 2000;
// Cap total_time wait to prevent malformed pages from causing 30s+ hangs
const MAX_TOTAL_TIME_SECONDS = 10;

// Encrypted payload extraction patterns from redirect pages
const EXTRACTION_PATTERNS = [
  /s\(\s*['"]o['"]\s*,\s*['"]([^'"]+)['']/, // s('o','...')
  /ck\(\s*['"]_wp_http_\d+['"]\s*,\s*['"]([^'"]+)['']/, // ck('_wp_http_N','...')
  /localStorage\.setItem\(\s*['"]o['"]\s*,\s*['"]([^'"]+)['']/, // localStorage variant
  /['"]o['"]\s*[:=]\s*['"]([A-Za-z0-9+/=]{40,})['']/, // generic key-value ≥40 chars
];

// Last-resort: any long base64-ish string (payloads tend to be near the bottom of the page)
const LONG_B64_RE = /[A-Za-z0-9+/=]{120,}/g;

const VAR_REURL_RE = /var\s+reurl\s*=\s*["']([^"']+)["']/;

// Hub* URL pattern for fallback link extraction
const HUB_URL_RE = /(https?:\/\/[^\s"'<>]*(?:hubcloud|hubdrive|hubcdn)[^\s"'<>]*)/gi;

// Extract encrypted payload from redirect page HTML
export function extractEncryptedString(html) {
  for (const pattern of EXTRACTION_PATTERNS) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }

  // Last-resort: longest base64-ish string (last match wins — payloads appear near page bottom)
  const matches = [...html.matchAll(LONG_B64_RE)];
  const last = matches[matches.length - 1];
  return last?.[0] ?? null;
}

// Try multiple decode chains — site may have removed/added encoding layers
export function decodeString(encoded) {
  // Chain 1: b64→b64→rot13→b64→JSON (standard format)
  try {
    return JSON.parse(atob(rot13Cipher(atob(atob(encoded)))));
  } catch { /* next */ }

  // Chain 2: b64→b64→JSON (rot13 layer removed by site)
  try {
    return JSON.parse(atob(atob(encoded)));
  } catch { /* next */ }

  // Chain 3: b64→b64→b64→JSON (extra encoding layer added by site)
  try {
    return JSON.parse(atob(atob(atob(encoded))));
  } catch { /* next */ }
  return null;
}

// Last-resort URL scan — may false-positive on nav/ads; blast radius = wasted extraction attempt
export function extractFallbackLink(html) {
  const reurlMatch = html.match(VAR_REURL_RE);
  if (reurlMatch?.[1]) return reurlMatch[1];

  const matches = [...html.matchAll(HUB_URL_RE)];
  const last = matches[matches.length - 1];
  return last?.[1] ?? null;
}

export const resolveRedirectUrl = async (ctx, fetcher, redirectUrl) => {
  const html = await fetcher.text(ctx, redirectUrl);

  // Layer 1: encrypted payload extraction + multi-chain decode
  const encrypted = extractEncryptedString(html);
  if (encrypted) {
    const decoded = decodeString(encrypted);
    if (decoded) {
      // Primary: use 'o' field (base64-encoded URL)
      const o = (decoded.o ?? '').trim();
      if (o) return new URL(atob(o));

      const data = (decoded.data ?? '').trim();

      // Fallback 1: blog_url + data raw (NOT base64-encoded — intentional asymmetry with wp_http1)
      const blogUrl = (decoded.blog_url ?? '').trim();
      if (blogUrl && data) {
        const result = await fetcher.text(ctx, new URL(`${blogUrl}?re=${data}`));
        return new URL(result.trim());
      }

      // Fallback 2: wp_http1 + data base64-encoded + total_time wait
      const wpHttp1 = (decoded.wp_http1 ?? '').trim();
      if (wpHttp1 && data) {
        return resolveViaWpHttp(ctx, fetcher, wpHttp1, data, decoded.total_time);
      }
    }
  }

  // Layer 2: last-resort URL scan from raw HTML (may false-positive on nav/ads)
  const fallbackUrl = extractFallbackLink(html);
  if (fallbackUrl) return new URL(fallbackUrl);

  throw new Error(`[hd-hub-helper] No usable URL found from: ${redirectUrl.href}`);
};

// wp_http1 resolution with server-enforced wait + retry on "Invalid Request"
const resolveViaWpHttp = async (ctx, fetcher, wpHttp1, data, totalTime) => {
  const cappedTotalTime = Math.min(Number(totalTime) || 0, MAX_TOTAL_TIME_SECONDS);
  const waitMs = (cappedTotalTime + 3) * 1000;
  await new Promise(resolve => setTimeout(resolve, waitMs));

  // wp_http1 sends data as base64 (intentional asymmetry with blog_url which sends raw)
  const token = btoa(data);
  const retryUrl = new URL(`${wpHttp1}?re=${token}`);

  for (let attempt = 0; attempt < WP_HTTP_MAX_RETRIES; attempt++) {
    const result = await fetcher.text(ctx, retryUrl);
    if (!result.includes('Invalid Request')) {
      const reurlMatch = result.match(/var\s+reurl\s*=\s*["']([^"']+)["']/);
      if (reurlMatch?.[1]) return new URL(reurlMatch[1]);
      try {
        return new URL(result.trim());
      } catch { /* next attempt */ }
    }
    await new Promise(resolve => setTimeout(resolve, WP_HTTP_RETRY_DELAY_MS));
  }

  throw new Error(`[hd-hub-helper] wp_http1 resolution failed after ${WP_HTTP_MAX_RETRIES} retries`);
};
