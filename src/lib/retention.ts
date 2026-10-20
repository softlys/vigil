/**
 * Retention: events older than `retention_days` move from `events` to `events_archive` once a day.
 * The events table rejects deletes unless the archive job sets vigil.archiving for its transaction,
 * so no other code path can remove events.
 */
import { audit } from "./audit";
import { getSetting } from "./bootstrap";
import type { Sql } from "./db";

export async function archiveOldEvents(sql: Sql, now: Date, options: { force?: boolean } = {}): Promise<{ archived: number; ran: boolean }> {
  const last = (await sql.query<{ value: { at: string } }>("select value from worker_state where name = 'archive'"))[0]?.value.at;
  if (!options.force && last && now.getTime() - Date.parse(last) < 24 * 3_600_000) return { archived: 0, ran: false };
  const days = Math.max(1, Number(await getSetting<number>(sql, "retention_days")));
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const archived = await sql.tx(async (q) => {
    await q.query("select set_config('vigil.archiving', 'on', true)");
    const moved = await q.query<{ id: number }>("with moved as (delete from events where occurred_at < $1 returning *) insert into events_archive select * from moved returning id", [cutoff]);
    return moved.length;
  });
  await sql.query("insert into worker_state (name, value, updated_at) values ('archive', $1, now()) on conflict (name) do update set value = excluded.value, updated_at = now()", [
    JSON.stringify({ at: now.toISOString(), archived, cutoff }),
  ]);
  if (archived > 0) await audit(sql, null, "retention.archived", { type: "events", id: null }, { archived, cutoff, retention_days: days });
  return { archived, ran: true };
}
