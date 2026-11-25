import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { BadSnapshotError, QuotaError, StorageFullError, VaultGoneError, type Store, type Vault } from "./db.ts";
import { bearerToken, hashToken, tokenMatches } from "./auth.ts";
import { createRateLimiter } from "./ratelimit.ts";

export const PROTOCOL_VERSION = 1;

const VAULT_ID = /^[A-Za-z0-9_-]{22}$/;
const OP_ID = /^[A-Za-z0-9_-]{8,64}$/;
const BLOB = /^[A-Za-z0-9_-]+$/;
const DAY = 24 * 60 * 60 * 1000;
// new vaults per minute and ip, a real user needs one
const NEW_VAULTS_PER_MINUTE = 5;
// last_seen is only written when older than this, saves a write per request
const TOUCH_EVERY = 60 * 60 * 1000;

class HttpError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, extra: Record<string, unknown> = {}) {
    super(code);
    this.status = status;
    this.extra = extra;
  }
}

function send(res: ServerResponse, status: number, body?: unknown) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

// bodies being read by all requests together. parsing needs about four times
// the body size, so 16 MB keeps the server well below its 256 MB memory limit
const BODY_BUDGET = 16 * 1024 * 1024;
let bodyBytes = 0;

async function readJson(req: IncomingMessage, maxBytes: number): Promise<any> {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > maxBytes) throw new HttpError(413, "tooLarge");
  // reserve the declared size up front, chunked bodies reserve as they come in
  let reserved = 0;
  const reserve = (bytes: number) => {
    if (bodyBytes + bytes > BODY_BUDGET) throw new HttpError(503, "busy");
    bodyBytes += bytes;
    reserved += bytes;
  };
  try {
    reserve(declared);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, "tooLarge");
      if (size > reserved) reserve(size - reserved);
      chunks.push(chunk);
    }
    if (size === 0) return null;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "badRequest");
    }
  } finally {
    bodyBytes -= reserved;
  }
}

// ipv6 users usually get a whole /64, so limits count per /64
export function limitKey(ip: string): string {
  const address = ip.replace(/^::ffff:(?=\d+\.)/i, "");
  if (!address.includes(":")) return address;
  const [head, tail = ""] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return groups.slice(0, 4).join(":") + "::/64";
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    // the last entry is the one our proxy added, earlier ones can be faked
    const forwarded = req.headers["x-forwarded-for"];
    const header = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
    const last = header?.split(",").pop()?.trim();
    if (last) return limitKey(last);
  }
  return limitKey(req.socket.remoteAddress || "unknown");
}

