# Event schema

VIGIL consumes NEXORA's security events exactly as NEXORA defines them. The source of truth is NEXORA's `docs/security-events.md` and `src/domain/security/events.ts`. VIGIL keeps a copy in `src/domain/event-schema.ts`, and **the two must stay in sync**.

## Fields

| Field | Type | Notes |
| --- | --- | --- |
| `event_id` | uuid | Unique per event |
| `organization_id` | uuid | One hash chain per organization |
| `sequence` | integer ≥ 1 | Gap-free per organization |
| `occurred_at` | ISO 8601 with offset | Server time in NEXORA |
| `category` | enum | `authentication`, `authorization`, `configuration`, `data_access`, `integration`, `automation`, `system` |
| `action` | enum | One of the catalog actions, e.g. `auth.login_failed`, `api.scope_denied`, `security.ssrf_blocked` |
| `outcome` | enum | `success`, `failure`, `unknown` |
| `severity` | enum | `info`, `low`, `medium`, `high` (NEXORA's own rating; VIGIL rules set alert severity) |
| `actor` | object | `{type:"user", user_id, role}`, `{type:"api_key", api_key_id}`, `{type:"service", name}` or `{type:"anonymous"}` |
| `source` | object | `{ip, user_agent, request_id}` |
| `target` | object | `{type, id}` |
| `metadata` | object | Event-specific, already redacted by NEXORA (no secrets, no request bodies) |
| `prev_hash`, `hash` | hex(64) | The chain (below) |

## Hash chain

```
hash = SHA-256( prev_hash + canonicalJson(event without prev_hash and hash) )
```

`canonicalJson` sorts object keys recursively, adds no whitespace and drops `undefined`. The first event of an organization has `prev_hash` = 64 zeros.

On ingest, VIGIL checks every event against the last stored event of the same source and organization:

| Check | Finding |
| --- | --- |
| `sequence` is the previous sequence + 1 | `sequence_gap` (events deleted or suppressed) |
| `prev_hash` equals the previous event's `hash` | `chain_break` (events removed and renumbered, or reordered) |
| `hash` matches the recomputed hash | `chain_break` (content modified after it was written) |
| A heartbeat arrives within 15 minutes of the previous one | `heartbeat_gap` (recorded when the late heartbeat arrives, and also while it is still missing) |
| The event parses with the Zod schema | `schema_mismatch` (the connector stops) |

Events are stored even when a check fails (`chain_ok = false`), so the evidence is kept. Every finding raises the integrity rule VGL-015.

**What the chain cannot prove.** It cannot prove that the newest events were not truncated before VIGIL read them. The heartbeat check and VIGIL's stored tail (it notices if NEXORA later serves a shorter or different chain at the same sequence) cover that.

## Normalized columns

Each event is stored as `raw` (exactly as received) and as columns used for filtering and detection:

| Column | Source |
| --- | --- |
| `action`, `category`, `outcome`, `severity` | same fields |
| `actor_type`, `actor_id`, `actor_role` | `actor` (`actor_id` is `user_id`, `api_key_id` or the service name) |
| `source_ip`, `user_agent`, `request_id` | `source` |
| `target_type`, `target_id` | `target` |
| `metadata` | `metadata` (jsonb) |

Detection rules reference these normalized fields as `action`, `actor.id`, `source.ip`, `target.id`, `metadata.<name>` and so on (see [detection-rules.md](detection-rules.md)).

## Where events come from

| Source | How | Label |
| --- | --- | --- |
| NEXORA polling | `GET /api/v1/security-events?after=<last sequence>&limit=<n>` with a SIEM key that has `security:read` | real |
| Push receiver | `POST /api/ingest/nexora`: a JSON array of events, or `{ "events": [...] }`, signed `X-Nexora-Signature: t=<unix>,v1=HMAC-SHA256(VIGIL_INGEST_SECRET, "t.body")`. NEXORA's own outbound webhooks carry business events, not security events, so this receiver is meant for a forwarder | real |
| Simulator | Demo mode; a separate organization id and chain | Simulated |
