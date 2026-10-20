/**
 * Deletes the embedded demo database so the next start backfills a fresh simulated history.
 * Stop the web server first: the embedded database is open while it runs.
 * Refuses to touch a PostgreSQL database (DATABASE_URL).
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

if (process.env.DATABASE_URL) {
  console.error("DATABASE_URL is set: demo:reset only deletes the embedded demo database. Reset PostgreSQL yourself.");
  process.exit(1);
}
const dir = process.env.VIGIL_DATA_DIR ?? join(process.cwd(), ".data", "pglite");
if (!existsSync(dir)) {
  console.log(`[vigil] Nothing to reset (${dir} does not exist).`);
} else {
  rmSync(dir, { recursive: true, force: true });
  console.log(`[vigil] Deleted ${dir}. Start the app to backfill a fresh simulated history.`);
}
