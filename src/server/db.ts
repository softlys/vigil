import "server-only";
import { bootstrap } from "@/lib/bootstrap";
import { getSql, type Sql } from "@/lib/db";

const g = globalThis as unknown as { __vigilReady?: Promise<Sql> };

/** The migrated database with built-in rules, settings and first users in place. */
export function db(): Promise<Sql> {
  g.__vigilReady ??= getSql()
    .then(async (sql) => {
      await bootstrap(sql);
      return sql;
    })
    .catch((error) => {
      g.__vigilReady = undefined;
      throw error;
    });
  return g.__vigilReady;
}
