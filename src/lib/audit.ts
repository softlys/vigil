/** VIGIL's own audit log: who changed rules, ran responses, managed users or settings. Append-only. */
import type { Sql } from "./db";

export type AuditActor = { id: string; email: string } | null;

export async function audit(sql: Sql, actor: AuditActor, action: string, target: { type: string; id: string | null } | null, details: Record<string, unknown> = {}, ip: string | null = null) {
  await sql.query("insert into audit_log (actor_id, actor_email, action, target_type, target_id, details, ip) values ($1, $2, $3, $4, $5, $6, $7)", [
    actor?.id ?? null,
    actor?.email ?? null,
    action,
    target?.type ?? null,
    target?.id ?? null,
    JSON.stringify(details),
    ip,
  ]);
}
