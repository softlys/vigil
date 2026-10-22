# Architecture

```
src/
  domain/event-schema.ts   NEXORA security event schema (Zod), canonical JSON, hashing, sealing
  detection/               rule schema, evaluation engine, live (SQL) and in-memory (backtest) history
  simulator/               simulated tenant, baseline generator, attack scenarios, backfill and ticks
  lib/                     database, ingestion and chain checks, connector, alerts/incidents, response,
                           notifications, retention, rate limits, audit, bootstrap, configuration
  worker/                  the worker loop (in-process or `npm run worker`)
  server/                  sessions, server actions, page queries (server-only)
  app/                     pages: overview, events, incidents, alerts, rules, settings, audit, help, login;
                           API: /api/health, /api/ingest/nexora
db/migrations/             SQL schema (PostgreSQL 15+, also runs on PGlite)
rules/                     built-in detection rules (JSON, versioned in Git)
```

## Data flow

1. **Sources** write NEXORA security events into one pipeline:
   - the **connector** polls NEXORA (`?after=<last sequence>&limit=<page>`)
   - the **push receiver** accepts signed batches
   - the **simulator** generates events in demo mode
2. **Ingestion** (`lib/ingest.ts`) validates each event with the Zod schema. It then checks, against the stored tail of that source and organization:
   - sequence continuity
   - the `prev_hash` link
   - the content hash

   It appends the event (raw and normalized) and records **integrity findings**. Re-delivered sequences are ignored, so polling and pushing can overlap safely.
3. **Detection** (`detection/live.ts`) evaluates enabled rules on events after a durable cursor (`worker_state.detection`), in id order. Integrity findings become alerts for the integrity rule.
4. **Alerts** (`lib/alerts.ts`) are deduplicated per rule and entity within the rule's dedup window. They are grouped into an open **incident** about the same entity from the last 24 hours, or open a new one. Simulated and real data never share alerts or incidents.
5. **Notifications** go out once per alert, for alerts at or above the configured severity.
6. **Response** (`lib/response.ts`) is always proposed first, then approved by an admin with a reason, then executed through NEXORA's API.
7. **Retention** moves events older than the retention period to `events_archive` once a day.

## Storage

All state is in PostgreSQL:

| Table | Contents |
| --- | --- |
| `events` | Append-only: triggers reject `UPDATE`, and `DELETE` unless the archive job sets `vigil.archiving` in its transaction |
| `events_archive` | Events past retention |
| `connector_state` | Per-source chain tail and cursor |
| `integrity_findings` | Chain, gap, heartbeat and schema problems |
| `rules`, `rule_versions` | Rules and their history |
| `rule_seen_values` | Memory for new-value rules |
| `alerts`, `incidents`, `incident_timeline` | Detection results and investigation |
| `response_actions` | Proposed and decided responses |
| `notifications` | Notification attempts |
| `users`, `sessions` | Accounts and sessions |
| `audit_log` | VIGIL's own audit log (append-only by convention) |
| `settings` | Retention and notification settings |
| `rate_limits` | Login and ingest throttling |
| `worker_state` | Cursors and job state |

Two drivers sit behind one small interface (`lib/db.ts`):

| Driver | When it is used | Behavior |
| --- | --- | --- |
| node-postgres | `DATABASE_URL` is set | Normal connection pool |
| PGlite | Otherwise | Embedded PostgreSQL in `.data/pglite`. Only one process can open it, so the web server runs the worker itself (`instrumentation.ts`) |

Both parse `bigint` as numbers and `timestamptz` as ISO strings.

## Worker

Each tick (every 10 s by default) runs these steps in order:
1. simulator (backfill on first run, then baseline up to now, catching up after downtime)
2. connector poll (when configured and due)
3. live heartbeat-gap check
4. detection, then integrity alerts
5. notifications
6. retention (daily)

Ticks, on-demand scenario runs and manual polls share a process lock, so nothing appends to a chain or advances a cursor concurrently.

## Security of VIGIL itself

- **Authentication everywhere.** `proxy.ts` sends requests without a session to `/login`, and every page and action checks the session on the server. Roles are `analyst` and `admin`, and admin-only actions are checked on the server for every call (`server/action.ts`, `requireAdmin`).
- **Sessions.** A random 256-bit token is stored as SHA-256. The cookie is httpOnly and SameSite=Strict (secure in production). Sessions last 12 hours and end when a user is deactivated.
- **Passwords.** Stored with scrypt. Sign-in uses the same message for unknown and wrong credentials and a constant-time comparison against a dummy hash. Each failure slows the next answer; after 5 failures an account is locked for 15 minutes. Unknown emails follow exactly the same path (`login_failures`): same number of attempts, same delays, same messages, so neither the lock nor the timing reveals which accounts exist, and an IP gets at most 20 attempts in 10 minutes. Passwords set by an admin (new users, resets, the bootstrap admin) must be changed at the next sign-in, and changing a password signs out the user's other sessions.
- **Mutations.** Server actions check the `Origin` header in addition to SameSite cookies, parse input with strict Zod schemas, and return safe errors with a reference.
- **Headers.**
  - A per-request **CSP** with a nonce: `script-src 'nonce-…' 'strict-dynamic'`, `frame-ancestors 'none'`, `object-src 'none'`. Inline style attributes are allowed for Radix and Recharts positioning.
  - HSTS, `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, COOP, Permissions-Policy.
- **Secrets.** NEXORA keys, the ingest secret and notification secrets live in server environment variables only. The UI shows whether they are set, never their values. Read and respond keys are separate.
- **Audit.** VIGIL logs its own sensitive actions: sign-ins, rule changes, response proposals and decisions, user and settings changes, simulator runs, archive jobs and connector tests.
- **MFA.** Required for production but not implemented in VIGIL itself. Put VIGIL behind an identity-aware proxy or SSO with MFA (see [deployment.md](deployment.md)).
