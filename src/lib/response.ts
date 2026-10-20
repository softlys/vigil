/**
 * Response playbooks: revoke an API key or disable a user in NEXORA.
 * - Anyone can propose an action on an incident; only an admin can approve or reject it, and both
 *   require a reason. There is no automatic destructive response anywhere in VIGIL.
 * - Approval executes through NEXORA's security-actions API with the respond key
 *   (NEXORA_RESPONSE_API_KEY, scope security:respond), separate from the read key.
 * - Simulated incidents never call NEXORA: the action is recorded as a simulated execution.
 * - The request and response summary (never the key) goes to the incident timeline and audit log.
 */
import { randomUUID } from "node:crypto";
import { audit, type AuditActor } from "./audit";
import { getConfig, type VigilConfig } from "./config";
import type { Sql } from "./db";

export type ResponseKind = "revoke_api_key" | "disable_user";

export const PLAYBOOKS: Record<ResponseKind, { label: string; path: string; field: "api_key_id" | "user_id"; description: string }> = {
  revoke_api_key: {
    label: "Revoke API key",
    path: "/api/v1/security-actions/revoke-api-key",
    field: "api_key_id",
    description: "Revokes the key in NEXORA immediately. Integrations using it stop working until a new key is issued.",
  },
  disable_user: {
    label: "Disable user",
    path: "/api/v1/security-actions/disable-user",
    field: "user_id",
    description: "Disables the NEXORA account. NEXORA refuses to disable the last active admin.",
  },
};

export class ResponseError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function proposeResponse(sql: Sql, input: { incidentId: string; kind: ResponseKind; targetId: string; targetLabel: string | null; actor: NonNullable<AuditActor> }): Promise<string> {
  if (!UUID.test(input.targetId)) throw new ResponseError("The target must be a NEXORA user or API key id (UUID).");
  const incident = (await sql.query<{ id: string; simulated: boolean; status: string }>("select id, simulated, status from incidents where id = $1", [input.incidentId]))[0];
  if (!incident) throw new ResponseError("Incident not found.");
  const pending = await sql.query("select 1 from response_actions where incident_id = $1 and kind = $2 and target_id = $3 and status = 'proposed'", [input.incidentId, input.kind, input.targetId]);
  if (pending.length) throw new ResponseError("This action is already waiting for approval.");
  const id = randomUUID();
  await sql.tx(async (q) => {
    await q.query("insert into response_actions (id, incident_id, kind, target_id, target_label, status, proposed_by, simulated) values ($1, $2, $3, $4, $5, 'proposed', $6, $7)", [
      id,
      input.incidentId,
      input.kind,
      input.targetId,
      input.targetLabel,
      input.actor.id,
      incident.simulated,
    ]);
    await q.query("insert into incident_timeline (incident_id, kind, actor_id, body, data) values ($1, 'response', $2, $3, $4)", [
      input.incidentId,
      input.actor.id,
      `Proposed: ${PLAYBOOKS[input.kind].label} ${input.targetLabel ?? input.targetId}. Waiting for admin approval.`,
      JSON.stringify({ response_id: id, kind: input.kind, target_id: input.targetId, status: "proposed" }),
    ]);
  });
  await audit(sql, input.actor, "response.proposed", { type: "response_action", id }, { incident_id: input.incidentId, kind: input.kind, target_id: input.targetId });
  return id;
}

type ActionRow = { id: string; incident_id: string; kind: ResponseKind; target_id: string; target_label: string | null; status: string; simulated: boolean };

export type Executor = (input: { url: string; key: string; body: Record<string, unknown> }) => Promise<{ status: number; body: string }>;

const httpExecutor: Executor = async ({ url, key, body }) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": String(body.idempotency_key) },
    body: JSON.stringify({ ...body, idempotency_key: undefined }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: (await res.text()).slice(0, 2000) };
};

