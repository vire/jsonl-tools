-- Baseline schema (squashed 2026-06-17). This single file is the end state of the
-- original 001..011 migration history, folded into one. It is the canonical
-- starting point for a fresh database.
--
-- Append-only rules still apply: never edit this file after it has been applied
-- anywhere — new schema goes in a new numbered file (002-*.sql, ...). The runner
-- (migrate.ts) records a checksum per file and fails loudly if an applied file
-- changes.
--
-- Note for databases that already ran the old 001..011 files: they must NOT
-- re-run this baseline (the tables already exist). Seed the ledger instead —
-- insert a schema_migrations row for `001-schema.sql` so the runner skips it.
-- See docs/DEPLOYMENT.md → "Database & migrations".

-- ── shares ────────────────────────────────────────────────────────────────────
-- Phase-A shares. The owner/expires invariant from the original 001 was dropped
-- in 008 (anonymous shares may now be "never expires"); `state` carries the
-- fourth value `private` added in 010. `uploader_ip_hash` came from 002.
CREATE TABLE shares (
  id               text PRIMARY KEY,
  owner_user_id    bigint,
  ciphertext       bytea,                       -- NULL once tombstoned (deleted/expired)
  iv               text        NOT NULL,
  aad              jsonb       NOT NULL,
  encrypted_title  text,                         -- client-encrypted; server cannot read
  size_bytes       integer     NOT NULL,         -- derived server-side from octet_length(ciphertext)
  state            text        NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  admin_token_hash text        NOT NULL,         -- SHA-256 of the one-time admin token
  uploader_ip_hash text,                         -- salted hash; nulled when tombstoned
  CONSTRAINT shares_state_check
    CHECK (state IN ('active', 'expired', 'deleted', 'private'))
);

-- supports the sweeper and lazy-expiry scans without table locks
CREATE INDEX shares_state_expires_idx ON shares (state, expires_at);

