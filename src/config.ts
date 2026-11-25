export interface Config {
  host: string;
  port: number;
  dataDir: string;
  maxBlobBytes: number;
  maxVaultBytes: number;
  // all vaults together, 0 for no limit
  maxTotalBytes: number;
  maxOpsPerRequest: number;
  maxNewVaultsPerDay: number;
  // requests per minute and vault (new vaults and failed logins per ip), 0 disables
  rateLimit: number;
  // delete vaults not used for this many days, 0 keeps them forever
  inactiveDays: number;
  trustProxy: boolean;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number >= 0`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    // only the local proxy should reach the server, docker sets 0.0.0.0
    host: env.HOST || "127.0.0.1",
    port: num(env, "PORT", 8463),
    dataDir: env.DATA_DIR || "./data",
    maxBlobBytes: num(env, "SYNC_MAX_BLOB_BYTES", 1024 * 1024),
    maxVaultBytes: num(env, "SYNC_MAX_VAULT_BYTES", 5 * 1024 * 1024),
    maxTotalBytes: num(env, "SYNC_MAX_TOTAL_BYTES", 2 * 1024 * 1024 * 1024),
    maxOpsPerRequest: 20,
    maxNewVaultsPerDay: num(env, "SYNC_MAX_NEW_VAULTS_PER_DAY", 200),
    rateLimit: num(env, "SYNC_RATE_LIMIT", 120),
    inactiveDays: num(env, "SYNC_INACTIVE_DAYS", 90),
    trustProxy: (env.TRUST_PROXY ?? "true") !== "false",
  };
}
