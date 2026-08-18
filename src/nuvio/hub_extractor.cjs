// src/nuvio/hub_extractor.cjs
// Minimal passthrough stub for hdhub4u.cjs which requires:
//   he.USER_AGENT, he.FULL_HEADERS, he.resolveDownloadUrl(url)
//
// resolveDownloadUrl is a PASSTHROUGH — returns the URL as-is. This lets
// the existing PhoeniX extractor pipeline handle resolution downstream:
//   - hubcdn.sbs URLs → HubExtractor (resolves to direct CDN URL)
//   - hubcloud.cx URLs → HubCloud extractor (resolves to pixel.hubcloud.cx → gpdl.hubcloud.cx)
//   - pixeldrain URLs → DirectStream (direct playable URL)
//   - googleusercontent URLs → DirectStream (direct playable URL)
//
// The full hub_extractor.cjs tried to resolve hubcloud links itself through
// the gamerxyt.com chain, but that chain is broken ("No pixel.hubcloud.cx URL
// found"). The existing PhoeniX HubCloud extractor already handles hubcloud.cx
// links correctly — it resolves them to pixel.hubcloud.cx → gpdl.hubcloud.cx
// CDN URLs which are directly playable.
//
// hdhub4u source filters for "resolvable" link types before calling
// resolveDownloadUrl, so only hubcdn/hubcloud/pixeldrain/gdrive URLs reach
// this function. All of these are handled by existing PhoeniX extractors.

"use strict";

var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

var FULL_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

// Passthrough — return the URL as-is so downstream extractors handle it.
// The hdhub4u source only calls this on "resolvable" URLs (hubcdn, hubcloud,
// pixeldrain, gdrive) — all of which are handled by existing PhoeniX extractors:
//   - hubcloud.cx → HubCloud extractor → pixel.hubcloud.cx → gpdl.hubcloud.cx
//   - hubcdn.sbs → HubExtractor → direct CDN URL
//   - pixeldrain → DirectStream → direct playable URL
//   - googleusercontent → DirectStream → direct playable URL
function resolveDownloadUrl(url) {
  return Promise.resolve(url);
}

module.exports = {
  USER_AGENT: USER_AGENT,
  FULL_HEADERS: FULL_HEADERS,
  resolveDownloadUrl: resolveDownloadUrl,
};
