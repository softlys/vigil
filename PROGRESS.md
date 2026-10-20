# VIGIL build progress

VIGIL is the security-monitoring companion to NEXORA (prompt 5), in its own repository. It was built in four phases; this file records what was built, what was verified in this session, known issues and decisions.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Ingestion and storage: connector, push receiver, schema validation, append-only events, chain integrity, retention | Done |
| 2 | Detection engine: rule format and types, 15 built-in rules, live evaluation, backtest, dedup | Done |
| 3 | Analyst UI: overview, event explorer with pivots, alerts and incidents, rules, settings | Done |
| 4 | Response and notifications: approved playbooks through NEXORA, email/Slack/webhook | Done |

## Done

### Phase 1: ingestion and storage

- **NEXORA contract.**
  - `src/domain/event-schema.ts` is a copy of NEXORA's security event schema (Zod), canonical JSON and hashing.
  - Every event is validated. A mismatch raises `SchemaMismatchError`, which creates a `schema_mismatch` finding and stops the connector until an admin restarts it.
- **Connector** (`lib/connector.ts`).
  - Polls `?after=<last sequence>&limit=<n>` with the read key, paging until `has_more` is false.
  - The durable cursor is the stored chain tail, so a restart resumes exactly.
  - Exponential backoff from 30 s to 15 min.
  - Health (last poll, success, error, failures, next attempt, stopped reason) is shown on Overview and Settings.
- **Push receiver** `POST /api/ingest/nexora`: HMAC `X-Nexora-Signature` with timestamp tolerance, a 1 MB limit and a rate limit; disabled without `VIGIL_INGEST_SECRET`.
- **Storage.**
  - Append-only `events`: raw plus normalized columns, indexed by time, action, actor, source IP and target. Triggers reject `UPDATE`, and `DELETE` except inside the archive job.
  - Ingestion is idempotent through `unique (source, organization_id, sequence)`.
- **Integrity on ingest.**
  - Findings for: sequence gaps, `prev_hash` mismatches, content hash mismatches, a different event served at an already stored sequence (rewritten history), heartbeat gaps over 15 minutes (historical and live), and schema mismatches.
  - Findings become critical VGL-015 alerts.
- **Retention.** `retention_days` setting; a daily archive job moves old events to `events_archive` (it can also run on demand).
- **Database.** PostgreSQL through node-postgres, or embedded PGlite when `DATABASE_URL` is not set (demo mode needs no database server). Same migrations for both.

### Phase 2: detection

- **Rule format.**
  - JSON, versioned (`rules`, `rule_versions`), inspired by Sigma.
  - Rule types: `single` (optional `outside_hours` and per-actor `baseline`), `threshold` (optional `distinct`), `sequence` (with `min_count` and `first_seen`), `new_value` and `integrity`.
  - Field allowlist, condition operators, durations up to 7 days, ATT&CK id format.
- **15 built-in rules** cover all 11 required detections, with ATT&CK mappings, false positives and tuning notes.
  - Every technique id was checked on attack.mitre.org (2026-10-20).
  - T1562.008 now redirects to T1685.002, which is used instead.
  - ATT&CK's current tactic names (Stealth, Defense Impairment) are used.
- **Live evaluation** in the worker, after a durable cursor, with SQL lookbacks.
- **Backtest** over stored history, in memory with the same engine and dedup and no writes; available in the UI for saved rules and unsaved edits.
- **Dedup and grouping.** One alert per rule and entity within the dedup window. Alerts about the same entity within 24 h form one incident. Simulated and real data are kept apart.

### Phase 3: analyst UI

- **Overview** (computed from stored data): events per bucket with failures, KPIs, open alerts by severity, top rules, top source IPs and actors (with pivots), sources with chain/heartbeat/integrity status, connector and worker status.
- **Event explorer:**
  - time range, action/category/outcome/severity/source filters, free-text search, pagination
  - actor, IP and target pivots
  - an event page with fields, raw JSON, chain position (neighbours with hashes), pivots and related alerts
- **Alerts** list with filters.
- **Incidents** list with filters; an incident page with alerts, related events, timeline, notes, status workflow (resolution note required), assignee, ATT&CK mapping and response.
- **Rules:** a list with enable/disable; a rule page with a JSON editor, validation messages, new versions, version history and backtest.
- **Settings (admin):**
  - connector state and Test connection
  - simulator scenario runner
  - notification channels with test sends, minimum severity and the simulated toggle
  - retention and a manual archive run
  - users (create, role, activate/deactivate; never the last admin or yourself)
- **Audit log** page; **How VIGIL works** page.
- A Simulated banner, plus Simulated labels on events, alerts and incidents.

### Phase 4: response and notifications

- **Playbooks:** revoke API key, disable user.
  - Anyone proposes; only an admin approves or rejects, always with a reason.
  - Execution goes through NEXORA's `security-actions` API with the separate respond key and an `Idempotency-Key`.
  - The request and response summary (never the key) goes to the timeline and audit log.
  - Simulated incidents never call NEXORA.
  - There is no automatic destructive response.
- **Notifications** for alerts at or above the configured severity: Resend email, Slack incoming webhook, generic webhook (HMAC `X-Vigil-Signature`). A channel is active only when its environment variables are set; otherwise it shows "Not configured", and a skipped attempt is logged.

### Security of VIGIL

