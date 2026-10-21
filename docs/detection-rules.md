# Detection rules

Rules are JSON documents validated by `src/detection/schema.ts`. Built-in rules live in `rules/*.json` and are loaded into the database on first start. Admins can edit, enable, disable and backtest rules in the UI; every save creates a new version (`rule_versions`) and an audit-log entry. Turning a rule off needs a confirmation and a reason; integrity rules (VGL-015) cannot be turned off. Any earlier version can be compared with the current one and restored (restoring saves it as a new version). Backtests replay stored events in the same order and with the same dedup as live detection, and a unit test keeps the two in step.

## Format

Fields common to every rule:

| Field | Meaning |
| --- | --- |
| `id` | `VGL-001`-style id; never changes |
| `title`, `description` | What it detects |
| `severity` | `low`, `medium`, `high` or `critical`: the alert's severity |
| `mitre` | ATT&CK techniques `{id, name, tactic}` |
| `entity` | The field that identifies what the alert is about. Used for dedup and incident grouping |
| `dedup_window` | Repeated hits for the same rule and entity within this window update one alert |
| `false_positives`, `tuning` | Guidance for analysts |

**Filters** (`query`) map a field to a condition. Fields:
- `action`, `category`, `outcome`, `severity`, `organization_id`
- `actor.type`, `actor.id`, `actor.role`
- `source.ip`, `source.user_agent`
- `target.type`, `target.id`
- `metadata.<name>`, `metadata.<name>.<sub>`

Conditions are a literal (equality), `{in}`, `{not_in}`, `{neq}`, `{gte}`, `{lte}`, `{exists}` or `{starts_with}`. Durations look like `90s`, `10m`, `2h` or `7d`; windows are limited to 7 days.

| Type | Extra fields | Fires when |
| --- | --- | --- |
| `single` | optional `outside_hours`, optional `baseline` | A matching event arrives. With `outside_hours`, only outside working hours. With `baseline`, only when a numeric field exceeds `factor` × the actor's median over `lookback`, after `min_samples` samples |
| `threshold` | `group_by`, `window`, `count`, optional `distinct` | At least `count` matching events (or distinct values of `distinct`) share a `group_by` value within `window` |
| `sequence` | `by`, `window`, `steps[]` (`query`, `min_count`, optional `first_seen`) | The steps happen in order for the same `by` value within `window`. `first_seen` requires the last step's value to be new |
| `new_value` | `key`, `value` | A `value` never seen before for this `key`. The first value per key is learned without alerting |
| `integrity` | `kinds` | Ingestion recorded a chain, gap, heartbeat or schema finding |

**Evaluation.** Live detection evaluates each stored event once, in order, and looks back over stored history in SQL. Backtests replay stored events through the same engine in memory (`src/detection/memory.ts`), apply the same dedup, and write nothing.

## ATT&CK verification

Each technique id was opened on attack.mitre.org on 2026-10-20 and its title and tactic recorded. ATT&CK has been restructured since earlier versions:
- "Defense Evasion" is now split into **Stealth** and **Defense Impairment**.
- The former T1562.008 (Disable or Modify Cloud Logs) now redirects to **T1685.002** (Disable or Modify Tools: Disable or Modify Cloud Log), which VIGIL uses.

Re-check the ids when ATT&CK publishes a new version.

## Built-in rules

