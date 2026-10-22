/**
 * First-start setup: built-in rules, default settings and the first users.
 * - Demo mode: two demo accounts (admin and analyst) with a demo password (VIGIL_DEMO_PASSWORD,
 *   default shown on the login page). Demo mode must never hold real data.
 * - Production mode: no default accounts. The first admin comes from VIGIL_ADMIN_EMAIL and
 *   VIGIL_ADMIN_PASSWORD (at least 12 characters) when the users table is empty.
 */
import { randomUUID } from "node:crypto";
import { getConfig } from "./config";
import type { Sql } from "./db";
import { hashPassword } from "./passwords";
import { seedRules } from "./rules-store";

export const DEMO_USERS = [
  { email: "admin@vigil.example", name: "Ada Admin", role: "admin" as const },
  { email: "analyst@vigil.example", name: "Sam Analyst", role: "analyst" as const },
];

export function demoPassword(): string {
  return process.env.VIGIL_DEMO_PASSWORD || "vigil-demo-2026";
}

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  retention_days: 90,
  notify_min_severity: "high",
  notify_simulated: false,
};

export async function bootstrap(sql: Sql): Promise<{ users: number; rules: number }> {
  const config = getConfig();
  const rules = await seedRules(sql);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await sql.query("insert into settings (key, value) values ($1, $2) on conflict (key) do nothing", [key, JSON.stringify(value)]);
  }
  let users = 0;
  if (config.mode === "production") {
    // Demo accounts have a published password: they never stay usable in production mode.
    const disabled = await sql.query("update users set active = false where email = any($1::text[]) and active returning id", [DEMO_USERS.map((u) => u.email)]);
    if (disabled.length) {
      await sql.query("delete from sessions where user_id = any($1::uuid[])", [disabled.map((r) => (r as { id: string }).id)]);
      console.warn(`[vigil] Production mode: deactivated ${disabled.length} demo account(s).`);
    }
  }
  const existing = (await sql.query<{ n: number }>("select count(*)::int as n from users"))[0]!.n;
  if (existing === 0) {
    if (config.mode === "demo") {
      const hash = await hashPassword(demoPassword());
      for (const u of DEMO_USERS) {
        await sql.query("insert into users (id, email, name, role, password_hash) values ($1, $2, $3, $4, $5) on conflict (email) do nothing", [randomUUID(), u.email, u.name, u.role, hash]);
        users += 1;
      }
    } else {
      const email = process.env.VIGIL_ADMIN_EMAIL?.trim().toLowerCase();
      const password = process.env.VIGIL_ADMIN_PASSWORD ?? "";
      if (email && password.length >= 12) {
        // The bootstrap password lives in the environment, so it must be replaced at first sign-in.
        await sql.query("insert into users (id, email, name, role, password_hash, must_change_password) values ($1, $2, 'Administrator', 'admin', $3, true)", [randomUUID(), email, await hashPassword(password)]);
        users += 1;
      } else {
        console.warn("[vigil] No users exist. Set VIGIL_ADMIN_EMAIL and VIGIL_ADMIN_PASSWORD (12+ characters) to create the first admin.");
      }
    }
  }
  return { users, rules };
}

export async function getSetting<T>(sql: Sql, key: string): Promise<T> {
  const row = (await sql.query<{ value: T }>("select value from settings where key = $1", [key]))[0];
  return (row?.value ?? DEFAULT_SETTINGS[key]) as T;
}
