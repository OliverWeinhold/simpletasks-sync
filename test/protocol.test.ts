import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { loadConfig, type Config } from "../src/config.ts";
import { openStore, type Store } from "../src/db.ts";
import { createSyncServer, limitKey } from "../src/server.ts";
import { hashToken } from "../src/auth.ts";

let dir: string;
let store: Store;
let base: string;
let close: () => Promise<void>;
let clock = 1_800_000_000_000;

const b64url = (bytes: number) => randomBytes(bytes).toString("base64url");
const newVault = () => ({ id: b64url(16), token: b64url(32) });

async function start(overrides: Partial<Config> = {}) {
  dir = mkdtempSync(join(tmpdir(), "simpletasks-sync-"));
  store = openStore(join(dir, "sync.db"));
  const config = { ...loadConfig({}), rateLimit: 0, ...overrides };
  const { server } = createSyncServer(config, store, () => clock);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
}

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function create(vault = newVault()) {
  const res = await call("POST", "/v1/vaults", vault.token, { vaultId: vault.id });
  assert.equal(res.status, 201);
  return vault;
}

const push = (v: { id: string; token: string }, ops: { opId: string; blob: string }[]) =>
  call("POST", `/v1/vaults/${v.id}/ops`, v.token, { ops });
const op = (n: number, blob = "AQ" + "x".repeat(n % 7)) => ({ opId: `op${String(n).padStart(6, "0")}`, blob });

