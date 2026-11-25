import { createHash, timingSafeEqual } from "node:crypto";

// tokens are 32 random bytes, a plain hash is enough (no password stretching needed)
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
