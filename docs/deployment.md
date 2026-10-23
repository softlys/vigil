# Deployment

## Topology

| Component | How it runs |
| --- | --- |
| Web app | `npm run build && npm start` (Node.js 20.9+), behind HTTPS |
| Worker | `npm run worker`, a separate long-running process with the same environment and `VIGIL_INPROCESS_WORKER=0` on the web app |
| Database | PostgreSQL 15+ (Supabase, a managed PostgreSQL, or local Docker). Set `DATABASE_URL` for both processes |

Run `npm run db:migrate` once per release (it is idempotent). With PostgreSQL, the web app does not run the worker.

The embedded database (PGlite) is for demos and development only. Only one process can open it, it runs inside the web server, and serverless hosts do not keep its files.

## Docker Compose (one server)

`deploy/docker-compose.yml` runs the whole stack:

| Service | What it does |
| --- | --- |
| `db` | PostgreSQL 17 with a named volume |
| `migrate` | `npm run db:migrate`, once per start; the app waits for it to succeed |
| `web` | The app on `${VIGIL_PORT:-3300}`, with a health check on `/api/health` |
| `worker` | Ingestion, detection, notifications and their retries |
| `backup` | A compressed dump every 24 hours into `deploy/backups`, keeping the newest 14 |

```bash
cp deploy/.env.example deploy/.env      # fill it in; openssl rand -hex 24 for POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml ps   # migrate: exited (0); web: healthy; worker: running
```

Sign in with `VIGIL_ADMIN_EMAIL`. VIGIL asks for a new password at the first sign-in. Then put it behind TLS and SSO (see below), for example Caddy with `reverse_proxy 127.0.0.1:3300` behind your identity-aware proxy.

CI builds this stack on every push. It checks the migration, the worker, sign-in, the rules and a backup → restore round trip.

## Backups and restore

- **Compose:** the `backup` service writes `deploy/backups/vigil-<UTC time>.dump`. Copy that directory off the server.
- **Elsewhere:** run `scripts/backup.sh <dir>` from cron with `DATABASE_URL` or the `PG*` variables. `BACKUP_KEEP` sets how many dumps are kept.

To restore, stop the web app and the worker, then load the dump. It replaces existing objects:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env stop web worker
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm backup   'pg_restore --clean --if-exists --no-owner --exit-on-error -d vigil /backups/vigil-<time>.dump'
docker compose -f deploy/docker-compose.yml --env-file deploy/.env start web worker
```

Outside Docker: `scripts/restore.sh <file>`.

The events table is append-only and hash-chained: after a restore, **Overview → Integrity checks** shows whether the chain is intact.

## Upgrades and rollback

```bash
git pull
APP_RELEASE=$(git rev-parse --short HEAD) docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
curl -fsS http://127.0.0.1:3300/api/health    # {"status":"ok","release":"<new>"}
```

- The `migrate` service applies new migrations before the app starts.
- Migrations only add tables, columns and indexes. A previous image runs on the newer schema.
- To roll back, start the previous tag:

  ```bash
  APP_RELEASE=<previous> docker compose … up -d --no-build
  ```

- Restore a backup only if data was damaged.

## Environment

All variables are listed with comments in `.env.example`. The essentials for production:

```bash
VIGIL_MODE=production                 # required on servers; no simulator, demo accounts deactivated
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

- **Reverse proxy.** Next.js does not see the TCP peer address; client IPs come from `X-Forwarded-For` as far as `VIGIL_TRUSTED_PROXY_HOPS` proxies vouch for them. Exposed directly, a client can choose its own IP and bypass the per-IP sign-in limit (the per-account lockout still applies).

- **MFA / SSO.** VIGIL has password sign-in only. In production, put it behind an identity-aware proxy or SSO with MFA (for example Cloudflare Access, Google IAP, Azure AD Application Proxy, or oauth2-proxy with your IdP), and restrict network access to the security team.
- **TLS.** Serve over HTTPS only. VIGIL sends HSTS, a nonce-based CSP with `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and COOP. Session cookies are `Secure` when `NODE_ENV=production`.
- **Database.**
  - Least-privilege credentials.
  - Backups: the compose `backup` service or `scripts/backup.sh`, plus point-in-time recovery where your provider offers it.
  - Consider revoking `UPDATE`/`DELETE` on `events` and `audit_log` from the application role, in addition to VIGIL's triggers.
- **Logs.** The server logs errors with a reference id that is shown to users. Ship them to your log platform.
- **Scale.** Detection evaluates each event against enabled rules with indexed lookbacks. It has been exercised with thousands of events per day, not millions. See [limitations.md](limitations.md).

## Health

`GET /api/health` returns `{"status":"ok","release":"…"}` when the database answers (`503` otherwise). It needs no authentication and exposes no details. The overview page shows the worker's last run, connector health, per-source lag and heartbeat age.
