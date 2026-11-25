import { DatabaseSync } from "node:sqlite";

export interface Vault {
  id: string;
  authHash: string;
  nextSeq: number;
  bytes: number;
  lastSeen: number;
}

export interface StoredOp {
  seq: number;
  opId: string;
  blob: string;
}

export type Store = ReturnType<typeof openStore>;

const SCHEMA_VERSION = 1;

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);

  const q = {
    getVault: db.prepare("SELECT id, auth_hash, next_seq, bytes, last_seen FROM vaults WHERE id = ?"),
    insertVault: db.prepare(
      "INSERT OR IGNORE INTO vaults (id, auth_hash, created_at, last_seen) VALUES (?, ?, ?, ?)"
    ),
    countNewVaults: db.prepare("SELECT COUNT(*) AS n FROM vaults WHERE created_at > ?"),
    touch: db.prepare("UPDATE vaults SET last_seen = ? WHERE id = ?"),
    findOp: db.prepare("SELECT seq FROM ops WHERE vault_id = ? AND op_id = ?"),
    insertOp: db.prepare("INSERT INTO ops (vault_id, seq, op_id, blob) VALUES (?, ?, ?, ?)"),
    setCounters: db.prepare("UPDATE vaults SET next_seq = ?, bytes = ? WHERE id = ?"),
    listOps: db.prepare("SELECT seq, op_id, blob FROM ops WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?"),
    getSnapshot: db.prepare("SELECT up_to_seq, blob FROM snapshots WHERE vault_id = ?"),
    putSnapshot: db.prepare("INSERT OR REPLACE INTO snapshots (vault_id, up_to_seq, blob) VALUES (?, ?, ?)"),
    dropOldOps: db.prepare("DELETE FROM ops WHERE vault_id = ? AND seq <= ?"),
    opBytes: db.prepare("SELECT COALESCE(SUM(LENGTH(blob)), 0) AS n FROM ops WHERE vault_id = ?"),
    totalBytes: db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM vaults"),
    deleteVault: db.prepare("DELETE FROM vaults WHERE id = ?"),
    deleteInactive: db.prepare("DELETE FROM vaults WHERE last_seen < ?"),
  };

  function transaction<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function snapshotOf(vaultId: string): { upToSeq: number; blob: string } | null {
    const row = q.getSnapshot.get(vaultId) as { up_to_seq: number; blob: string } | undefined;
    return row ? { upToSeq: row.up_to_seq, blob: row.blob } : null;
  }

  // throws when growing a vault would push the whole database over the limit
  function checkTotal(vault: Vault, newBytes: number, limits: Limits) {
    if (limits.maxTotalBytes <= 0 || newBytes <= vault.bytes) return;
    const total = Number((q.totalBytes.get() as { n: number }).n);
    if (total - vault.bytes + newBytes > limits.maxTotalBytes) throw new StorageFullError();
  }

  function vaultOf(id: string): Vault | null {
    const row = q.getVault.get(id) as
      | { id: string; auth_hash: string; next_seq: number; bytes: number; last_seen: number }
      | undefined;
    if (!row) return null;
    return { id: row.id, authHash: row.auth_hash, nextSeq: row.next_seq, bytes: row.bytes, lastSeen: row.last_seen };
  }

  return {
    close: () => db.close(),

    getVault: vaultOf,

    // false if the vault already exists
    createVault(id: string, authHash: string, now: number): boolean {
      return Number(q.insertVault.run(id, authHash, now, now).changes) > 0;
    },

    totalBytes(): number {
      return Number((q.totalBytes.get() as { n: number }).n);
    },

    newVaultsSince(since: number): number {
      return Number((q.countNewVaults.get(since) as { n: number }).n);
    },

    touch(id: string, now: number) {
      q.touch.run(now, id);
    },

    // all or nothing, an op id that is already stored keeps its seq
    appendOps(vaultId: string, ops: { opId: string; blob: string }[], limits: Limits) {
      return transaction(() => {
        // read again, another request may have written since the vault was opened
        const vault = vaultOf(vaultId);
        if (!vault) throw new VaultGoneError();
        let nextSeq = vault.nextSeq;
        let bytes = vault.bytes;
        const seqs: number[] = [];
        for (const op of ops) {
          const existing = q.findOp.get(vault.id, op.opId) as { seq: number } | undefined;
          if (existing) {
            seqs.push(existing.seq);
            continue;
          }
          bytes += op.blob.length;
          if (bytes > limits.maxVaultBytes) throw new QuotaError();
          q.insertOp.run(vault.id, nextSeq, op.opId, op.blob);
          seqs.push(nextSeq);
          nextSeq++;
        }
        checkTotal(vault, bytes, limits);
        q.setCounters.run(nextSeq, bytes, vault.id);
        return { seqs, latestSeq: nextSeq - 1 };
      });
    },

    listOps(vaultId: string, since: number, limit: number): StoredOp[] {
      const rows = q.listOps.all(vaultId, since, limit) as { seq: number; op_id: string; blob: string }[];
      return rows.map((row) => ({ seq: row.seq, opId: row.op_id, blob: row.blob }));
    },

    getSnapshot: snapshotOf,

    putSnapshot(vaultId: string, upToSeq: number, blob: string, limits: Limits) {
      return transaction(() => {
        const vault = vaultOf(vaultId);
        if (!vault) throw new VaultGoneError();
        if (upToSeq > vault.nextSeq - 1) throw new BadSnapshotError("badRequest");
        const current = snapshotOf(vault.id);
        if (current && upToSeq < current.upToSeq) throw new BadSnapshotError("olderSnapshot");
        q.putSnapshot.run(vault.id, upToSeq, blob);
        q.dropOldOps.run(vault.id, upToSeq);
        const bytes = Number((q.opBytes.get(vault.id) as { n: number }).n) + blob.length;
        if (bytes > limits.maxVaultBytes) throw new QuotaError();
        checkTotal(vault, bytes, limits);
        q.setCounters.run(vault.nextSeq, bytes, vault.id);
      });
    },

    deleteVault(id: string) {
      q.deleteVault.run(id);
    },

    deleteInactive(before: number): number {
      return Number(q.deleteInactive.run(before).changes);
    },
  };
}

export interface Limits {
  maxVaultBytes: number;
  maxTotalBytes: number;
}

export class StorageFullError extends Error {
  constructor() {
    super("storage limit reached");
  }
}

export class QuotaError extends Error {
  constructor() {
    super("vault quota exceeded");
  }
}

// vault deleted by a parallel request
export class VaultGoneError extends Error {
  constructor() {
    super("vault deleted");
  }
}

export class BadSnapshotError extends Error {
  code: string;
  constructor(code: "badRequest" | "olderSnapshot") {
    super(code);
    this.code = code;
  }
}

function migrate(db: DatabaseSync) {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version >= SCHEMA_VERSION) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS vaults (
      id         TEXT PRIMARY KEY,
      auth_hash  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      next_seq   INTEGER NOT NULL DEFAULT 1,
      bytes      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ops (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      seq      INTEGER NOT NULL,
      op_id    TEXT NOT NULL,
      blob     TEXT NOT NULL,
      PRIMARY KEY (vault_id, seq),
      UNIQUE (vault_id, op_id)
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      vault_id  TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
      up_to_seq INTEGER NOT NULL,
      blob      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vaults_created ON vaults (created_at);
    CREATE INDEX IF NOT EXISTS idx_vaults_last_seen ON vaults (last_seen);
  `);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
