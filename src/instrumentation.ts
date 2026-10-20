/**
 * Starts the ingestion and detection worker inside the web server when VIGIL_INPROCESS_WORKER is on
 * (the default with the embedded demo database). With PostgreSQL, run `npm run worker` instead.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getConfig } = await import("@/lib/config");
  if (!getConfig().inProcessWorker) return;
  // Builds and tests import the app without wanting background work.
  if (process.env.NEXT_PHASE === "phase-production-build" || process.env.VITEST) return;
  const [{ startWorker }, { getSql }] = await Promise.all([import("@/worker/loop"), import("@/lib/db")]);
  startWorker(getSql, Number(process.env.VIGIL_WORKER_INTERVAL_MS ?? 10_000));
}
