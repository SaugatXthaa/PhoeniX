// lib/config.js
// Centralized config — exposes env vars that 4KHDHub/cinedoze extraction expects

export const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || process.env.FLARESOLVERR_ENDPOINT || '';
export const FLARESOLVERR_V2 = process.env.FLARESOLVERR_V2 === 'true';
export const FLARESOLVERR_PROXY_URL = process.env.FLARESOLVERR_PROXY_URL || '';
export const HTTP_STREAM_USER_AGENT = process.env.HTTP_STREAM_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
