# @jsonl-tools/cli

Push a JSONL file from a server box into your [jsonl-tools](https://jsonl-tools.dev)
account — **encrypted on the box before it leaves** — and read it later in the web
app or pull it back as plaintext. Built for machines with no browser: CI jobs,
cron tasks, production hosts, and agents.

```bash
bunx @jsonl-tools/cli upload run.jsonl
# → 8f3k…Q2   (the upload's id; it now appears in your My History)
```

The file is encrypted client-side under a key the server never sees, stored as
ciphertext, and decryptable only by you. Same zero-knowledge guarantee as the web
share flow, from the command line.

## Install

No install needed — run on demand:

```bash
bunx @jsonl-tools/cli <command>     # Bun
npx  @jsonl-tools/cli <command>     # Node ≥18
```

## Quick start

1. **Mint a token** in the web app: sign in, unlock your account, open the **CLI**
   tab, label the box, **Create token**, and copy the one-time credential.
2. **Seat it** on the box:
   ```bash
   bunx @jsonl-tools/cli login        # paste the credential (stdin)
   ```
3. **Use it:**
   ```bash
   bunx @jsonl-tools/cli upload session.jsonl --title "nightly run"
   bunx @jsonl-tools/cli list
   bunx @jsonl-tools/cli download --out ./pulled
   bunx @jsonl-tools/cli view 8f3k…Q2     # prints an openable web link
   bunx @jsonl-tools/cli delete 8f3k…Q2
   ```

## Configuration

Credential resolution is **flag > env > stored file**:

- `--token <credential>`
- `JSONL_TOOLS_TOKEN`
- the `0600` file written by `login` (`~/.config/jsonl-tools/credentials`)

Other flags: `--base-url <url>` (default `https://jsonl-tools.dev`),
`--allow-insecure` (permit non-HTTPS, local dev only), `--timeout <seconds>`,
`--out <dir>` (download), `--title <text>` (upload).

The base URL **must be HTTPS** — the credential carries a decryption key, so a
cleartext endpoint would leak it.

## Security

- **Zero-knowledge.** Files are encrypted before any network call; the server
  stores ciphertext it can't read. `download`/`view` decrypt locally.
- **The credential carries a decryption key.** Treat it like a password; prefer
  the `0600` file over `--token`/env on shared hosts (those leak into `ps`, shell
  history, and CI logs).
- **Revoke = stop the box.** Revoking a token stops future uploads/reads from that
  box; it does not un-decrypt data already pushed or pulled.

Full docs: **[CLI guide](https://github.com/vire/jsonl-tools/blob/main/docs/public/cli.md)**
· **[HTTP API](https://github.com/vire/jsonl-tools/blob/main/docs/public/api.md)**
· **[Security model](https://github.com/vire/jsonl-tools/blob/main/docs/public/security.md)**

## License

MIT
