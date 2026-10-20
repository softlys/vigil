# Live drill

`scripts/drill.ts` sends real, deliberately bad requests to a NEXORA instance **you own**, so you can watch VIGIL ingest the resulting security events and raise alerts.

## Safety rules

- It runs only when `DRILL_TARGET_URL` is `localhost`, `127.0.0.1` or `::1`, or its host is listed in `DRILL_ALLOWED_HOSTS`. Never point it at a system you do not own or are not authorized to test.
- It sends about 20 requests, never brute-forces anything beyond a fixed count, and requires `--yes`.
- The only valid credential it uses is `DRILL_API_KEY`: an **integration** key you create in that NEXORA instance for the drill, with `records:read` and `events:write` but no security scopes. Revoke it afterwards (or let VIGIL's response do it).

## Run it

```bash
# NEXORA running locally with CRON_SECRET set (16+ characters), VIGIL connected to it
DRILL_TARGET_URL=http://localhost:3000 DRILL_API_KEY=nxk_int_… npm run drill -- --yes
```

| Step | NEXORA event | Expected VIGIL alert |
| --- | --- | --- |
| 8 calls with a wrong secret for the drill key's prefix | `api.auth_failed` (reason `wrong_secret`) ×8 | VGL-007 API authentication failures burst |
| 6 calls to `GET /api/v1/security-events` with the integration key | `api.scope_denied` ×6 | VGL-009 API scope denials burst |
| `POST /api/v1/events` with `X-Nexora-Integration: make` and a wrong signature | `webhook.signature_invalid` | VGL-014 Forged cron or webhook request |
| `POST /api/cron/scheduler` with a wrong bearer token | `cron.unauthorized` (only if NEXORA has `CRON_SECRET`; otherwise NEXORA answers 503 and logs nothing) | VGL-014 (same alert, same source IP) |

VIGIL picks the events up within one poll interval (`NEXORA_POLL_SECONDS`, default 15 s). Afterwards, you can open the VGL-009 incident and propose **Revoke API key** for the drill key; an admin approves it with a reason.

**Not covered.** Failed sign-ins and IDOR probing need a browser session in NEXORA's Supabase mode. The simulator covers those patterns instead.

## Verified run (2026-10-20)

Against NEXORA in local demo mode with `CRON_SECRET` set, and VIGIL configured with separate read and respond SIEM keys (simulator off):
- 21 real events were ingested, with the chain intact.
- The drill produced VGL-007 (8 events for the key prefix), VGL-009 (6 events for the key) and VGL-014.
- Approving **Revoke API key** from the VGL-009 incident made NEXORA reject the drill key with 401 "This API key was revoked."
