/**
 * PhoeniX - Concurrency Limiter
 * Limits parallel HTTP requests to avoid triggering Cloudflare WAF
 * when deep-crawling large directories (20K+ folders).
 *
 * Uses p-limit under the hood.
 */

const pLimit = require('p-limit').default || require('p-limit');

// Default: 5 concurrent requests (safe for Cloudflare)
// Override via PHOENIX_MAX_CONCURRENCY env var
const DEFAULT_CONCURRENCY = parseInt(
  process.env.PHOENIX_MAX_CONCURRENCY || '5',
  10
);

/**
 * Create a concurrency-limited async mapper.
 * Usage:
 *   const limit = createLimiter(5);
 *   const results = await Promise.all(
 *     items.map(item => limit(() => fetchItem(item)))
 *   );
 *
 * @param {number} concurrency - max parallel requests (default: 5)
 * @returns {Function} - wrapped p-limit function
 */
function createLimiter(concurrency) {
  return pLimit(concurrency || DEFAULT_CONCURRENCY);
}

/**
 * Map an array with limited concurrency.
 * @param {Array} items
 * @param {Function} fn - async mapper function
 * @param {number} concurrency - max parallel (default: 5)
 * @returns {Promise<Array>}
 */
async function mapWithLimit(items, fn, concurrency) {
  const limit = createLimiter(concurrency);
  return Promise.all(items.map((item, index) => limit(() => fn(item, index))));
}

module.exports = {
  createLimiter,
  mapWithLimit,
  DEFAULT_CONCURRENCY,
};
