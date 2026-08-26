/**
 * PhoeniX Addon - Lightweight logger
 * Writes to stdout/stderr with simple levels.
 * Disable via env: PHOENIX_LOG_LEVEL=off
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, off: 999 };
const currentLevel =
  LEVELS[process.env.PHOENIX_LOG_LEVEL || 'info'] || LEVELS.info;

function fmt(level, msg) {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.toUpperCase()}] ${msg}`;
}

module.exports = {
  debug: (msg) => {
    if (currentLevel <= LEVELS.debug) console.log(fmt('debug', msg));
  },
  info: (msg) => {
    if (currentLevel <= LEVELS.info) console.log(fmt('info', msg));
  },
  warn: (msg) => {
    if (currentLevel <= LEVELS.warn) console.warn(fmt('warn', msg));
  },
  error: (msg) => {
    if (currentLevel <= LEVELS.error) console.error(fmt('error', msg));
  },
};
