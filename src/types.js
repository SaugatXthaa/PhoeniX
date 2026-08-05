// src/types.js

export const CountryCode = {
  multi: 'multi', en: 'en', hi: 'hi', ta: 'ta', te: 'te', gu: 'gu', ml: 'ml', pa: 'pa', mr: 'mr', kn: 'kn',
  de: 'de', fr: 'fr', es: 'es', mx: 'mx', it: 'it', pt: 'pt', ja: 'ja', ko: 'ko', zh: 'zh',
  ar: 'ar', tr: 'tr', ru: 'ru', pl: 'pl', nl: 'nl', ro: 'ro', bg: 'bg', hr: 'hr', cs: 'cs',
  el: 'el', he: 'he', hu: 'hu', sk: 'sk', sl: 'sl', sr: 'sr', uk: 'uk', vi: 'vi', th: 'th',
  id: 'id', et: 'et', lt: 'lt', lv: 'lv', no: 'no', fa: 'fa', bl: 'bl', al: 'al',
};

export const Format = { hls: 'hls', mp4: 'mp4', unknown: 'unknown' };

export const BlockedReason = {
  cloudflare_challenge: 'cloudflare_challenge',
  flaresolverr_failed: 'flaresolverr_failed',
  cloudflare_censor: 'cloudflare_censor',
  media_flow_proxy_auth: 'media_flow_proxy_auth',
  unknown: 'unknown',
};
