// src/error/index.js

export class BlockedError extends Error {
  constructor(url, reason, headers = {}) { super(); this.url = url; this.reason = reason; this.headers = headers; }
}
export class HttpError extends Error {
  constructor(url, status, statusText, headers = {}) { super(); this.url = url; this.status = status; this.statusText = statusText; this.headers = headers; }
}
export class NotFoundError extends Error {}
export class TimeoutError extends Error {
  constructor(url) { super(); this.url = url; }
}
export class TooManyRequestsError extends Error {
  constructor(url, retryAfter) { super(); this.url = url; this.retryAfter = retryAfter; }
}
export class TooManyTimeoutsError extends Error {
  constructor(url) { super(); this.url = url; }
}

export function logErrorAndReturnNiceString(source, error) {
  if (error instanceof BlockedError) return `⚠️ Blocked: ${error.url?.host || source} (${error.reason})`;
  if (error instanceof TooManyRequestsError) return `🚦 Rate-limited: ${error.url?.host || source}`;
  if (error instanceof TimeoutError) return `🐢 Timeout: ${error.url?.host || source}`;
  if (error instanceof NotFoundError) return `🔍 Not found: ${source}`;
  if (error instanceof HttpError) return `❌ HTTP ${error.status}: ${error.url?.host || source}`;
  return `❌ Error: ${error?.message || error}`;
}
