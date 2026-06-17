# `@jsonl-tools/cli`

Push a JSONL file from a server box into your jsonl-tools account — encrypted on
the box before it leaves — and read it later in the web app or pull it back as
plaintext. Built for machines that have no browser: CI jobs, cron tasks,
production hosts, and agents.

```bash
bunx @jsonl-tools/cli upload run.jsonl
# → 8f3k...Q2   (the upload's id; it now appears in your My History)
```

The file is encrypted **client-side** under a key the server never sees, stored
as ciphertext, and decryptable only by you — in the web app after you unlock your
account, or by this box, which holds its own key. This is the same zero-knowledge
guarantee as the web share flow, reachable from the command line.

---

## How the entities fit together

Four keys form a chain. Each layer wraps (encrypts) the next, and the server only
ever holds the bottom two — neither of which it can read.

```
Account key      your master key. Lives only in the browser, after you unlock
   │             with your passphrase. The server never sees it.
   │  wraps
   ▼
Machine key      one per box. Generated in the browser when you mint a token,
   │             wrapped under the account key (stored server-side), and handed
   │  wraps      to the box inside the credential. The server never sees it raw.
   ▼
Content key      one per upload. Generated on the box, wraps the file. Stored
   │             only wrapped under the machine key.
   │  encrypts
   ▼
Ciphertext       your JSONL, encrypted. This is the only plaintext-adjacent
                 thing the server stores — and it can't decrypt it.
```

The objects you interact with:

| Entity | What it is | Where it lives |
|---|---|---|
| **Token** | A per-box credential: a non-secret id + an auth secret + the raw machine key. Authenticates uploads and authorizes reads. | Minted in the web app; copied to the box. |
| **Upload** | One encrypted JSONL file, owned by your account. Never auto-expires. | Server stores ciphertext; appears in your My History. |
| **My History** | Your unified list of shares — web shares *and* CLI uploads together. | Web app, after unlock. |

Because each box has its own machine key, **a box can decrypt only the uploads it
made.** The web app, holding the account key, can decrypt every box's uploads —
that's why it's the place to see everything together.

---

## Install & run

No install needed — run it on demand:

```bash
bunx @jsonl-tools/cli <command>     # with Bun
npx  @jsonl-tools/cli <command>     # with Node ≥18
```

Node 18+ or Bun is required (the crypto uses the WebCrypto global).

---

## Quick start

1. **Mint a token** in the web app: sign in, unlock your account, open the **CLI**
   tab, give the box a label, and click **Create token**. Copy the credential —
   it is shown once.

2. **Seat the credential** on the box:

   ```bash
   bunx @jsonl-tools/cli login        # paste the credential at the prompt (stdin)
   # → Saved credential to ~/.config/jsonl-tools/credentials
   ```

3. **Upload, then read it back:**

   ```bash
   bunx @jsonl-tools/cli upload session.jsonl --title "nightly run"
   bunx @jsonl-tools/cli list
   bunx @jsonl-tools/cli download --out ./pulled
   bunx @jsonl-tools/cli view 8f3k...Q2     # prints an openable web link
   ```

The upload also shows up in your web **My History** the next time you unlock.

---

## Commands

### `login`

Store a credential on the box so later commands don't need `--token`.

```bash
bunx @jsonl-tools/cli login                 # reads the credential from stdin
echo "$CRED" | bunx @jsonl-tools/cli login  # or pipe it
bunx @jsonl-tools/cli login --token jt1_…    # or pass it inline (see security note)
```

Writes `~/.config/jsonl-tools/credentials` with `0600` permissions inside a `0700`
directory, created atomically (never a world-readable window). Re-running
`login` overwrites it.

### `upload <file | ->`

Encrypt a JSONL file locally and push the ciphertext.

```bash
bunx @jsonl-tools/cli upload run.jsonl
bunx @jsonl-tools/cli upload run.jsonl --title "label shown in My History"
producer | bunx @jsonl-tools/cli upload -          # read JSONL from stdin
```

