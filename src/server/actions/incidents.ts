"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { approveResponse, proposeResponse, rejectResponse, ResponseError } from "@/lib/response";
import { hitLimit } from "@/lib/rate-limit";
import { action, ActionError } from "../action";

const STATUSES = ["new", "triaged", "investigating", "resolved", "false_positive"] as const;

const refresh = (id: string) => {
  revalidatePath(`/incidents/${id}`);
  revalidatePath("/incidents");
  revalidatePath("/");
};

export async function setIncidentStatusAction(input: unknown) {
  return action({ schema: z.object({ id: z.uuid(), status: z.enum(STATUSES), note: z.string().trim().max(2000).default("") }).strict() }, input, async ({ sql, user }, d) => {
    const current = (await sql.query<{ status: string }>("select status from incidents where id = $1", [d.id]))[0];
    if (!current) throw new ActionError("Incident not found.");
    if (current.status === d.status) return undefined;
    const closing = d.status === "resolved" || d.status === "false_positive";
    if (closing && d.note.length < 5) throw new ActionError("Explain the resolution in a note (at least 5 characters).");
    await sql.tx(async (q) => {
      await q.query("update incidents set status = $2, updated_at = now(), resolved_at = $3 where id = $1", [d.id, d.status, closing ? new Date().toISOString() : null]);
      if (closing) await q.query("update alerts set status = 'closed' where incident_id = $1", [d.id]);
      await q.query("insert into incident_timeline (incident_id, kind, actor_id, body, data) values ($1, 'status', $2, $3, $4)", [
        d.id,
        user.id,
        `Status ${current.status.replace("_", " ")} → ${d.status.replace("_", " ")}${d.note ? `: ${d.note}` : ""}`,
        JSON.stringify({ from: current.status, to: d.status }),
      ]);
    });
    await audit(sql, user, "incident.status_changed", { type: "incident", id: d.id }, { from: current.status, to: d.status });
    refresh(d.id);
    return undefined;
  });
}

export async function assignIncidentAction(input: unknown) {
  return action({ schema: z.object({ id: z.uuid(), assignee_id: z.uuid().nullable() }).strict() }, input, async ({ sql, user }, d) => {
    let name = "nobody";
    if (d.assignee_id) {
      const u = (await sql.query<{ name: string }>("select name from users where id = $1 and active", [d.assignee_id]))[0];
      if (!u) throw new ActionError("That user does not exist or is inactive.");
      name = u.name;
    }
    await sql.query("update incidents set assignee_id = $2, updated_at = now() where id = $1", [d.id, d.assignee_id]);
    await sql.query("insert into incident_timeline (incident_id, kind, actor_id, body) values ($1, 'assign', $2, $3)", [d.id, user.id, `Assigned to ${name}`]);
    refresh(d.id);
    return undefined;
  });
}

export async function addNoteAction(input: unknown) {
  return action({ schema: z.object({ id: z.uuid(), body: z.string().trim().min(1, "Write a note").max(4000) }).strict() }, input, async ({ sql, user }, d) => {
    await sql.query("insert into incident_timeline (incident_id, kind, actor_id, body) values ($1, 'note', $2, $3)", [d.id, user.id, d.body]);
    await sql.query("update incidents set updated_at = now() where id = $1", [d.id]);
    refresh(d.id);
    return undefined;
  });
}

export async function proposeResponseAction(input: unknown) {
  return action(
    { schema: z.object({ incident_id: z.uuid(), kind: z.enum(["revoke_api_key", "disable_user"]), target_id: z.string().trim().min(1).max(64), target_label: z.string().max(200).nullable() }).strict() },
    input,
    async ({ sql, user }, d) => {
      try {
        const id = await proposeResponse(sql, { incidentId: d.incident_id, kind: d.kind, targetId: d.target_id, targetLabel: d.target_label, actor: user });
        refresh(d.incident_id);
        return { id };
      } catch (error) {
        if (error instanceof ResponseError) throw new ActionError(error.message);
        throw error;
      }
    },
  );
}

/** Admin approval executes the action against NEXORA (or records it as simulated). */
export async function approveResponseAction(input: unknown) {
  return action({ role: "admin", schema: z.object({ action_id: z.uuid(), incident_id: z.uuid(), reason: z.string().trim().min(5, "Give a reason (at least 5 characters)").max(500) }).strict() }, input, async ({ sql, user }, d) => {
    const limit = await hitLimit(sql, "response", user.id);
    if (!limit.allowed) throw new ActionError("Too many response actions in the last hour.");
    try {
      const result = await approveResponse(sql, { actionId: d.action_id, reason: d.reason, admin: user });
      refresh(d.incident_id);
      return result;
    } catch (error) {
      if (error instanceof ResponseError) throw new ActionError(error.message);
      throw error;
    }
  });
}

export async function rejectResponseAction(input: unknown) {
  return action({ role: "admin", schema: z.object({ action_id: z.uuid(), incident_id: z.uuid(), reason: z.string().trim().min(5, "Give a reason (at least 5 characters)").max(500) }).strict() }, input, async ({ sql, user }, d) => {
    try {
      await rejectResponse(sql, { actionId: d.action_id, reason: d.reason, admin: user });
      refresh(d.incident_id);
      return undefined;
    } catch (error) {
      if (error instanceof ResponseError) throw new ActionError(error.message);
      throw error;
    }
  });
}
