/**
 * Fixed-window rate limits stored in the database (rate_limits), so they hold across restarts and
 * across the web server and worker processes.
 */
import type { Sql } from "./db";

export const LIMITS = {
  login_ip: { limit: 20, windowSeconds: 600 },
  login_account: { limit: 8, windowSeconds: 900 },
  ingest: { limit: 120, windowSeconds: 60 },
  response: { limit: 20, windowSeconds: 3600 },
} as const;
export type LimitBucket = keyof typeof LIMITS;

export async function hitLimit(sql: Sql, bucket: LimitBucket, key: string, now = new Date()): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const rule = LIMITS[bucket];
  const windowStart = new Date(Math.floor(now.getTime() / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000).toISOString();
  const row = (
    await sql.query<{ count: number; window_start: string }>(
      `insert into rate_limits (bucket, key, window_start, count) values ($1, $2, $3, 1)
       on conflict (bucket, key) do update set
         count = case when rate_limits.window_start = excluded.window_start then rate_limits.count + 1 else 1 end,
         window_start = excluded.window_start
       returning count, window_start`,
      [bucket, key, windowStart],
    )
  )[0]!;
  const retry = Math.ceil((Date.parse(row.window_start) + rule.windowSeconds * 1000 - now.getTime()) / 1000);
  return { allowed: row.count <= rule.limit, retryAfterSeconds: Math.max(1, retry) };
}

/** Clears an account's failure counter after a successful sign-in. */
export async function resetLimit(sql: Sql, bucket: LimitBucket, key: string) {
  await sql.query("delete from rate_limits where bucket = $1 and key = $2", [bucket, key]);
}
