# CLI HTTP API

The HTTP surface the [`@jsonl-tools/cli`](./cli.md) speaks, plus the server-side
entity model behind it. All of it preserves the zero-knowledge guarantee: the
server stores ciphertext and wrapped keys it cannot read.

---

## Entity model

Three tables back the feature. The key chain (account key → machine key → content
key → ciphertext) is described in [`cli.md`](./cli.md#how-the-entities-fit-together);
here is how it maps to storage.

### `cli_tokens` — one per box

Created when an operator mints a token in the web app.

| Column | Meaning |
|---|---|
| `token_id` | Non-secret lookup id (the first part of the credential). Primary key. |
| `user_id` | Owning account. |
| `auth_secret_hash` | `sha256` of the token's auth secret. The raw secret is shown once and never stored. |
| `wrapped_machine_key` | The box's machine key, wrapped under the account key. The server cannot unwrap it. |
| `label`, `created_at`, `last_used_at` | Display metadata. |
| `revoked_at` | Soft revocation. Set → the token is rejected on every bearer endpoint. The row (and its wrapped machine key) survives so past uploads stay decryptable. |

### `shares` — the encrypted payloads

CLI uploads reuse the existing `shares` table. An upload is an **owned**
(`owner_user_id` set), **non-expiring** (`expires_at` NULL) share whose ciphertext
the server stores but cannot read. `view`/`download` fetch the ciphertext via the
existing public `GET /api/shares/:id`.

### `history_keys` — the unified history, tagged by wrapping

One row links a user to a share via the wrapped content key. A nullable
`cli_token_id` tags **how** the content key was wrapped:

- `cli_token_id` **NULL** → wrapped under the **account key** (web shares — the
  existing path, unchanged).
- `cli_token_id` **set** → wrapped under that token's **machine key** (CLI
  uploads).

The web app reads this tag to decrypt both kinds in one My History: it unwraps
each machine key under the account key (once per token), then unwraps content keys
by tag.

---

## Authentication

Two distinct auth modes:

| Mode | Used by | Gate |
|---|---|---|
| **Session** (cookie) | Token mint / list / revoke — browser-only operations | `__Host-` session cookie **+** cross-site (CSRF) rejection |
| **Bearer** (token) | Upload / list / delete from the CLI | `Authorization: Bearer <tokenId>.<authSecret>` |

The bearer header carries `tokenId.authSecret` — **never** the machine key. The
server looks the row up by `token_id`, then compares `sha256(authSecret)` against
the stored hash in constant time (an unknown id and a wrong secret are
indistinguishable, by timing and by response). Bearer routes deliberately **do
not** apply the cross-site/CSRF check: a non-browser client has no `Origin`, and
the bearer secret is the only gate. They take no client-supplied URL and perform
no server-side fetch, so there is no SSRF or confused-deputy surface.

Bearer requests are bounded by a per-IP circuit breaker (before the DB lookup) and
a per-token rate limit of **240 requests/minute**.

---

## Endpoints

### Token management (session-authed)

These run in the web app while the operator is signed in and unlocked.

#### `POST /api/cli/tokens` — mint

Generate a per-box token. The client has already generated the machine key and
wrapped it under the account key.

```jsonc
// request
{ "label": "ci-runner", "wrappedMachineKey": { "iv": "…", "ct": "…" } }

// 201 — the auth secret is returned exactly once
{ "tokenId": "…", "authSecret": "…" }
```

Rejected with `400` if the account isn't set up, or if `wrappedMachineKey` is
malformed; `401` unauthenticated; `403` cross-site.

#### `GET /api/cli/tokens` — list

```jsonc
// 200 — includes revoked tokens (their wrapped machine key is still needed to
// decrypt past uploads). The auth-secret hash is never returned.
{ "tokens": [
  { "tokenId": "…", "label": "ci-runner", "createdAt": "…",
    "lastUsedAt": "…", "revoked": false,
    "wrappedMachineKey": { "iv": "…", "ct": "…" } }
] }
```

#### `DELETE /api/cli/tokens/:id` — revoke

Soft revocation (sets `revoked_at`). Idempotent and opaque — revoking an unknown,
already-revoked, or another user's token returns the same `{ "ok": true }` with no
state change. Stops the box's future operations; does not delete its uploads.

### Uploads (bearer-authed)

These are what the CLI calls.

#### `POST /api/cli/uploads` — upload

```jsonc
// request — ciphertext + a content key wrapped under the box's machine key
{ "id": "<43-char base64url>", "v": 1, "iv": "…", "ct": "<base64url ciphertext>",
  "encryptedTitle": "…|null",
  "wrappedContentKey": { "iv": "…", "ct": "…" } }

// 201
{ "id": "…" }
```

The client generates `id`. The share row and its tagged `history_keys` row are
written in **one transaction**. Status codes:

| Code | Meaning |
|---|---|
| `201` | Created. Owned, `expires_at` NULL, history row tagged with the token. |
| `400` | Bad request (id not 43-char base64url, missing fields, or ciphertext over the 25 MB ceiling). |
| `401` | Bad / missing / revoked bearer token (opaque). |
| `403` | Banned IP. |
| `409` | The `id` already exists. Opaque (own vs another account's collision are indistinguishable); the transaction rolls back fully, so no history row is written. |
| `429` | Per-token or per-IP rate limit exceeded. |
| `503` | Transient DB error — retryable (distinct from the permanent `409`). |

#### `GET /api/cli/uploads` — list

```jsonc
// 200 — scoped to the authenticating token (the uploads this box can decrypt)
{ "items": [
  { "shareId": "…", "encryptedTitle": "…|null", "sizeBytes": 1421,
    "createdAt": "…", "state": "active",
    "wrappedContentKey": { "iv": "…", "ct": "…" } }
] }
```

#### `DELETE /api/cli/uploads/:id` — delete

Tombstones an owned upload (nulls the ciphertext) and removes its history row, in
one transaction. Ownership is enforced in the query — opaque and idempotent for an
unknown or non-owned id. `{ "ok": true }`.

### Ciphertext fetch (public)

#### `GET /api/shares/:id`

The existing public endpoint. `download` and `view` fetch the stored envelope
here, then decrypt locally with the machine key:

```jsonc
// 200
{ "v": 1, "iv": "…", "ct": "<base64url ciphertext>", "encryptedTitle": "…|null" }
// 404 { "error": "unavailable" }   — unknown / deleted
// 503 { "error": "temporarily_unavailable" } — transient
```

The decryption key is never part of this exchange — it lives only in the CLI (from
the machine key) or in the web link's `#key=` fragment.

---

## Conventions

- **Wrapped key blob:** `{ "iv": "<base64url>", "ct": "<base64url>" }` everywhere a
  key is stored wrapped (machine keys, content keys).
- **Errors:** `{ "error": "snake_case" }` with the matching HTTP status.
- **Opaqueness:** auth, ownership, and existence failures return uniform responses
  so the API never leaks whether a token, id, or share exists.
- **Size:** request body capped at 26 MB; ciphertext at 25 MB.

---

## See also

- [`cli.md`](./cli.md) — the command-line client and the credential format.
- [`security.md`](./security.md) — the project's encryption design, claims, and
  risks.