- Authentication on every page and action (proxy redirect plus a server check).
- Analyst and admin roles enforced on the server.
- Sessions: hashed tokens; cookies httpOnly, SameSite=Strict, Secure in production; 12 h lifetime.
- scrypt passwords; sign-in rate limits per IP and per account; the same error message for unknown and wrong credentials.
- Origin checks on mutations.
- Per-request CSP nonce with `frame-ancestors 'none'`, plus HSTS, `nosniff`, `no-referrer`, `DENY` and COOP.
- Secrets only in server environment variables; separate read and respond keys.
- VIGIL's own audit log.
- MFA documented as a production requirement (identity-aware proxy or SSO).

### Demo mode and drill

- **Simulator.**
  - A fictional tenant (RFC 5737 IPs, `.example` domains).
  - Baseline activity: heartbeats every 5 min, sign-ins with occasional typos, webhooks to known domains, daily exports, rare edits and denials, integration API errors.
  - 11 scripted attack scenarios.
  - Everything is written in NEXORA's schema with a valid chain; the log-tampering scenario deliberately breaks it.
  - First start backfills 3 days with every scenario; later ticks catch up after downtime (up to 7 days).
- **Drill** (`scripts/drill.ts`): live requests against a NEXORA you own. It is guarded to localhost or `DRILL_ALLOWED_HOSTS` and requires `--yes`.

### Docs

- README: what VIGIL is and is not, architecture diagram, screenshots, setup, demo mode, connecting to NEXORA.
- `docs/`: architecture, event-schema, detection-rules, response, drill, deployment, limitations.

## Verified in this session

Commands run from the project root on Windows 11, Node 24.21:

| Check | Result |
| --- | --- |
| `npm run lint` | pass, 0 problems |
| `npm run typecheck` | pass |
| `npm test` | 53 passed (3 files). Covers: every rule type with positive and negative fixtures; every built-in rule against its scenario (no other rule fires); a 3-day baseline fires nothing; chain verification (valid, modified, gap, re-linked, rewritten history, heartbeat gaps); append-only and retention; alert dedup and grouping; each scenario end to end (ingest → detection → expected alerts exactly once); demo backfill fires all 15 rules; connector paging, cursor resume after restart, backoff, schema-mismatch stop; response (simulated, real with fake executor, reason, double decision, missing config); notifications |
| `npm run build` | pass (run by the e2e web server) |
| `npm run test:e2e` | 4 passed against a production build in demo mode: auth on every route and security headers; analyst opens an alert, pivots to the attacker IP, opens raw JSON and chain position, is refused Settings; analyst proposes and admin approves a simulated revoke with a reason (timeline and audit); admin runs a scenario and backtests a rule |
| Live check with NEXORA | NEXORA (local, demo mode, `CRON_SECRET` set) plus VIGIL with real read and respond SIEM keys and the simulator off: 21 real events ingested with an intact chain. `npm run drill -- --yes` raised VGL-007, VGL-009 and VGL-014. Approving Revoke API key from the VGL-009 incident made NEXORA return 401 "This API key was revoked." for the drill key |

The final verification table at the end of the session (below) supersedes these numbers if they differ.

## Known issues

- **No MFA or SSO in the app**; it must sit behind an identity-aware proxy in production.
- **Embedded database** (demo): single process, so the worker runs inside the web server. Use PostgreSQL and `npm run worker` for anything beyond a demo.
- **Coverage depends on what NEXORA logs.**
  - API key activity is recorded mainly on failures, so VGL-010 (new IP) sees only failed or denied use.
  - Successful sign-ins exist only in NEXORA's Supabase mode.
  - The drill cannot reproduce sign-in failures or IDOR in NEXORA demo mode.
- **Heartbeat gaps after downtime** of NEXORA or VIGIL produce integrity alerts. This is by design. The simulator catches up after demo downtime of up to 7 days.
- **Notifications** have no retry queue.
- **Scale**: exercised with thousands of events per day; see `docs/limitations.md`.
- **`npm ci`** prints install-script approval warnings (esbuild, unrs-resolver) with npm 11; everything works.

## Decisions

- **Embedded PostgreSQL for the demo**, real PostgreSQL for production, behind one SQL interface. The demo really needs no credentials or database server, and the same migrations and queries run in both.
- **Integrity before detection.** Chain problems are findings recorded during ingestion, at the event that revealed them. Events are still stored (`chain_ok = false`), so evidence is never discarded.
- **Fail loudly on schema drift.** A contract change stops the connector and raises a critical alert instead of silently skipping events.
- **Rules as JSON**, not YAML: no extra parser, the same Zod schema validates files and UI edits, and every edit is a version.
- **Five rule types.** The prompt's four, plus `integrity` for chain findings. `single` also supports working-hours and per-actor baseline modifiers, which the privilege-escalation and exfiltration rules needed.
- **One alert per rule and entity per window; incidents per entity per 24 h.** Each scenario produces exactly one alert per expected rule, which the tests assert.
- **Human-in-the-loop response only.** Proposals can come from anyone; execution needs an admin and a reason. Simulated incidents never reach NEXORA.
- **Separate read and respond keys.** A leaked polling key cannot revoke keys or disable users.
- **NEXORA change for VIGIL.** NEXORA's security API accepts `after=` as an alias of `after_sequence` (the parameter in the VIGIL contract).
