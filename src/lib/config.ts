/**
 * Configuration from environment variables. Secrets (NEXORA keys, webhook secrets) are read only
 * on the server and never sent to the browser; the UI shows whether they are set, not their values.
 */

export type VigilConfig = {
  /** demo: simulator on, seeded demo users. production: no default users, real connector expected. */
  mode: "demo" | "production";
  nexora: { url: string | null; readKey: string | null; respondKey: string | null; pollSeconds: number; pageSize: number };
  /** HMAC secret for the optional push receiver POST /api/ingest/nexora. */
  ingestSecret: string | null;
  simulator: boolean;
  /** Run the worker loop inside the web server (default with the embedded database). */
  inProcessWorker: boolean;
  database: "pglite" | "postgres";
};

const bool = (v: string | undefined, fallback: boolean) => (v === undefined || v === "" ? fallback : ["1", "true", "on", "yes"].includes(v.toLowerCase()));

export function getConfig(env: NodeJS.ProcessEnv = process.env): VigilConfig {
  const url = env.NEXORA_URL?.trim() || null;
  const readKey = env.NEXORA_SECURITY_API_KEY?.trim() || null;
  const mode = env.VIGIL_MODE === "production" ? "production" : "demo";
  const database = env.DATABASE_URL ? "postgres" : "pglite";
  return {
    mode,
    nexora: {
      url: url ? url.replace(/\/+$/, "") : null,
      readKey,
      respondKey: env.NEXORA_RESPONSE_API_KEY?.trim() || null,
      pollSeconds: Math.max(5, Number(env.NEXORA_POLL_SECONDS ?? 15)),
      pageSize: Math.min(500, Math.max(10, Number(env.NEXORA_PAGE_SIZE ?? 200))),
    },
    ingestSecret: env.VIGIL_INGEST_SECRET?.trim() || null,
    // The simulator runs in demo mode unless switched off; it never runs in production mode.
    simulator: mode === "demo" && bool(env.VIGIL_SIMULATOR, true),
    inProcessWorker: bool(env.VIGIL_INPROCESS_WORKER, database === "pglite"),
    database,
  };
}

export function connectorConfigured(config = getConfig()): boolean {
  return Boolean(config.nexora.url && config.nexora.readKey);
}
