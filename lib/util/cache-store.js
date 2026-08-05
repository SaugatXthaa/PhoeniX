// lib/util/cache-store.js
// In-memory cache store (simplified from sootio's SQLite/Postgres backend)
// Exposes the same API used by 4khdhub/extraction.js and other providers

const memoryCache = new Map();

export function isEnabled() {
    return true; // Always enabled (in-memory)
}

export async function getCachedStreamUrl(key) {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > (entry.ttl || 900000)) {
        memoryCache.delete(key);
        return null;
    }
    return entry.value;
}

export async function setCachedStreamUrl(key, value, ttl = 900000) {
    memoryCache.set(key, { value, ts: Date.now(), ttl });
}

export async function clearCachedStreamUrls() {
    memoryCache.clear();
}

export async function getCachedSearchResults(key) {
    return getCachedStreamUrl(`search:${key}`);
}

export async function setCachedSearchResults(key, value, ttl = 1800000) {
    return setCachedStreamUrl(`search:${key}`, value, ttl);
}

// Used by 4khdhub/extraction.js for CF cookie caching
export async function getCachedRecord(service, key) {
    return getCachedStreamUrl(`${service}:${key}`);
}

export async function upsertCachedMagnet(record) {
    const key = `${record.service || 'default'}:${record.hash || record.key || 'unknown'}`;
    memoryCache.set(key, {
        value: record.data || record.value || record,
        ts: Date.now(),
        ttl: record.ttl || 900000
    });
}

export async function deleteCachedHash(service, key) {
    memoryCache.delete(`${service}:${key}`);
}

// Generic cache API
export const cache = {
    async get(key) {
        return getCachedStreamUrl(key);
    },
    async set(key, value, ttl) {
        return setCachedStreamUrl(key, value, ttl);
    },
    async delete(key) {
        memoryCache.delete(key);
    },
    async clear() {
        memoryCache.clear();
    }
};

export default {
    isEnabled,
    getCachedStreamUrl,
    setCachedStreamUrl,
    clearCachedStreamUrls,
    getCachedSearchResults,
    setCachedSearchResults,
    getCachedRecord,
    upsertCachedMagnet,
    deleteCachedHash,
    cache
};