| Id | Rule | Type | Severity | ATT&CK |
| --- | --- | --- | --- | --- |
| VGL-001 | Brute force against one account | threshold: 8 `auth.login_failed` per `metadata.account_key` in 10m | high | T1110.001 Password Guessing (Credential Access) |
| VGL-002 | Password spraying from one IP | threshold: 6 distinct accounts with `auth.login_failed` per `source.ip` in 30m | high | T1110.003 Password Spraying (Credential Access) |
| VGL-003 | Successful sign-in after repeated failures | sequence by account: ≥5 failures → success within 30m | critical | T1110 Brute Force; T1078 Valid Accounts |
| VGL-004 | IDOR probing: many denied record ids | threshold: 10 distinct `target.id` in `authz.denied` (`reason=not_visible`) per actor in 10m | high | T1213 Data from Information Repositories (Collection) |
| VGL-005 | Role changed to admin outside working hours | single: `role.changed` to admin outside 07–20 UTC, Mon–Fri | high | T1098 Account Manipulation |
| VGL-006 | Admin grant right after the actor was denied access | sequence by actor: ≥2 `authz.denied` → `role.changed` to admin within 30m | critical | T1098; T1078 |
| VGL-007 | API authentication failures burst | threshold: 5 `api.auth_failed` per key prefix in 10m | medium | T1110 |
| VGL-008 | Revoked API key used | single: `api_key.used_after_revoke` | high | T1550.001 Application Access Token (Lateral Movement) |
| VGL-009 | API scope denials burst | threshold: 5 `api.scope_denied` per key in 15m | medium | T1550.001 |
| VGL-010 | API key used from a new IP address | new value: `source.ip` per API key | medium | T1550.001 |
| VGL-011 | Bulk read far above the actor's baseline | single + baseline: `data.bulk_read` records > 3× the actor's 7-day median (≥3 samples, ≥500 records) | high | T1213 |
| VGL-012 | Workflow changed, then data sent to a new webhook domain | sequence by organization: `workflow.updated` → `integration.webhook_sent` to a never-seen `metadata.domain` within 2h | high | T1567.004 Exfiltration Over Webhook (Exfiltration) |
| VGL-013 | SSRF attempt blocked | single: `security.ssrf_blocked` | high | T1190 Exploit Public-Facing Application; T1552.005 Cloud Instance Metadata API |
| VGL-014 | Forged cron or webhook request | single: `cron.unauthorized` or `webhook.signature_invalid` | high | T1190 |
| VGL-015 | Security log integrity violation | integrity: chain break, sequence gap, heartbeat gap, schema mismatch | critical | T1070 Indicator Removal (Stealth); T1685.002 Disable or Modify Cloud Log (Defense Impairment) |

### Tuning and known false positives

| Rule | Known false positives | Tuning |
| --- | --- | --- |
| VGL-001 | A script or password manager retrying an outdated password | Raise the count for shared kiosks |
| VGL-002 | A corporate NAT or VPN egress on Monday morning | Exclude known egress IPs with `not_in` on `source.ip` |
| VGL-003 | The real user remembering the password | Compare the success IP with the failure IPs. A different IP is critical |
| VGL-004 | Stale links after records were reassigned | Real enumeration produces dozens of ids |
| VGL-005 | On-call admins in other time zones | Set `utc_offset_minutes` to the main time zone |
| VGL-006 | An admin testing access before granting a role | Use `min_count` 3 on the first step |
| VGL-007 | An integration deployed with a truncated or old key | One host is configuration; many IPs is an attack |
| VGL-008 | A forgotten integration after planned rotation | Escalate if the key was revoked in an incident |
| VGL-009 | A new integration with the wrong scopes | SIEM keys should never be denied |
| VGL-010 | Make or n8n cloud with changing egress IPs | NEXORA records API key activity mainly on failures, so this rule sees only those |
| VGL-011 | Quarter-end exports, migrations | Raise `factor` for exporting roles |
| VGL-012 | A legitimate new integration right after a workflow edit | Keep approved domains in a `not_in` list |
| VGL-013 | A developer pointing a webhook at a local test server (only outside production) | Any hit on metadata addresses needs investigation |
| VGL-014 | A cron or integration using a rotated secret | Correlate with deployments |
| VGL-015 | A NEXORA restore from backup (sequence reset), or the NEXORA cron is not configured (heartbeat) | A chain break never has a benign cause |

## Tests

`tests/unit/rules.test.ts` covers:
- each rule type, with fixtures that should and should not fire
- every built-in rule against its simulator scenario: it fires the expected rules and no others
- a three-day normal baseline, which fires nothing

`tests/unit/pipeline.test.ts` runs each scenario through ingestion and live detection and checks that each expected alert fires exactly once.
