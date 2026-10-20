/**
 * `npm run worker`: the ingestion and detection worker as its own process. Use it with a
 * PostgreSQL database (DATABASE_URL) and set VIGIL_INPROCESS_WORKER=0 on the web server.
 * With the embedded demo database only one process can open the data directory, so the web server
 * runs the worker itself and this command refuses to start unless forced.
 */
import { bootstrap } from "@/lib/bootstrap";
import { getConfig } from "@/lib/config";
import { getSql } from "@/lib/db";
import { workerTick } from "./loop";

async function main() {
  const config = getConfig();
  if (config.database === "pglite" && !process.argv.includes("--force")) {
    console.error(
      "[vigil-worker] The embedded demo database is opened by the web server, which already runs the worker.\n" +
        "Set DATABASE_URL to run a separate worker, or pass --force when the web server is not running.",
    );
    process.exit(1);
  }
  const sql = await getSql();
  await bootstrap(sql);
  const intervalMs = Number(process.env.VIGIL_WORKER_INTERVAL_MS ?? 10_000);
  console.log(`[vigil-worker] started: database=${config.database} simulator=${config.simulator} connector=${config.nexora.url ? "configured" : "not configured"} interval=${intervalMs}ms`);
  let stopping = false;
  const stop = async () => {
    stopping = true;
    await sql.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  for (;;) {
    const r = await workerTick(sql);
    if (r.simulated || r.polled || r.alertsCreated || r.integrityAlerts || r.errors.length) {
      console.log(`[vigil-worker] ${r.at} simulated=${r.simulated} polled=${r.polled} evaluated=${r.evaluated} alerts=${r.alertsCreated} integrity=${r.integrityAlerts} notified=${r.notified} errors=${r.errors.length}`);
    }
    if (stopping) break;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

main().catch((error) => {
  console.error("[vigil-worker] fatal", error);
  process.exit(1);
});
