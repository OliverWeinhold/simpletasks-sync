import { accessSync, constants, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { openStore, type Store } from "./db.ts";
import { createSyncServer } from "./server.ts";

const DAY = 24 * 60 * 60 * 1000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const config = loadConfig();
const dataDir = resolve(config.dataDir);
const uid = process.getuid?.();
const owner = uid === undefined ? "the server user" : `uid ${uid}`;

try {
  mkdirSync(dataDir, { recursive: true });
  accessSync(dataDir, constants.W_OK);
} catch {
  // most common docker mistake, the bind mounted folder belongs to root
  fail(`data directory ${dataDir} is not writable for ${owner}, run "chown ${uid ?? 1000}:${uid ?? 1000}" on it`);
}

let store: Store;
try {
  store = openStore(join(dataDir, "sync.db"));
} catch (error) {
  fail(`cannot open ${join(dataDir, "sync.db")}: ${error instanceof Error ? error.message : error}`);
}
const { server, limiter } = createSyncServer(config, store);

function cleanup() {
  if (config.inactiveDays > 0) {
    const removed = store.deleteInactive(Date.now() - config.inactiveDays * DAY);
    if (removed > 0) console.log(`removed ${removed} inactive vault(s)`);
  }
}

cleanup();
const timer = setInterval(cleanup, 60 * 60 * 1000);
// keeps the rate limiter map small even with many different ips
const pruneTimer = setInterval(() => limiter.prune(), 60 * 1000);

server.listen(config.port, config.host, () => {
  console.log(`simpletasks-sync listening on ${config.host}:${config.port}`);
});

function shutdown() {
  clearInterval(timer);
  clearInterval(pruneTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // close() waits for open connections, do not hang forever
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
