const real = require('./cinestream_all_in_one.js');
module.exports = {
  getStreams: real.getStreams,
  getTMDBInfo: real.getTMDBInfo,
  tryOriginalWebstreamr: real.tryOriginalWebstreamr,
  FALLBACK_PROVIDERS: real.FALLBACK_PROVIDERS,
  WEBSTREAMR_BASE: real.WEBSTREAMR_BASE,
};
