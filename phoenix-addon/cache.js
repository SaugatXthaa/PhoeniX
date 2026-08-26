/**
 * PhoeniX Addon - In-memory cache layer
 * Uses node-cache with a 1-hour TTL as per the spec.
 * Prevents spamming upstream sources during pause/resume/device switching.
 */

const NodeCache = require('node-cache');
const logger = require('./logger');

const streamCache = new NodeCache({
  stdTTL: 3600, // 1 hour
  checkperiod: 120,
  useClones: false,
});

const STATS = { hits: 0, misses: 0, sets: 0 };

/**
 * Get a cached stream array for a content ID.
 * @param {string} id - imdb id or imdb:season:episode
 * @returns {Array|null}
 */
function get(id) {
  const v = streamCache.get(id);
  if (v !== undefined) {
    STATS.hits++;
    logger.debug(`Cache HIT for ${id}`);
    return v;
  }
  STATS.misses++;
  logger.debug(`Cache MISS for ${id}`);
  return null;
}

/**
 * Store resolved streams for a content ID.
 * Empty arrays are also cached (short-circuit empty results for 5 minutes).
 */
function set(id, value) {
  STATS.sets++;
  if (Array.isArray(value) && value.length === 0) {
    // Short empty TTL - retry sooner for nothing-found cases.
    streamCache.set(id, value, 300);
  } else {
    streamCache.set(id, value);
  }
  logger.debug(`Cache SET for ${id} (${Array.isArray(value) ? value.length : 1} entries)`);
}

function flush() {
  streamCache.flushAll();
  logger.info('Cache flushed');
}

function stats() {
  return { ...STATS, keys: streamCache.keys().length };
}

module.exports = { get, set, flush, stats };