-- ── abuse controls ────────────────────────────────────────────────────────────
-- Abuse reports. share_id FK uses ON DELETE SET NULL so a report survives a
-- takedown of the share it pointed at, for audit.
CREATE TABLE report_abuse (
  id               bigserial   PRIMARY KEY,
  share_id         text        REFERENCES shares(id) ON DELETE SET NULL,
  reason           text,
  reporter_ip_hash text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Operator-managed ban list, keyed by salted IP hash.
CREATE TABLE banned_ips (
  ip_hash    text        PRIMARY KEY,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── accounts + sessions ───────────────────────────────────────────────────────
-- `login` (the GitHub @username) was added in 007; existing rows fill it in
-- lazily on next login. The stable numeric github_id remains the identity key.
CREATE TABLE users (
  id         bigserial   PRIMARY KEY,
  github_id  bigint      NOT NULL UNIQUE,   -- stable numeric GitHub id, not the login
  login      text,                          -- GitHub @username; nullable, filled lazily
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Server-side, revocable sessions. The cookie carries only the random id; the
-- row is the source of truth, so logout and expiry are enforceable server-side.
CREATE TABLE sessions (
  id         text        PRIMARY KEY,        -- random opaque token
  user_id    bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ── zero-knowledge account key custody ────────────────────────────────────────
-- The server stores only wrapped blobs + a verifier + auth tags; never the
-- passphrase, master key, or account key. `recovery_auth_tag` came from 006
-- (authorizes a rotation initiated from the recovery flow).
CREATE TABLE account_keys (
  user_id                bigint      PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kdf                    jsonb       NOT NULL,   -- iterations, salt, hash, version
  wrapped_under_master   jsonb       NOT NULL,   -- account key wrapped by passphrase-derived key
  wrapped_under_recovery jsonb       NOT NULL,   -- account key wrapped by recovery-code-derived key
  verifier               jsonb       NOT NULL,   -- known plaintext under master key (wrong-pass check)
  auth_tag               text        NOT NULL,   -- proof-of-current-passphrase token (one-way)
  recovery_auth_tag      text,                    -- proof-of-current-recovery-code token; nullable
  version                integer     NOT NULL DEFAULT 1,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- ── CLI tokens (per-box ingest) ───────────────────────────────────────────────
-- A per-box bearer token. `token_id` is the non-secret lookup index the CLI
-- sends on every request; `auth_secret_hash` is sha256hex of the high-entropy
-- secret half (the raw secret is shown once and never stored). `wrapped_machine_key`
-- is the box's machine key wrapped under the user's account key (server can't use
-- it). Revoke is soft via `revoked_at` (the row survives so past uploads stay
-- decryptable). Defined before history_keys because that table references it.
CREATE TABLE cli_tokens (
  token_id            text        PRIMARY KEY,        -- non-secret lookup id
  user_id             bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_secret_hash    text        NOT NULL,           -- sha256hex of the auth secret
  wrapped_machine_key jsonb       NOT NULL,           -- machine key wrapped under the account key
  label               text,                            -- human label for the box
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz,                     -- coarsely updated on auth
  revoked_at          timestamptz                      -- soft revoke; NULL = active
);

CREATE INDEX cli_tokens_user_idx ON cli_tokens (user_id);

-- ── durable, zero-knowledge "My History" ──────────────────────────────────────
-- A history entry links a user to a share via the content key wrapped under that
-- user's account key. Cascades keep it consistent: deleting the share (or the
-- user) removes the history row — no orphans.
--
-- `cli_token_id` (from 009) tags a row with the token whose machine key wrapped
-- its content key. NULL = wrapped under the account key (web shares). ON DELETE
-- RESTRICT, NOT SET NULL: SET NULL would silently reclassify a machine-wrapped
-- row as account-wrapped and make it decrypt under the wrong key forever, so a
-- tagged token must not be hard-deletable. Deleting a user still works: both
-- history_keys and cli_tokens cascade from users(id), and Postgres resolves the
-- two cascades consistently so the RESTRICT never blocks it (regression-tested in
-- cli-uploads.test.ts).
CREATE TABLE history_keys (
  user_id             bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_id            text        NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  wrapped_content_key jsonb       NOT NULL,  -- content key wrapped under the account key
  cli_token_id        text        REFERENCES cli_tokens(token_id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, share_id)            -- one entry per (user, share)
);

CREATE INDEX history_keys_cli_token_idx ON history_keys (cli_token_id);

-- ── usage events (anonymous first-party analytics) ────────────────────────────
-- One row per captured API call or page-view. Deliberately minimal and
-- privacy-bounded: NO foreign key to users/sessions and NO IP column, so a row
-- can never be joined back to a stored identity (origin R8). `route` is always a
-- template (`/api/shares/:id`), never a concrete id (origin R4). `session_id` is
-- a client-supplied, surface-scoped, per-browser-session UUID validated upstream
-- (nullable: page-view pings and the key-bearing viewer carry none). `surface`
-- is a fixed label (home/viewer/bulk-analyzer). Capture is best-effort, so this
-- table tolerates gaps by design — it is directional product signal, not a ledger.
CREATE TABLE events (
  id            bigserial   PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),       -- retention purge cutoff
  day           date        NOT NULL DEFAULT current_date, -- dashboard grouping key
  kind          text        NOT NULL CHECK (kind IN ('page_view', 'api')),
  surface       text,                                     -- home | viewer | bulk-analyzer
  route         text,                                     -- template; NULL for page-views
  method        text,                                     -- HTTP method; NULL for page-views
  session_id    text,                                     -- surface-scoped UUID; NULL when absent
  authenticated boolean     NOT NULL                       -- was the request session-authed
);

-- Purge scan (analytics-sweeper deletes oldest-first past the retention window).
CREATE INDEX events_created_at_idx ON events (created_at);

-- Dashboard: top API routes by calls within a date range.
CREATE INDEX events_day_route_idx ON events (day, route);

-- Dashboard: page-views and distinct-session counts per surface within a range.
CREATE INDEX events_day_kind_surface_idx ON events (day, kind, surface);
