// fixed one minute window per key (ip or vault), kept in memory only
export function createRateLimiter(perMinute: number) {
  const windows = new Map<string, { start: number; count: number }>();

  return {
    allow(ip: string, now = Date.now()): boolean {
      if (perMinute === 0) return true;
      const entry = windows.get(ip);
      if (!entry || now - entry.start >= 60_000) {
        windows.set(ip, { start: now, count: 1 });
        return true;
      }
      entry.count++;
      return entry.count <= perMinute;
    },

    // true while the key is over the limit, does not count
    blocked(key: string, now = Date.now()): boolean {
      if (perMinute === 0) return false;
      const entry = windows.get(key);
      return Boolean(entry && now - entry.start < 60_000 && entry.count >= perMinute);
    },

    prune(now = Date.now()) {
      for (const [ip, entry] of windows) {
        if (now - entry.start >= 60_000) windows.delete(ip);
      }
    },
  };
}
