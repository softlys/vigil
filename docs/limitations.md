# Limitations

VIGIL is a **demonstration SIEM** for one product, NEXORA. It shows how ingestion, integrity, detection, investigation and controlled response fit together. It is **not** a replacement for Splunk, Elastic Security, Microsoft Sentinel or any general-purpose SIEM.

## What it covers

- **Sources:** NEXORA's security events only (`GET /api/v1/security-events`). No other log sources, agents, syslog, cloud audit logs or endpoint telemetry.
- **Detection coverage:** the 15 rules in [detection-rules.md](detection-rules.md), covering these ATT&CK techniques: T1110, T1110.001, T1110.003, T1078, T1098, T1213, T1550.001, T1567.004, T1190, T1552.005, T1070, T1685.002. Anything NEXORA does not log, VIGIL cannot see.
- **Response:** two playbooks (revoke an API key, disable a user), always with admin approval.

## What it does not do

- **No query language** (KQL, SPL, ES|QL), no ad-hoc aggregations beyond the event explorer filters, no dashboards builder.
- **No correlation across products**, no threat intelligence, no UEBA beyond the per-actor bulk-read baseline, no machine learning.
- **No case management integrations** (Jira, ServiceNow) and no SOAR beyond the two playbooks.
- **No multi-tenancy.** One VIGIL serves one security team; NEXORA organizations appear as separate chains.
- **No MFA or SSO in the app.** It must sit behind an identity-aware proxy with MFA in production.

## Known gaps

- **Visibility depends on NEXORA's logging.** NEXORA records API key activity mainly on failures, so the new-IP rule (VGL-010) sees only failed or denied key use. Successful sign-ins exist only in NEXORA's Supabase mode.
- **Truncation of the newest events** cannot be proven by the chain alone. The heartbeat check (15 minutes) narrows the window.
- **Heartbeat gaps from downtime.** If VIGIL or NEXORA is stopped for more than 15 minutes, a heartbeat-gap alert is expected. The simulator catches up after demo downtime of up to 7 days.
- **Scale.** Detection runs in one worker, event by event, with SQL lookbacks over indexed columns. It has been exercised with thousands of events per day; millions per day would need batching, partitioning and a streaming engine. Backtests are limited to 50,000 events per run.
- **Working hours** for VGL-005 are one fixed window (07–20 UTC, Monday–Friday by default), edited in the rule.
- **Rate limits** for sign-in, ingest and response decisions live in the database and are simple fixed windows.
- **Notifications** have no retry queue: a failed send is logged and not retried.
- **The drill** cannot reproduce failed sign-ins or IDOR probing against NEXORA's demo mode; the simulator covers them.
- **Simulator realism.** The baseline is plausible, not statistically modeled. It does not represent any real organization.
