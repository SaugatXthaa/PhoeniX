// Wrapper for desiflix.cjs — re-exports the scraper's public API.
// (Previously this file required './desiflix_all_in_one.js' which did not
// exist — the actual scraper module is './desiflix.cjs'.)
const real = require('./desiflix.cjs');
module.exports = {
  getStreams: real.getStreams,
  getTMDBInfo: real.getTMDBInfo,
  fetchFromApi: real.fetchFromApi,
  search: real.search,
  getCatalog: real.getCatalog,
  getStreamsByDsxId: real.getStreamsByDsxId,
  BASE_URLS: real.BASE_URLS,
  STREMIO_UA: real.STREMIO_UA,
};
