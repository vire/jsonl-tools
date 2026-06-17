# jsonl-tools

Browser tools for inspecting Claude Code JSONL session files, plus an
in-progress zero-knowledge sharing layer.

**Docs:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (how it works, the ZK
model, data model, security) · [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (env
vars, migrations, Docker, reverse-proxy hardening, the sweeper).

## Develop

```bash
bun install
bun dev          # hot-reloading dev server (http://localhost:3000)
bun start        # production (NODE_ENV=production)
bun test         # run the test suite
bun run migrate  # apply pending DB migrations
bun run db:reset # wipe the DATABASE_URL database and re-apply all migrations
```

This project was created with `bun init` (Bun v1.3.8). [Bun](https://bun.com) is
a fast all-in-one JavaScript runtime.

### How to develop locally

The server needs a PostgreSQL database (via `DATABASE_URL`); the browser-only
tools (paste / view / analyze) run without one.

**1. Start Postgres and point `.env` at it.** Run a standalone container:

```bash
docker run -d --name jsonl-pg -e POSTGRES_PASSWORD=devpass \
  -e POSTGRES_DB=jsonl -p 5487:5432 postgres:16-alpine
```

Then set `DATABASE_URL` in `.env` (create the file if missing — don't overwrite
an existing `.env` that already holds secrets):

```
DATABASE_URL=postgres://postgres:devpass@localhost:5487/jsonl
```

The **port must match where Postgres actually listens** — the container above
publishes `5487`. A stale port here is the usual cause of a `Connection closed` error from
`bun run migrate`. Bun auto-loads `.env` (it is gitignored); never give a secret
the `BUN_PUBLIC_` prefix — it would be inlined into the browser bundle.

**2. Create or reset the schema.**

```bash
bun run migrate   # apply pending migrations
bun run db:reset  # drop the public schema and re-run every migration from scratch
```

`db:reset` is the quickest way back to a clean DB after a schema change or to
clear test data. It operates on whatever `DATABASE_URL` points to and refuses to
run with `NODE_ENV=production`.

**3. Run the app and the tests.**

```bash
bun dev    # http://localhost:3000, hot reload
bun test   # full suite; server tests need DATABASE_URL set, else they skip cleanly
```

To keep tests off your dev data, point them at a throwaway database:

```bash
DATABASE_URL=postgres://postgres:devpass@localhost:5487/jsonl_test bun test
```

#### Testing the sign-in flow (GitHub OAuth)

The logged-out home and the browser tools need no OAuth. To exercise sign-in, the
generated-passphrase setup, and durable history end-to-end:

1. Create a **GitHub OAuth App** (GitHub → Settings → Developer settings → OAuth
   Apps → New). GitHub allows `localhost` callbacks:
   - **Homepage URL:** `http://localhost:3000`
   - **Authorization callback URL:** `http://localhost:3000/api/auth/callback`
2. Add the credentials to `.env` (alongside `DATABASE_URL`):

   ```bash
   GITHUB_CLIENT_ID=<your id>
   GITHUB_CLIENT_SECRET=<your secret>
   OAUTH_REDIRECT_URI=http://localhost:3000/api/auth/callback
   ```

3. `bun run migrate` (so the `users.login` column exists), then `bun dev`, open
   the app, and click **Sign In**.

**Gotchas**

- Use `http://localhost`, **not** a LAN IP. `localhost` is a secure context, so
  the browser's Web Crypto (passphrase setup/unlock) and the `__Host-` session
  cookie both work; a `192.168.x.x` URL breaks both.
- `OAUTH_REDIRECT_URI`, the OAuth App's callback URL, and the port you serve on
  must match exactly. If `:3000` is taken, run `PORT=3111 bun dev` and change all
  three to `3111`. (`bun dev` defaults to `:3000`; the Docker image serves on
  `:3987`.)

## Sharing & security

A zero-knowledge sharing layer encrypts every session client-side. The full
security model — guarantees, risks, honest non-goals, and per-artifact
capabilities — is maintained as the single source of truth in
**[`docs/public/security.md`](docs/public/security.md)**. The contract in brief:

- **Encryption is client-side.** A session is encrypted in the browser under a
  random AES-256-GCM content key before upload. The server stores only
  ciphertext and never receives the key or the plaintext.
- **The key travels in the URL fragment.** A share link is `…/s/<id>#key=<key>`.
  The `#fragment` is never sent to the server, so the server cannot read shared
  content — anyone with the full link can, in their browser.
- **No third-party script on key-bearing surfaces.** The create and viewer
  surfaces ship as analytics-free bundles (enforced by a build-graph test), so
  no SDK can observe a key or plaintext.
- **Anonymous by default; login is a later durability upgrade.** Anonymous
  shares get a mandatory max lifetime and are rate-limited; a reportable abuse
  path and operator takedown exist.

### What this does NOT protect against (honest non-goals)

- **A malicious or compromised server serving tampered JS.** The same origin
  that holds ciphertext ships the crypto code, so a poisoned client can exfil
  keys. Strict CSP, SRI, `Referrer-Policy: no-referrer`, and HSTS are partial
  mitigations; a pinned native/extension client is the only real escape hatch.
- **Over-sharing.** The link is the capability — anyone you send it to can read
  it. Use short TTLs.
- **Client device compromise.** Keyloggers, malicious extensions, etc. defeat
  any browser crypto.
- **Remembered unlock on a device.** After unlock the account key is, by default,
  persisted on that device (wrapped under a non-extractable WebCrypto key in
  IndexedDB) until sign-out, so returning skips the passphrase. Raw key bytes are
  never stored readable, but a determined local attacker who images the browser
  profile could recover them — inherent to staying unlocked. "Forget this device"
  and sign-out clear it.
- **Remembered shares on the viewer.** When you open a share link, its decryption
  key is saved on that device (in IndexedDB) so you can re-open the bare `/s/<id>`
  later without the full link. The key is stored unencrypted at rest and anyone
  using the same browser profile can re-open shares viewed there; a per-share
  "Forget" control removes it, and a deleted/expired share's key is purged
  automatically. The key is never put back into the URL.
- **Metadata.** The server still sees a share's existence, size, timestamps, and
  (within a short retention window) a salted hash of the uploader IP.

When accounts land (Phase B), durable history uses a passphrase-derived key
hierarchy; a DB dump is then useless only against strong passphrases, and
isolation between logged-in users rests on authorization, not cryptography.

## CLI — `@jsonl-tools/cli`

Push a JSONL file from a headless box (CI, cron, an agent) into your account —
encrypted on the box — and read it later in the web app or pull it back as
plaintext:

```bash
bunx @jsonl-tools/cli upload run.jsonl     # → an id that appears in your My History
```

Mint a per-box token in the web app's **CLI** tab, then `login` on the box. Full
docs: **[`docs/public/cli.md`](docs/public/cli.md)** (commands, credential format,
security model) and **[`docs/public/api.md`](docs/public/api.md)** (HTTP API). The
package source lives in [`cli/`](cli/).

### Publishing (maintainers)

The CLI is a standalone npm package built from `cli/` with `bun build --target=node`
into a single Node-runnable bin. The root app stays `private`; only `cli/` is
published.

```bash
# 1. Authenticate to npm (one-time) — needs access to the @jsonl-tools scope
npm login

# 2. Build + publish from the package directory.
#    prepublishOnly rebuilds dist/ automatically; publishConfig.access is "public",
#    so the scoped package is published publicly.
cd cli
npm version patch          # or minor / major — bumps cli/package.json
npm publish

# 3. Verify
npx @jsonl-tools/cli@latest help
```

First publish of a new scoped name requires the npm org/scope (`@jsonl-tools`) to
exist and your account to be a member. `npm publish --dry-run` previews the
tarball (it should contain only `dist/` + `package.json` + `README.md`).

## Run with Docker

`docker-compose.yml` builds and runs the app only — Postgres is external.
Provide `DATABASE_URL` (and `IP_HASH_SALT`) via the shell or a `.env` file in
this directory; compose fails fast if `DATABASE_URL` is unset.

```bash
docker compose up --build       # app on :3987 (requires DATABASE_URL)
docker compose down             # stop
```

Compose runs migrations on startup, then serves the app. For a local Postgres to
point `DATABASE_URL` at, see "How to develop locally" above.

## Deploy (self-host)

Run the app behind any reverse proxy that terminates TLS — HTTPS is required,
because the browser's Web Crypto only works in a secure context. Postgres is
external. Full options and hardening are in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md); the essentials:

1. **Database:** a PostgreSQL instance the app can reach on a private network.
   Don't expose it publicly. Use its connection string as `DATABASE_URL`.
2. **App:** build the `Dockerfile` (or use `docker-compose.yml`); the container
   serves on **3987**.
3. **Environment variables:**

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `postgres://…@<host>:5432/<db>` — keep the DB on a private network |
   | `IP_HASH_SALT` | a long random secret |
   | `TRUSTED_PROXY` | `1` when the app runs behind a reverse proxy, so the real client IP comes via `X-Forwarded-For` (right-most hop). Without this, rate limiting and uploader-IP hashing would key on the proxy's IP. Use `TRUSTED_PROXY_HOPS=<n>` if you chain extra proxies. |
   | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | from a GitHub OAuth App (Settings → Developer settings → OAuth Apps). Required for sign-in / durable history. |
   | `OAUTH_REDIRECT_URI` | `https://<your-domain>/api/auth/callback` — must match the GitHub OAuth App's callback URL exactly. |
   | `OPERATOR_GITHUB_IDS` | comma-separated GitHub **numeric** user ids allowed to view the usage dashboard at `/admin/analytics`. Server-only; never `BUN_PUBLIC_`. Unset = nobody. |
   | `EVENTS_RETENTION_DAYS` | optional (default `90`). How long raw usage events are kept before the analytics sweeper purges them. |

4. **Start command:** `bun run migrate && bun run start` so migrations apply on
   each deploy (the bare `Dockerfile` CMD is just `bun run start`).
5. **HTTPS:** your reverse proxy terminates TLS and serves HTTPS — that secure
   context is required for the browser's Web Crypto; the app serves plain HTTP
   internally.

Secrets are read from the container environment; never give a secret the
`BUN_PUBLIC_` prefix (it would be inlined into the browser bundle).
