# Deployment

How to run `jsonl-tools` (the sharing server) in production. See
`docs/ARCHITECTURE.md` for how it works.

## Requirements

- **PostgreSQL** reachable from the app (the app talks to it over the network).
- **HTTPS** in front of the app — non-negotiable: the browser's Web Crypto API
  only works in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).
  TLS is normally terminated by your reverse proxy / platform.
- **Bun** 1.3.x (the Docker image bundles it).
- A **GitHub OAuth App** — only if you want sign-in / durable history (Phase B).
  Anonymous sharing (Phase A) needs none.

## Environment variables

Read from the container/process environment. **Never** prefix a secret with
`BUN_PUBLIC_` — that prefix inlines a value into the browser bundle.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/db`. Keep the DB on a private network. |
| `PORT` | no (default 3000; Docker image sets 3987) | Port the server listens on. |
| `NODE_ENV` | recommended `production` | Disables HMR/dev bundling. |
| `IP_HASH_SALT` | yes (prod) | Long random secret; salts the stored uploader/reporter IP hashes. |
| `TRUSTED_PROXY` | yes behind a proxy | Set to `1` so the client IP is read from the **right-most** `X-Forwarded-For` hop. Without it, rate limiting and IP hashing key on the proxy's IP. |
| `TRUSTED_PROXY_HOPS` | no | Number of trusted proxies if you chain more than one (overrides `TRUSTED_PROXY`). |
| `GITHUB_CLIENT_ID` | Phase B | From the GitHub OAuth App. |
| `GITHUB_CLIENT_SECRET` | Phase B | From the GitHub OAuth App. |
| `OAUTH_REDIRECT_URI` | Phase B | `https://<your-domain>/api/auth/callback` — must match the OAuth App's callback exactly. |
| `OPERATOR_GITHUB_IDS` | no | Comma-separated GitHub **numeric** user ids allowed to view `/admin/analytics`. Keyed on the immutable id, not the login. Unset = the dashboard is reachable by nobody. |
| `EVENTS_RETENTION_DAYS` | no (default 90) | Retention window for raw usage events; the analytics sweeper purges older rows. |

## Database & migrations

The app uses a hand-rolled, **append-only, checksummed** migration runner. Apply
migrations on every deploy:

```bash
bun run migrate        # applies any unapplied migrations/*.sql
```

- The schema ships as a single baseline file, `001-schema.sql` — the squashed
  end state of the original 001..011 history. A fresh database is brought fully
  up to date by this one file.
- Migrations are **never edited after they ship** — new schema goes in a new
  numbered file (`002-*.sql`, ...). The runner records a checksum per file and
  fails loudly if an applied file changed.
- Each migration's DDL + ledger row commit in one transaction, so a crash
  mid-apply resumes cleanly.

> **Upgrading a database that already ran the old `001..011` files:** do **not**
> run the baseline against it — the tables already exist and `bun run migrate`
> would fail trying to recreate them. Seed the ledger so the runner skips the
> baseline, then carry on as normal. The runner keys each row on the file's
> SHA-256 (hex) of its raw bytes, so compute that and insert it:
>
> ```bash
> CK=$(shasum -a 256 src/server/migrations/001-schema.sql | cut -d' ' -f1)
> psql "$DATABASE_URL" -c \
>   "INSERT INTO schema_migrations (filename, checksum) VALUES ('001-schema.sql', '$CK')"
> ```
>
> Fresh databases need none of this — `bun run migrate` just applies the baseline.

## Deploy options

### A. Docker Compose (simplest self-host)

```bash
docker compose up --build      # app on :3987, Postgres on :5487
```

Compose runs migrations on startup, then serves the app. For production, set real
values in a `.env` file next to `docker-compose.yml` (compose reads it):

```dotenv
POSTGRES_PASSWORD=<strong>
IP_HASH_SALT=<long-random>
GITHUB_CLIENT_ID=<id>
GITHUB_CLIENT_SECRET=<secret>
# OAUTH_REDIRECT_URI is set per your domain; if you front compose with a proxy,
# add TRUSTED_PROXY=1 to the app service env.
```