Prints the new upload's id on success. The file is read verbatim, size-checked
against the **25 MB** ciphertext ceiling (a clear error names the file and limit
if it's too big), encrypted, and uploaded — only ciphertext and a wrapped key
ever leave the box. An optional `--title` is encrypted too; the server can't read
it.

### `list`

List this box's uploads (id, size, created, state).

```bash
bunx @jsonl-tools/cli list
# 8f3k…Q2  1421b  2026-06-05T09:12:00Z  active
```

Scoped to the authenticating token — you see the uploads **this box** made (the
ones it can decrypt). To see every box's uploads together, use the web app.

### `download [--out <dir>]`

Fetch every active upload, decrypt it locally, and write `.jsonl` files.

```bash
bunx @jsonl-tools/cli download                 # into the current directory
bunx @jsonl-tools/cli download --out ./pulled  # into ./pulled (created if missing)
```

Files are named `<id>.jsonl`; an existing file is never silently overwritten (a
numeric suffix is added). Decryption happens entirely on the box — the content
key is never sent to the server. A single failed item (e.g. an upload deleted
between the list and the fetch) is reported to stderr and does not abort the rest;
the command exits non-zero if any item failed.

### `view <id>`

Print an openable web-viewer link for one upload, without downloading it.

```bash
bunx @jsonl-tools/cli view 8f3k…Q2
# → https://jsonl-tools.dev/s/8f3k…Q2#key=<decryption-key>
```

The decryption key is resolved **on the box** and placed in the URL fragment
(after `#`) — it is never sent to the server. Open the link in any browser to
view the JSONL in the standard viewer. (A non-active upload has no link and
errors.)

### `delete <id>`

Permanently remove an upload — tombstones its ciphertext server-side and drops it
from your My History.

```bash
bunx @jsonl-tools/cli delete 8f3k…Q2
```

### `help`

```bash
bunx @jsonl-tools/cli help
```

---

## Configuration

### Credential resolution (precedence)

For every command that talks to the server, the credential is resolved in order —
**flag beats env beats file:**

1. `--token <credential>`
2. `JSONL_TOOLS_TOKEN` environment variable
3. the stored file written by `login`

If none is present, the command tells you to run `login`. A malformed credential
is rejected rather than silently ignored.

### Server URL

Defaults to `https://jsonl-tools.dev`. Override for a self-hosted deployment:

```bash
bunx @jsonl-tools/cli list --base-url https://jsonl.your-host.dev
# or
JSONL_TOOLS_URL=https://jsonl.your-host.dev bunx @jsonl-tools/cli list
```

The URL **must be `https://`** — the credential carries a decryption key, so a
cleartext endpoint would leak it. Pass `--allow-insecure` to use `http://` for
local development only.

### Global flags

| Flag | Effect |
|---|---|
| `--token <credential>` | Credential for this invocation (highest precedence). |
| `--base-url <url>` | Server origin (default `https://jsonl-tools.dev`). |
| `--allow-insecure` | Permit a non-HTTPS `--base-url` (local dev only). |
| `--timeout <seconds>` | Per-request timeout (default 120 s) so a stalled server can't hang the CLI. |
| `--out <dir>` | (`download`) target directory. |
| `--title <text>` | (`upload`) an encrypted title shown in My History. |

### Environment variables

| Variable | Purpose |
|---|---|
| `JSONL_TOOLS_TOKEN` | Credential (precedence: below `--token`, above the file). |
| `JSONL_TOOLS_URL` | Default server URL. |
| `XDG_CONFIG_HOME` | Base for the credential file (`$XDG_CONFIG_HOME/jsonl-tools/credentials`; falls back to `~/.config`). |

---

## The credential

The credential is one opaque string:

```
jt1_<tokenId>.<authSecret>.<machineKey>
```

- **`tokenId`** — non-secret lookup id. The server stores it in plaintext.
- **`authSecret`** — the secret half. Sent only in the `Authorization: Bearer`
  header (as `tokenId.authSecret`); the server stores only its SHA-256 hash.
- **`machineKey`** — raw key bytes. **Never sent to the server.** The box uses it
  to wrap content keys on upload and unwrap them on download/view.

Treat the whole string like a password — it carries decryption capability for
this box's uploads, not just upload permission.

---

## Security model

- **Zero-knowledge.** The file is encrypted before any network call; the server
  stores ciphertext and wrapped keys it cannot read. `download`/`view` decrypt
  locally; the content key never goes over the wire.
- **What the box holds.** The credential file contains the machine key, which can
  decrypt this box's uploads. Protect it (`0600`, owner-only) — and protect any
  plaintext you `download`. Securing a compromised box's local state is the
  operator's responsibility.
- **`--token` and env exposure.** Passing `--token` on the command line leaves the
  credential in `ps` output and shell history; an env var is inherited by child
  processes and often lands in CI logs. Both expose the **machine key** (i.e.
  decryption), not just upload auth. Prefer `login` + the `0600` file for
  long-lived boxes; treat `--token`/env as CI-only.
- **Revocation = stop the box.** Revoke a token from the web app's CLI tab to stop
  *new* uploads, lists, and downloads from that box. It is **not** a clawback:
  uploads already pushed remain decryptable in the web app, and any plaintext the
  box already downloaded is outside the product's reach. If a box's machine key is
  compromised and you need a past upload protected, revoke the token *and* delete
  that upload.
- **Blast radius.** A leaked credential exposes only **that box's** uploads —
  never your web shares and never your account key, which never leaves the
  browser.

---

## Limits & behavior

- **Upload size:** 25 MB of ciphertext per upload (≈ the file size). Larger files
  are rejected client-side with a clear error.
- **Rate limit:** up to 240 token-authed requests per minute per token.
- **Durability:** CLI uploads are owned by your account and do not auto-expire;
  they persist until you `delete` them (from the CLI or the web app). There is no
  per-account quota in this version.
- **Exit codes:** `0` on success; non-zero on error (and on a partial `download`
  where at least one item failed).

---

## See also

- [`api.md`](./api.md) — the HTTP API the CLI speaks, and the server-side entity
  model (tokens, uploads, the unified history tag).
- [`security.md`](./security.md) — the project's encryption design, claims, and
  risks.