export function createSyncServer(config: Config, store: Store, now: () => number = Date.now) {
  // per ip for new vaults and failed logins, per vault for normal use
  // many phones share one ip behind carrier nat, so normal use is not counted per ip
  const limiter = createRateLimiter(config.rateLimit);
  const vaultLimiter = createRateLimiter(config.rateLimit);
  const createLimiter = createRateLimiter(config.rateLimit === 0 ? 0 : NEW_VAULTS_PER_MINUTE);
  const limits = { maxVaultBytes: config.maxVaultBytes, maxTotalBytes: config.maxTotalBytes };
  // a full batch of max size blobs, but never more than fits into a vault
  const maxBodyBytes =
    Math.min(config.maxOpsPerRequest * config.maxBlobBytes, config.maxVaultBytes) + config.maxOpsPerRequest * 200 + 1024;

  function checkBlob(blob: unknown, maxBytes: number): string {
    if (typeof blob !== "string" || blob.length === 0 || !BLOB.test(blob)) throw new HttpError(400, "badRequest");
    if (blob.length > maxBytes) throw new HttpError(413, "tooLarge");
    return blob;
  }

  // vault first, then token, so the app can tell "vault gone" from "wrong code"
  function openVault(req: IncomingMessage, id: string): Vault {
    const ip = clientIp(req, config.trustProxy);
    if (limiter.blocked(ip)) throw new HttpError(429, "rateLimited");
    const reject = (status: number, code: string): never => {
      limiter.allow(ip);
      throw new HttpError(status, code);
    };
    if (!VAULT_ID.test(id)) reject(400, "badRequest");
    const vault = store.getVault(id);
    if (!vault) return reject(404, "vaultNotFound");
    const token = bearerToken(req.headers.authorization);
    if (!token || !tokenMatches(token, vault.authHash)) reject(401, "unauthorized");
    if (!vaultLimiter.allow(vault.id)) throw new HttpError(429, "rateLimited");
    const time = now();
    if (time - vault.lastSeen > TOUCH_EVERY) store.touch(vault.id, time);
    return vault;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    let url: URL;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      throw new HttpError(400, "badRequest");
    }
    const method = req.method || "GET";
    const path = url.pathname;

    // HEAD too, many uptime monitors use it. node drops the body for HEAD
    if ((method === "GET" || method === "HEAD") && path === "/v1/health") {
      return send(res, 200, {
        ok: true,
        protocol: PROTOCOL_VERSION,
        limits: { maxBlobBytes: config.maxBlobBytes, maxVaultBytes: config.maxVaultBytes },
      });
    }

    if (path === "/v1/vaults") {
      if (method !== "POST") throw new HttpError(405, "methodNotAllowed");
      if (!createLimiter.allow(clientIp(req, config.trustProxy))) throw new HttpError(429, "rateLimited");
      const body = await readJson(req, 4096);
      const token = bearerToken(req.headers.authorization);
      const id = body?.vaultId;
      if (!token || typeof id !== "string" || !VAULT_ID.test(id)) throw new HttpError(400, "badRequest");
      if (store.getVault(id)) throw new HttpError(409, "exists");
      if (config.maxTotalBytes > 0 && store.totalBytes() >= config.maxTotalBytes) throw new HttpError(507, "serverFull");
      if (config.maxNewVaultsPerDay > 0 && store.newVaultsSince(now() - DAY) >= config.maxNewVaultsPerDay) {
        throw new HttpError(429, "rateLimited");
      }
      if (!store.createVault(id, hashToken(token), now())) throw new HttpError(409, "exists");
      return send(res, 201, { vaultId: id });
    }

    const match = /^\/v1\/vaults\/([^/]+)(\/ops|\/snapshot)?$/.exec(path);
    if (!match) throw new HttpError(404, "notFound");
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      throw new HttpError(400, "badRequest");
    }
    const vault = openVault(req, id);
    const sub = match[2] || "";

    if (sub === "" && method === "DELETE") {
      store.deleteVault(vault.id);
      return send(res, 204);
    }

    if (sub === "/ops" && method === "POST") {
      const body = await readJson(req, maxBodyBytes);
      const ops = body?.ops;
      if (!Array.isArray(ops) || ops.length === 0 || ops.length > config.maxOpsPerRequest) {
        throw new HttpError(400, "badRequest");
      }
      const clean = ops.map((op: any) => {
        if (typeof op?.opId !== "string" || !OP_ID.test(op.opId)) throw new HttpError(400, "badRequest");
        return { opId: op.opId, blob: checkBlob(op.blob, config.maxBlobBytes) };
      });
      return send(res, 200, store.appendOps(vault.id, clean, limits));
    }

    if (sub === "/ops" && method === "GET") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
      if (!Number.isInteger(since) || since < 0) throw new HttpError(400, "badRequest");
      const snapshotSeq = store.getSnapshot(vault.id)?.upToSeq ?? 0;
      if (since < snapshotSeq) throw new HttpError(410, "gone", { snapshotSeq });
      // one extra row tells whether there is more
      const rows = store.listOps(vault.id, since, limit + 1);
      return send(res, 200, {
        ops: rows.slice(0, limit),
        hasMore: rows.length > limit,
        latestSeq: vault.nextSeq - 1,
        snapshotSeq,
      });
    }

    if (sub === "/snapshot" && method === "GET") {
      const snapshot = store.getSnapshot(vault.id);
      if (!snapshot) throw new HttpError(404, "noSnapshot");
      return send(res, 200, snapshot);
    }

    if (sub === "/snapshot" && method === "PUT") {
      // a snapshot holds the whole vault, so only the vault limit applies
      const body = await readJson(req, config.maxVaultBytes + 1024);
      const upToSeq = body?.upToSeq;
      if (!Number.isInteger(upToSeq) || upToSeq < 0) throw new HttpError(400, "badRequest");
      const blob = checkBlob(body.blob, config.maxVaultBytes);
      // seq and older snapshot checks run inside the transaction
      store.putSnapshot(vault.id, upToSeq, blob, limits);
      return send(res, 204);
    }

    throw new HttpError(405, "methodNotAllowed");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.message, ...error.extra });
      } else if (error instanceof QuotaError) {
        send(res, 413, { error: "tooLarge" });
      } else if (error instanceof StorageFullError) {
        send(res, 507, { error: "serverFull" });
      } else if (error instanceof VaultGoneError) {
        send(res, 404, { error: "vaultNotFound" });
      } else if (error instanceof BadSnapshotError) {
        send(res, error.code === "olderSnapshot" ? 409 : 400, { error: error.code });
      } else {
        // no request details in the log, they may contain ids or tokens
        console.error("request failed:", error instanceof Error ? error.message : error);
        send(res, 500, { error: "server" });
      }
      // stop reading a body we did not consume
      if (!req.complete) req.resume();
    });
  });

  // slow clients should not keep sockets open forever
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  const prune = () => {
    limiter.prune();
    vaultLimiter.prune();
    createLimiter.prune();
  };
  return { server, limiter: { prune } };
}
