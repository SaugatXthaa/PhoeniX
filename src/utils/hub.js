// src/utils/hub.js

export const DEAD_HUBCLOUD_HOSTS = new Set([
  'hubcloud.ink', 'hubcloud.co', 'hubcloud.cc', 'hubcloud.me', 'hubcloud.xyz',
]);

export const HUB_HOST_PATTERN = /hubcdn|hubcloud|hubdrive/;

export const HUBCLOUD_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
