-- VIGIL schema. Runs on PostgreSQL 15+ and on PGlite (embedded PostgreSQL used in demo mode).

-- ---------------------------------------------------------------------------
-- Users, sessions, audit
-- ---------------------------------------------------------------------------

create table users (
  id uuid primary key,
  email text not null unique,
  name text not null,
  role text not null check (role in ('analyst', 'admin')),
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table sessions (
  id uuid primary key,
  token_hash text not null unique,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text,
  user_agent text
);
create index sessions_user_idx on sessions (user_id);

-- VIGIL's own audit log: rule changes, response actions, user and settings changes. Append-only.
create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  ip text
);
create index audit_log_at_idx on audit_log (at desc);

-- ---------------------------------------------------------------------------
-- Events (append-only)
-- ---------------------------------------------------------------------------

create table events (
  id bigserial primary key,
  source text not null check (source in ('nexora', 'simulator')),
  simulated boolean not null,
  event_id uuid not null,
  organization_id uuid not null,
  sequence bigint not null,
  occurred_at timestamptz not null,
  category text not null,
  action text not null,
  outcome text not null,
  severity text not null,
  actor_type text not null,
  actor_id text,
  actor_role text,
  source_ip text,
  user_agent text,
  request_id text,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  prev_hash text not null,
  hash text not null,
  -- The event exactly as received (normalized columns above are derived from it).
  raw jsonb not null,
  chain_ok boolean not null,
  ingested_at timestamptz not null default now(),
  unique (source, organization_id, sequence)
);
create index events_time_idx on events (occurred_at desc);
create index events_action_idx on events (action, occurred_at desc);
create index events_actor_idx on events (actor_id, occurred_at desc);
create index events_ip_idx on events (source_ip, occurred_at desc);
create index events_target_idx on events (target_type, target_id);
create index events_event_id_idx on events (event_id);

-- Archived events (retention job): same shape, moved out of the hot table.
create table events_archive (like events including defaults);

-- Events can never be updated, and deleted only by the archive job (which sets vigil.archiving).
create function events_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'events are append-only';
  end if;
  if tg_op = 'DELETE' and coalesce(current_setting('vigil.archiving', true), '') <> 'on' then
    raise exception 'events are append-only; use the archive job';
  end if;
  return old;
end;
$$;
create trigger events_no_update before update on events for each row execute function events_guard();
create trigger events_no_delete before delete on events for each row execute function events_guard();

-- ---------------------------------------------------------------------------
-- Connector and integrity state
-- ---------------------------------------------------------------------------

create table connector_state (
  source text not null,
  organization_id uuid not null,
  last_sequence bigint not null default 0,
  last_hash text not null default '0000000000000000000000000000000000000000000000000000000000000000',
  last_event_at timestamptz,
  last_heartbeat_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  consecutive_failures integer not null default 0,
  next_attempt_at timestamptz,
  events_ingested bigint not null default 0,
  primary key (source, organization_id)
);

create table integrity_findings (
  id bigserial primary key,
  source text not null,
  organization_id uuid not null,
  kind text not null check (kind in ('chain_break', 'sequence_gap', 'heartbeat_gap', 'schema_mismatch')),
  detail text not null,
  sequence bigint,
  event_id uuid,
  detected_at timestamptz not null default now(),
  processed boolean not null default false
);

-- ---------------------------------------------------------------------------
-- Detection
-- ---------------------------------------------------------------------------

create table rules (
  id text primary key,
  version integer not null,
  enabled boolean not null default true,
  definition jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table rule_versions (
  rule_id text not null references rules (id) on delete cascade,
  version integer not null,
  definition jsonb not null,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  primary key (rule_id, version)
);

-- New-value rules remember what they have seen per key.
create table rule_seen_values (
  rule_id text not null,
  key text not null,
  value text not null,
  first_seen_at timestamptz not null,
  primary key (rule_id, key, value)
);

-- Single cursor for the detection engine: the last events.id evaluated.
create table worker_state (
  name text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table incidents (
  id uuid primary key,
  title text not null,
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  status text not null check (status in ('new', 'triaged', 'investigating', 'resolved', 'false_positive')),
  assignee_id uuid references users (id) on delete set null,
  group_key text not null,
  simulated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index incidents_status_idx on incidents (status, updated_at desc);

create table alerts (
  id uuid primary key,
  rule_id text not null,
  rule_version integer not null,
  title text not null,
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  status text not null check (status in ('open', 'closed')),
  dedup_key text not null,
  group_key text not null,
  entity_type text,
  entity_value text,
  mitre jsonb not null default '[]'::jsonb,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  window_ends_at timestamptz not null,
  count integer not null default 1,
  event_ids jsonb not null default '[]'::jsonb,
  summary text not null,
  simulated boolean not null default false,
  incident_id uuid references incidents (id) on delete set null,
  notified_at timestamptz,
  created_at timestamptz not null default now()
);
create index alerts_status_idx on alerts (status, last_seen_at desc);
create index alerts_dedup_idx on alerts (dedup_key, window_ends_at desc);
create index alerts_incident_idx on alerts (incident_id);

create table incident_timeline (
  id bigserial primary key,
  incident_id uuid not null references incidents (id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null check (kind in ('created', 'alert', 'status', 'assign', 'note', 'response')),
  actor_id uuid,
  body text not null,
  data jsonb not null default '{}'::jsonb
);
create index incident_timeline_idx on incident_timeline (incident_id, at);

-- ---------------------------------------------------------------------------
-- Response and notifications
-- ---------------------------------------------------------------------------

create table response_actions (
  id uuid primary key,
  incident_id uuid not null references incidents (id) on delete cascade,
  kind text not null check (kind in ('revoke_api_key', 'disable_user')),
  target_id text not null,
  target_label text,
  status text not null check (status in ('proposed', 'executed', 'failed', 'rejected')),
  proposed_by uuid,
  proposed_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  reason text,
  simulated boolean not null default false,
  request_summary jsonb,
  response_summary jsonb
);
create index response_actions_incident_idx on response_actions (incident_id);

create table notifications (
  id bigserial primary key,
  alert_id uuid,
  channel text not null,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  detail text,
  at timestamptz not null default now()
);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- Login and ingest throttling (persisted so it holds across restarts and processes).
create table rate_limits (
  bucket text not null,
  key text not null,
  window_start timestamptz not null,
  count integer not null,
  primary key (bucket, key)
);
