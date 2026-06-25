export function createLoopGuard({ windowMs = 60000, maxEvents = 4 } = {}) {
  const buckets = new Map();

  return {
    record(event) {
      const now = Date.now();
      const key = event.roomId || event.roomName || 'global';
      const previous = buckets.get(key) || [];
      const timestamps = previous.filter((timestamp) => now - timestamp <= windowMs);
      timestamps.push(now);
      buckets.set(key, timestamps);

      return {
        blocked: timestamps.length > maxEvents,
        count: timestamps.length,
        key,
        windowMs,
        maxEvents
      };
    },

    reset(key = 'global') {
      buckets.delete(key);
    }
  };
}