/** Approves and executes a proposed action. Admin-only (checked by the caller), reason required. */
export async function approveResponse(
  sql: Sql,
  input: { actionId: string; reason: string; admin: NonNullable<AuditActor>; config?: VigilConfig; executor?: Executor },
): Promise<{ status: "executed" | "failed"; simulated: boolean }> {
  const reason = input.reason.trim();
  if (reason.length < 5) throw new ResponseError("Give a reason of at least 5 characters.");
  const action = (await sql.query<ActionRow>("select * from response_actions where id = $1", [input.actionId]))[0];
  if (!action) throw new ResponseError("Response action not found.");
  if (action.status !== "proposed") throw new ResponseError(`This action was already ${action.status}.`);
  const playbook = PLAYBOOKS[action.kind];
  const config = input.config ?? getConfig();
  const requestBody = { [playbook.field]: action.target_id, reason: `${reason} (VIGIL incident ${action.incident_id})` };
  const requestSummary = { method: "POST", url: `${config.nexora.url ?? "<NEXORA_URL>"}${playbook.path}`, body: requestBody, headers: ["Authorization: Bearer <respond key, not stored>", "Idempotency-Key"] };

  let status: "executed" | "failed";
  let responseSummary: Record<string, unknown>;
  if (action.simulated) {
    status = "executed";
    responseSummary = { simulated: true, note: "Simulated incident: no request was sent to NEXORA." };
  } else if (!config.nexora.url || !config.nexora.respondKey) {
    status = "failed";
    responseSummary = { error: "NEXORA_URL and NEXORA_RESPONSE_API_KEY (scope security:respond) must be set to run response actions." };
  } else {
    try {
      const res = await (input.executor ?? httpExecutor)({ url: `${config.nexora.url}${playbook.path}`, key: config.nexora.respondKey, body: { ...requestBody, idempotency_key: action.id } });
      status = res.status >= 200 && res.status < 300 ? "executed" : "failed";
      responseSummary = { status_code: res.status, body: res.body };
    } catch (error) {
      status = "failed";
      responseSummary = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  await sql.tx(async (q) => {
    await q.query("update response_actions set status = $2, decided_by = $3, decided_at = now(), reason = $4, request_summary = $5, response_summary = $6 where id = $1", [
      action.id,
      status,
      input.admin.id,
      reason,
      JSON.stringify(requestSummary),
      JSON.stringify(responseSummary),
    ]);
    await q.query("insert into incident_timeline (incident_id, kind, actor_id, body, data) values ($1, 'response', $2, $3, $4)", [
      action.incident_id,
      input.admin.id,
      `${status === "executed" ? "Executed" : "Failed"}${action.simulated ? " (simulated)" : ""}: ${playbook.label} ${action.target_label ?? action.target_id}. Reason: ${reason}`,
      JSON.stringify({ response_id: action.id, status, request: requestSummary, response: responseSummary }),
    ]);
    await q.query("update incidents set updated_at = now() where id = $1", [action.incident_id]);
  });
  await audit(sql, input.admin, `response.${status}`, { type: "response_action", id: action.id }, { kind: action.kind, target_id: action.target_id, reason, simulated: action.simulated, response: responseSummary });
  return { status, simulated: action.simulated };
}

export async function rejectResponse(sql: Sql, input: { actionId: string; reason: string; admin: NonNullable<AuditActor> }): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 5) throw new ResponseError("Give a reason of at least 5 characters.");
  const action = (await sql.query<ActionRow>("select * from response_actions where id = $1", [input.actionId]))[0];
  if (!action) throw new ResponseError("Response action not found.");
  if (action.status !== "proposed") throw new ResponseError(`This action was already ${action.status}.`);
  await sql.tx(async (q) => {
    await q.query("update response_actions set status = 'rejected', decided_by = $2, decided_at = now(), reason = $3 where id = $1", [action.id, input.admin.id, reason]);
    await q.query("insert into incident_timeline (incident_id, kind, actor_id, body, data) values ($1, 'response', $2, $3, $4)", [
      action.incident_id,
      input.admin.id,
      `Rejected: ${PLAYBOOKS[action.kind].label} ${action.target_label ?? action.target_id}. Reason: ${reason}`,
      JSON.stringify({ response_id: action.id, status: "rejected" }),
    ]);
  });
  await audit(sql, input.admin, "response.rejected", { type: "response_action", id: action.id }, { reason });
}

/** Candidate targets from an incident's events: NEXORA users and API keys involved. */
export function responseCandidates(events: Array<{ actor_type: string; actor_id: string | null; target_type: string | null; target_id: string | null; action: string }>) {
  const users = new Set<string>();
  const keys = new Set<string>();
  for (const e of events) {
    if (e.actor_type === "user" && e.actor_id) users.add(e.actor_id);
    if (e.actor_type === "api_key" && e.actor_id) keys.add(e.actor_id);
    if (e.target_type === "api_key" && e.target_id) keys.add(e.target_id);
    if ((e.target_type === "account" || e.target_type === "profile") && e.target_id && e.action !== "auth.login_failed") users.add(e.target_id);
  }
  return { users: [...users], keys: [...keys] };
}
