export function createMessageDeduper({ ttlMs = 10 * 60 * 1000, maxEntries = 1000 } = {}) {
  const entries = new Map();
  const enabled = ttlMs > 0 && maxEntries > 0;

  return {
    checkAndRemember(messageId, now = Date.now()) {
      const key = String(messageId || '').trim();
      if (!enabled || !key) {
        return { duplicate: false, remembered: false, key, enabled };
      }

      pruneExpired(now);
      const expiresAt = entries.get(key);
      if (expiresAt && expiresAt > now) {
        return { duplicate: true, remembered: false, key, expiresAt, enabled };
      }

      const nextExpiresAt = now + ttlMs;
      entries.set(key, nextExpiresAt);
      pruneMaxEntries();
      return { duplicate: false, remembered: true, key, expiresAt: nextExpiresAt, enabled };
    },

    size(now = Date.now()) {
      pruneExpired(now);
      return entries.size;
    },

    reset() {
      entries.clear();
    }
  };

  function pruneExpired(now) {
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) entries.delete(key);
    }
  }

  function pruneMaxEntries() {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (!oldestKey) return;
      entries.delete(oldestKey);
    }
  }
}
