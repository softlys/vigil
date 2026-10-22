/**
 * Database access. One small interface over two drivers:
 * - PGlite (embedded PostgreSQL, files in VIGIL_DATA_DIR, default .data/pglite) when DATABASE_URL is
 *   not set: demo mode needs no database server and no credentials.
 * - node-postgres when DATABASE_URL is set (Supabase or any PostgreSQL 15+).
 * Both parse bigint to number and timestamptz to ISO strings, so code never sees driver differences.
 * Migrations in db/migrations run once on first use.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Sql {
  readonly kind: "pglite" | "postgres";
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs a multi-statement script without parameters (migrations). */
  exec(text: string): Promise<void>;
  /** Runs `fn` in a transaction; everything inside commits or rolls back together. */
  tx<R>(fn: (q: Sql) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

const INT8 = 20;
const TIMESTAMPTZ = 1184;
const NUMERIC = 1700;
const toIso = (v: string) => new Date(v).toISOString();

async function pgliteSql(dataDir: string | undefined): Promise<Sql> {
  const { PGlite } = await import("@electric-sql/pglite");
  // PGlite creates its own directory but not missing parents (a fresh checkout has no .data/).
  if (dataDir) mkdirSync(dirname(dataDir), { recursive: true });
  const db = new PGlite(dataDir, { parsers: { [INT8]: (v: string) => Number(v), [TIMESTAMPTZ]: toIso, [NUMERIC]: (v: string) => Number(v) } });
  await db.waitReady;
  const wrap = (q: { query: typeof db.query; exec: typeof db.exec }, inTx: boolean): Sql => ({
    kind: "pglite",
    async query<T>(text: string, params: unknown[] = []) {
      return (await q.query<T>(text, params)).rows;
    },
    async exec(text: string) {
      await q.exec(text);
    },
    async tx<R>(fn: (q: Sql) => Promise<R>) {
      if (inTx) return fn(wrap(q, true));
      return db.transaction((t) => fn(wrap(t as unknown as typeof q, true)));
    },
    async close() {
      if (!inTx) await db.close();
    },
  });
  return wrap(db, false);
}

async function postgresSql(url: string): Promise<Sql> {
  const pg = await import("pg");
  const { Pool, types } = pg.default ?? pg;
  types.setTypeParser(INT8, (v: string) => Number(v));
  types.setTypeParser(TIMESTAMPTZ, toIso);
  types.setTypeParser(NUMERIC, (v: string) => Number(v));
  const pool = new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_SIZE ?? 5) });
  type Client = { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> };
  const wrap = (client: Client, inTx: boolean): Sql => ({
    kind: "postgres",
    async query<T>(text: string, params: unknown[] = []) {
      return (await client.query(text, params)).rows as T[];
    },
    async exec(text: string) {
      await client.query(text);
    },
    async tx<R>(fn: (q: Sql) => Promise<R>) {
      if (inTx) return fn(wrap(client, true));
      const c = await pool.connect();
      try {
        await c.query("begin");
        const result = await fn(wrap(c, true));
        await c.query("commit");
        return result;
      } catch (error) {
        await c.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        c.release();
      }
    },
    async close() {
      if (!inTx) await pool.end();
    },
  });
  return wrap(pool, false);
}

export function migrationsDir(): string {
  return join(/*turbopackIgnore: true*/ process.cwd(), "db", "migrations");
}

/** Applies pending migrations in file-name order. Each file runs in its own transaction. */
export async function migrate(sql: Sql, dir = migrationsDir()): Promise<string[]> {
  await sql.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await sql.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const text = readFileSync(join(dir, file), "utf8");
    await sql.tx(async (q) => {
      await q.exec(text);
      await q.query("insert into schema_migrations (name) values ($1)", [file]);
    });
    applied.push(file);
  }
  return applied;
}

/** Opens a connection for the configured database, without migrating. */
export async function openSql(options: { url?: string; dataDir?: string } = {}): Promise<Sql> {
  const url = options.url ?? process.env.DATABASE_URL;
  if (url) return postgresSql(url);
  const dir = options.dataDir ?? process.env.VIGIL_DATA_DIR ?? join(/*turbopackIgnore: true*/ process.cwd(), ".data", "pglite");
  return pgliteSql(dir === "memory://" ? undefined : dir);
}

const g = globalThis as unknown as { __vigilSql?: Promise<Sql> };

/** The process-wide connection, migrated on first use. */
export function getSql(): Promise<Sql> {
  g.__vigilSql ??= (async () => {
    const sql = await openSql();
    await migrate(sql);
    return sql;
  })().catch((error) => {
    g.__vigilSql = undefined;
    throw error;
  });
  return g.__vigilSql;
}