beforeEach(() => start());
afterEach(async () => {
  await close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("health tells protocol and limits", async () => {
  const res = await call("GET", "/v1/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.protocol, 1);
  assert.equal(typeof res.body.limits.maxBlobBytes, "number");
});

test("health answers HEAD for uptime monitors", async () => {
  const res = await fetch(base + "/v1/health", { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});

test("create vault, second time is 409, bad input is 400", async () => {
  const v = await create();
  assert.equal((await call("POST", "/v1/vaults", v.token, { vaultId: v.id })).status, 409);
  assert.equal((await call("POST", "/v1/vaults", v.token, { vaultId: "short" })).status, 400);
  assert.equal((await call("POST", "/v1/vaults", undefined, { vaultId: newVault().id })).status, 400);
});

test("unknown vault is 404 before the token is checked, wrong token is 401", async () => {
  const v = await create();
  const unknown = newVault();
  assert.deepEqual(await call("GET", `/v1/vaults/${unknown.id}/ops?since=0`, "x"), {
    status: 404,
    body: { error: "vaultNotFound" },
  });
  assert.equal((await call("GET", `/v1/vaults/${v.id}/ops?since=0`, newVault().token)).status, 401);
  assert.equal((await call("GET", `/v1/vaults/${v.id}/ops?since=0`)).status, 401);
});

test("ops get gapless seqs, same op id is stored once", async () => {
  const v = await create();
  const first = await push(v, [op(1), op(2)]);
  assert.deepEqual(first.body, { seqs: [1, 2], latestSeq: 2 });
  const again = await push(v, [op(2), op(3)]);
  assert.deepEqual(again.body, { seqs: [2, 3], latestSeq: 3 });

  const all = await call("GET", `/v1/vaults/${v.id}/ops?since=0`, v.token);
  assert.deepEqual(
    all.body.ops.map((o: { seq: number; opId: string }) => [o.seq, o.opId]),
    [[1, "op000001"], [2, "op000002"], [3, "op000003"]]
  );
  assert.equal(all.body.hasMore, false);
  assert.equal(all.body.latestSeq, 3);
  assert.equal(all.body.snapshotSeq, 0);
});

test("pull pages with limit and hasMore", async () => {
  const v = await create();
  await push(v, [op(1), op(2), op(3)]);
  const page = await call("GET", `/v1/vaults/${v.id}/ops?since=1&limit=1`, v.token);
  assert.deepEqual(page.body.ops.map((o: { seq: number }) => o.seq), [2]);
  assert.equal(page.body.hasMore, true);
  const empty = await call("GET", `/v1/vaults/${v.id}/ops?since=3`, v.token);
  assert.deepEqual(empty.body, { ops: [], hasMore: false, latestSeq: 3, snapshotSeq: 0 });
});

test("bad ops are rejected and nothing is stored", async () => {
  const v = await create();
  assert.equal((await push(v, [])).status, 400);
  assert.equal((await push(v, [{ opId: "x", blob: "AQ" }])).status, 400);
  assert.equal((await push(v, [op(1), { opId: "op000009", blob: "not base64url!" }])).status, 400);
  const tooMany = Array.from({ length: 21 }, (_, i) => op(i));
  assert.equal((await push(v, tooMany)).status, 400);
  assert.equal((await call("GET", `/v1/vaults/${v.id}/ops?since=0`, v.token)).body.latestSeq, 0);
});

test("snapshot replaces old ops, older pulls get 410", async () => {
  const v = await create();
  await push(v, [op(1), op(2), op(3)]);
  assert.deepEqual(await call("GET", `/v1/vaults/${v.id}/snapshot`, v.token), {
    status: 404,
    body: { error: "noSnapshot" },
  });
  assert.equal((await call("PUT", `/v1/vaults/${v.id}/snapshot`, v.token, { upToSeq: 2, blob: "SNAP" })).status, 204);

  assert.deepEqual(await call("GET", `/v1/vaults/${v.id}/snapshot`, v.token), {
    status: 200,
    body: { upToSeq: 2, blob: "SNAP" },
  });
  assert.deepEqual(await call("GET", `/v1/vaults/${v.id}/ops?since=0`, v.token), {
    status: 410,
    body: { error: "gone", snapshotSeq: 2 },
  });
  const rest = await call("GET", `/v1/vaults/${v.id}/ops?since=2`, v.token);
  assert.deepEqual(rest.body.ops.map((o: { seq: number }) => o.seq), [3]);
  assert.equal(rest.body.snapshotSeq, 2);

  // seqs are never reused after old ops are gone
  assert.deepEqual((await push(v, [op(4)])).body.seqs, [4]);
  assert.equal((await call("PUT", `/v1/vaults/${v.id}/snapshot`, v.token, { upToSeq: 1, blob: "OLD" })).status, 409);
  assert.equal((await call("PUT", `/v1/vaults/${v.id}/snapshot`, v.token, { upToSeq: 99, blob: "X" })).status, 400);
});

test("limits give 413 and store nothing", async () => {
  await close();
  store.close();
  await start({ maxBlobBytes: 100, maxVaultBytes: 250 });
  const v = await create();
  assert.equal((await push(v, [op(1, "A".repeat(101))])).status, 413);
  assert.equal((await push(v, [op(1, "A".repeat(100)), op(2, "A".repeat(100))])).status, 200);
  assert.deepEqual(await push(v, [op(3, "A".repeat(60))]), { status: 413, body: { error: "tooLarge" } });
  assert.equal((await call("GET", `/v1/vaults/${v.id}/ops?since=0`, v.token)).body.latestSeq, 2);
});

test("snapshot may be larger than one packet, up to the vault limit", async () => {
  await close();
  store.close();
  await start({ maxBlobBytes: 100, maxVaultBytes: 1000 });
  const v = await create();
  await push(v, [op(1)]);
  const put = (blob: string) => call("PUT", `/v1/vaults/${v.id}/snapshot`, v.token, { upToSeq: 1, blob });
  assert.equal((await put("S".repeat(900))).status, 204);
  assert.equal((await put("S".repeat(1001))).status, 413);
});

test("oversized body, unknown path and wrong method", async () => {
  const v = await create();
  const huge = { ops: [op(1, "A".repeat(30 * 1024 * 1024))] };
  assert.equal((await push(v, huge.ops)).status, 413);
  assert.equal((await call("GET", "/v2/health")).status, 404);
  assert.equal((await call("PATCH", `/v1/vaults/${v.id}/ops`, v.token)).status, 405);
  assert.equal((await call("GET", "/v1/vaults")).status, 405);
});

test("rate limit per vault, many vaults behind one ip still work", async () => {
  await close();
  store.close();
  await start({ rateLimit: 3, trustProxy: false });
  const v = await create();
  const w = await create();
  for (let i = 0; i < 3; i++) assert.equal((await call("GET", `/v1/vaults/${v.id}/ops?since=0`, v.token)).status, 200);
  assert.equal((await call("GET", `/v1/vaults/${v.id}/ops?since=0`, v.token)).status, 429);
  // same ip, other vault (carrier nat)
  assert.equal((await call("GET", `/v1/vaults/${w.id}/ops?since=0`, w.token)).status, 200);
  // health stays reachable for monitoring
  assert.equal((await call("GET", "/v1/health")).status, 200);
});

test("failed logins are limited per ip", async () => {
  await close();
  store.close();
  await start({ rateLimit: 3, trustProxy: false });
  const v = await create();
  const wrong = newVault();
  for (let i = 0; i < 3; i++) {
    assert.equal((await call("GET", `/v1/vaults/${v.id}/ops?since=0`, wrong.token)).status, 401);
  }
  assert.equal((await call("GET", `/v1/vaults/${v.id}/ops?since=0`, v.token)).status, 429);
});

test("new vaults per day are limited", async () => {
  await close();
  store.close();
  await start({ maxNewVaultsPerDay: 2 });
  await create();
  await create();
  const third = newVault();
  assert.equal((await call("POST", "/v1/vaults", third.token, { vaultId: third.id })).status, 429);
  clock += 25 * 60 * 60 * 1000;
  await create(third);
});

test("delete removes the vault with everything in it", async () => {
  const v = await create();
  await push(v, [op(1)]);
  assert.equal((await call("DELETE", `/v1/vaults/${v.id}`, v.token)).status, 204);
  assert.equal((await call("GET", `/v1/vaults/${v.id}/ops?since=0`, v.token)).status, 404);
});

test("inactive vaults are removed by cleanup", async () => {
  const old = await create();
  clock += 200 * 24 * 60 * 60 * 1000;
  const fresh = await create();
  assert.equal(store.deleteInactive(clock - 180 * 24 * 60 * 60 * 1000), 1);
  assert.equal(store.getVault(old.id), null);
  assert.notEqual(store.getVault(fresh.id), null);
});

test("test vector from the app docs", async () => {
  // vault id and token derived from sync code 008J-4CT4-ANK7-F24S-NAXW-SQFE-ZWD
  const v = { id: "C7-v7I1Q17xW3jA2wU8pEQ", token: "g7vOM7Wj5Q-5zopxHMC3rcnl8Zu44BJgYKqMm-THA_c" };
  await create(v);
  assert.equal(store.getVault(v.id)?.authHash, hashToken(v.token));
  assert.equal((await call("GET", `/v1/vaults/${v.id}/ops?since=0`, v.token)).status, 200);
});

test("server stores only what it gets, no plain text anywhere", async () => {
  const v = await create();
  await push(v, [op(1, "QUJD")]);
  const stored = store.listOps(v.id, 0, 10);
  assert.deepEqual(stored, [{ seq: 1, opId: "op000001", blob: "QUJD" }]);
  assert.equal(store.getVault(v.id)?.authHash.length, 64);
});

test("new vaults are limited per ip and minute", async () => {
  await close();
  store.close();
  await start({ rateLimit: 100, trustProxy: false });
  for (let i = 0; i < 5; i++) await create();
  const sixth = newVault();
  assert.equal((await call("POST", "/v1/vaults", sixth.token, { vaultId: sixth.id })).status, 429);
});

test("no new vaults and no growth when the server is full", async () => {
  await close();
  store.close();
  await start({ maxTotalBytes: 50 });
  const v = await create();
  assert.equal((await push(v, [op(1, "A".repeat(40))])).status, 200);
  assert.equal((await push(v, [op(2, "A".repeat(20))])).status, 507);
  const w = newVault();
  assert.equal((await call("POST", "/v1/vaults", w.token, { vaultId: w.id })).status, 201);
  assert.equal((await push(v, [op(3, "A".repeat(10))])).status, 200);
  const x = newVault();
  assert.equal((await call("POST", "/v1/vaults", x.token, { vaultId: x.id })).status, 507);
});

test("broken percent encoding is a bad request, not a server error", async () => {
  const v = await create();
  assert.equal((await call("GET", "/v1/vaults/%zz/ops?since=0", v.token)).status, 400);
});

test("ipv6 addresses are limited per /64", () => {
  assert.equal(limitKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(limitKey("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
  assert.equal(limitKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(limitKey("::1"), "0:0:0:0::/64");
  assert.equal(limitKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(limitKey("203.0.113.7"), "203.0.113.7");
});

test("too many large uploads at once are turned away, not loaded into memory", async () => {
  const vaults = [await create(), await create(), await create()];
  const blob = "A".repeat(5 * 1024 * 1024 - 1000);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => {
      const v = vaults[i % 3];
      return call("PUT", `/v1/vaults/${v.id}/snapshot`, v.token, { upToSeq: 0, blob }).then((r) => r.status);
    })
  );
  assert.ok(results.includes(204));
  assert.ok(results.includes(503));
  // the budget is free again afterwards
  assert.equal((await push(vaults[0], [op(1)])).status, 200);
});
