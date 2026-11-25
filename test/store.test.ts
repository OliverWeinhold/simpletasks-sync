import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/db.ts";

const blob = (n: number) => "A".repeat(n);
const LIMITS = { maxVaultBytes: 1_000_000, maxTotalBytes: 0 };

test("writes with a stale vault do not reset the seq counter", () => {
  const store = openStore(":memory:");
  store.createVault("v1", "hash", Date.now());
  // both requests opened the vault before either wrote
  const stale = store.getVault("v1")!;
  store.appendOps(stale.id, [{ opId: "a", blob: blob(10) }], LIMITS);
  store.appendOps(stale.id, [{ opId: "b", blob: blob(10) }], LIMITS);
  store.putSnapshot(stale.id, 1, blob(20), LIMITS);
  const result = store.appendOps(stale.id, [{ opId: "c", blob: blob(10) }], LIMITS);
  assert.deepEqual(result.seqs, [3]);
  assert.equal(store.getVault("v1")!.nextSeq, 4);
  store.close();
});

test("older snapshot is rejected inside the transaction", () => {
  const store = openStore(":memory:");
  store.createVault("v1", "hash", Date.now());
  store.appendOps("v1", [{ opId: "a", blob: blob(10) }, { opId: "b", blob: blob(10) }], LIMITS);
  store.putSnapshot("v1", 2, blob(20), LIMITS);
  assert.throws(() => store.putSnapshot("v1", 1, blob(20), LIMITS), /olderSnapshot/);
  assert.throws(() => store.putSnapshot("v1", 5, blob(20), LIMITS), /badRequest/);
  store.close();
});

test("total limit counts all vaults, shrinking stays allowed", () => {
  const store = openStore(":memory:");
  const limits = { maxVaultBytes: 1_000, maxTotalBytes: 100 };
  store.createVault("v1", "hash", Date.now());
  store.createVault("v2", "hash", Date.now());
  store.appendOps("v1", [{ opId: "a", blob: blob(60) }], limits);
  assert.throws(() => store.appendOps("v2", [{ opId: "b", blob: blob(50) }], limits), /storage limit/);
  store.appendOps("v2", [{ opId: "b", blob: blob(40) }], limits);
  // a smaller snapshot frees space even when the server is full
  store.putSnapshot("v1", 1, blob(10), limits);
  assert.equal(store.totalBytes(), 50);
});
