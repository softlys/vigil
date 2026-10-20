import "server-only";
import { headers } from "next/headers";
import { z } from "zod";
import type { Sql } from "@/lib/db";
import { db as getSql } from "./db";
import { getCurrentUser, type CurrentUser } from "./session";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export class ActionError extends Error {}

/** Mutations must come from VIGIL's own origin (in addition to SameSite=Strict cookies). */
async function assertSameOrigin() {
  const h = await headers();
  const origin = h.get("origin");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  let ok = false;
  try {
    ok = Boolean(origin && host && new URL(origin).host === host);
  } catch {}
  if (!ok) throw new ActionError("This request was blocked because it came from another site.");
}

/**
 * Wraps a server action: Origin check, session, role, strict Zod parsing, safe errors.
 * Admin-only actions pass role "admin"; the check runs on the server for every call.
 */
export async function action<S extends z.ZodType, T>(
  options: { schema: S; role?: "analyst" | "admin" },
  input: unknown,
  body: (ctx: { sql: Sql; user: CurrentUser }, data: z.output<S>) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    await assertSameOrigin();
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: "Your session has ended. Sign in again." };
    if (options.role === "admin" && user.role !== "admin") return { ok: false, error: "Only admins can do that." };
    const parsed = options.schema.safeParse(input);
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const i of parsed.error.issues) (fieldErrors[i.path.join(".") || "_form"] ??= []).push(i.message);
      return { ok: false, error: "Please fix the highlighted fields.", fieldErrors };
    }
    return { ok: true, data: await body({ sql: await getSql(), user }, parsed.data) };
  } catch (error) {
    if (error instanceof ActionError) return { ok: false, error: error.message };
    if (error && typeof error === "object" && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_")) throw error;
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[action-error] ref=${ref}`, error);
    return { ok: false, error: `Something went wrong. Reference: ${ref}` };
  }
}