You still need a TLS-terminating reverse proxy in front (see
[Reverse proxy & TLS](#reverse-proxy--tls)). For a public deploy, **drop the `db`
`ports:` mapping** so Postgres stays internal.

### B. Generic (bun behind any reverse proxy)

```bash
bun install --production
bun run migrate
NODE_ENV=production PORT=3000 bun src/index.ts
```

Front it with nginx/Caddy/Traefik for TLS and the security headers below.

## GitHub OAuth App setup

GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**:

- **Homepage URL:** `https://<your-domain>`
- **Authorization callback URL:** `https://<your-domain>/api/auth/callback`
- Copy the **Client ID** and generate a **Client secret** → set
  `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `OAUTH_REDIRECT_URI`.

Scope used is `read:user` (stable numeric id only). The flow uses PKCE + a state
cookie; no tokens are persisted.

## Reverse proxy & TLS

The proxy is responsible for TLS **and** for the transport-security headers the
app does not yet emit itself. Recommended headers on responses:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'self'; object-src 'none'; base-uri 'none';
                         frame-ancestors 'none'; connect-src 'self'; form-action 'self'
Cache-Control: no-store        # at least on /api/shares/* and /api/account*/history*
```

Notes:

- The CSP must not allow third-party origins — that is the main XSS mitigation
  for the device-local keys. Confirm the bundle ships no inline scripts before
  enforcing `script-src 'self'` without `'unsafe-inline'`.
- Set `TRUSTED_PROXY=1` (and `TRUSTED_PROXY_HOPS` if you chain proxies) so the
  app trusts the correct `X-Forwarded-For` hop.
- `maxRequestBodySize` is capped in the app (6 MB); you may want a smaller proxy
  body limit too.

## Scheduled jobs (sweepers)

Two batched, single-flight jobs are **not auto-scheduled** by the image — you
must run them on an interval (cron, a scheduled task, or a sidecar).
Each takes a Postgres advisory lock (distinct keys), so overlapping runs are
harmless.

**Expiry sweeper** — expiry is enforced lazily on read, but tombstoned rows are
physically purged here:

```bash
bun run src/server/sweeper.ts          # every 5–15 minutes
```

**Analytics retention purge** — deletes raw `events` older than the retention
window (`EVENTS_RETENTION_DAYS`, default 90). The ~90-day privacy bound holds
**only if you schedule this**; without it, events accumulate unbounded:

```bash
bun run src/server/analytics-sweeper.ts   # daily is plenty
```

## Operations

- **Backups:** back up PostgreSQL regularly. Note that a DB backup is useless for
  reading content (zero-knowledge), but losing it loses everyone's shares/history.
- **Monitoring:** watch error/latency on `/api/shares*`, `/api/auth/*`,
  `/api/account*`, `/api/history*`; `429`/`503` volume (rate limits / capacity);
  sweeper `expired`/`purged` counts; DB connection-pool saturation and table
  growth.
- **Abuse takedown:** the server cannot read content, so takedown is
  report-driven. Reports land in `report_abuse`; an operator removes a share and
  bans an uploader hash via the `takedown(id)` / `banIp(ipHash, reason)`
  functions in `src/server/abuse.ts` (run from a one-off `bun` script). A single
  report never auto-deletes.
- **Privacy/retention:** only salted IP hashes are stored, and they are nulled
  when a share is tombstoned. Tune the anonymous max-TTL and sweeper grace window
  to your retention policy.
- **Scaling:** the rate limiter is **in-memory per process** — for multiple app
  instances, put a shared store (e.g. Redis) behind it or rely on per-instance
  limits plus the global DB cap. Sessions, shares, and keys are all in Postgres,
  so the app itself is otherwise stateless.

## Health checks

`GET /` returns the SPA (200) once the server is up. For a deeper check, a
`GET /api/shares/<random-id>` returns the opaque `404 unavailable`, which
exercises a DB query.

## Upgrades

1. Deploy the new image.
2. Run `bun run migrate` (idempotent; applies only new files).
3. Restart the app. Migrations are append-only, so rolling deploys are safe as
   long as new code tolerates the previous schema during the window.
