// src/utils/config.js
// Ported subset of research/webstreamr-mbg/src/utils/config.ts

export const getDefaultConfig = () => {
  return { multi: 'on', en: 'on' };
};

export const showErrors = (config) => 'showErrors' in (config || {});
export const showExternalUrls = (config) => 'includeExternalUrls' in (config || {});
export const hasMultiEnabled = (config) => 'multi' in (config || {});

export const disableExtractorConfigKey = (extractor) => `disableExtractor_${extractor.id}`;
export const isExtractorDisabled = (config, extractor) => disableExtractorConfigKey(extractor) in (config || {});

export const excludeResolutionConfigKey = (resolution) => `excludeResolution_${resolution}`;
export const isResolutionExcluded = (config, resolution) => excludeResolutionConfigKey(resolution) in (config || {});
