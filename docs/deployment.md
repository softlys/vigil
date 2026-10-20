# Deployment

## Topology

| Component | How it runs |
| --- | --- |
| Web app | `npm run build && npm start` (Node.js 20.9+), behind HTTPS |
| Worker | `npm run worker`, a separate long-running process with the same environment and `VIGIL_INPROCESS_WORKER=0` on the web app |
| Database | PostgreSQL 15+ (Supabase, a managed PostgreSQL, or local Docker). Set `DATABASE_URL` for both processes |

Run `npm run db:migrate` once per release (it is idempotent). With PostgreSQL, the web app does not run the worker.

The embedded database (PGlite) is for demos and development only. Only one process can open it, it runs inside the web server, and serverless hosts do not keep its files.

## Environment

All variables are listed with comments in `.env.example`. The essentials for production:

```bash
VIGIL_MODE=production                 # no simulator, no demo accounts
DATABASE_URL=postgres://…
VIGIL_ADMIN_EMAIL=… VIGIL_ADMIN_PASSWORD=…   # first admin (12+ chars), only when no users exist
VIGIL_PUBLIC_URL=https://vigil.example.com
NEXORA_URL=https://nexora.example.com
NEXORA_SECURITY_API_KEY=nxk_siem_…     # security:read
NEXORA_RESPONSE_API_KEY=nxk_siem_…     # security:respond (separate key)
```

Optional:
- notification channels (`RESEND_API_KEY`, `VIGIL_ALERT_EMAIL_FROM`, `VIGIL_ALERT_EMAIL_TO`; `VIGIL_SLACK_WEBHOOK_URL`; `VIGIL_ALERT_WEBHOOK_URL` + `VIGIL_ALERT_WEBHOOK_SECRET`)
- the push receiver (`VIGIL_INGEST_SECRET`)
- polling (`NEXORA_POLL_SECONDS`, `NEXORA_PAGE_SIZE`)

Keep the respond key out of any environment that does not need it. Rotate both keys in NEXORA (**Settings → API keys**) and restart VIGIL.

## NEXORA side

- Create two SIEM keys, one with `security:read` and one with `security:respond`. The admin who creates them must stay active: NEXORA disables keys whose creator is disabled.
- NEXORA must run its scheduler every 5 minutes (`CRON_SECRET` plus a cron calling `/api/cron/scheduler`). VIGIL treats more than 15 minutes without a `system.heartbeat` as an integrity violation.

## Production requirements

- **MFA / SSO.** VIGIL has password sign-in only. In production, put it behind an identity-aware proxy or SSO with MFA (for example Cloudflare Access, Google IAP, Azure AD Application Proxy, or oauth2-proxy with your IdP), and restrict network access to the security team.
- **TLS.** Serve over HTTPS only. VIGIL sends HSTS, a nonce-based CSP with `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and COOP. Session cookies are `Secure` when `NODE_ENV=production`.
- **Database.**
  - Least-privilege credentials.
  - Backups (point-in-time recovery).
  - Consider revoking `UPDATE`/`DELETE` on `events` and `audit_log` from the application role, in addition to VIGIL's triggers.
- **Logs.** The server logs errors with a reference id that is shown to users. Ship them to your log platform.
- **Scale.** Detection evaluates each event against enabled rules with indexed lookbacks. It has been exercised with thousands of events per day, not millions. See [limitations.md](limitations.md).

## Health

`GET /api/health` returns `{"status":"ok"}` when the database answers. It needs no authentication and exposes no details. The overview page shows the worker's last run, connector health, per-source lag and heartbeat age.
