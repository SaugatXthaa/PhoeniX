// src/utils/media-flow-proxy.js
// Simplified port — always treats MediaFlowProxy as unavailable so ported
// extractors use their local extraction paths only.

export const supportsMediaFlowProxy = (_ctx) => false;

export const hasMultiEnabled = (config) => 'multi' in (config || {});

export const buildMediaFlowProxyExtractorRedirectUrl = (_ctx, _host, _url, _headers = {}) => {
  throw new Error('MediaFlowProxy is not configured');
};

export const buildMediaFlowProxyExtractorStreamUrl = async () => {
  throw new Error('MediaFlowProxy is not configured');
};

export const buildMediaFlowProxyHlsUrl = (_ctx, _m3u8Url, _headers = {}, _proxySegments = false) => {
  throw new Error('MediaFlowProxy is not configured');
};
