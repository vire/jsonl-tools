// CLI help text (plan U7/U8). Pure — no I/O — so cli/index.ts can route to it and
// the help output is unit-testable. Each command carries a one-line `summary` (for
// the top-level listing) plus a fuller `description`, its arguments, flags, and
// runnable examples, so `jsonl-tools <command> --help` tells a human *or an agent*
// exactly what the command does and how to call it.

const BIN = "jsonl-tools";

/** A named thing with a short explanation — used for arguments and flags. */
type Entry = [name: string, description: string];

export interface CommandHelp {
  /** The subcommand token, e.g. `upload`. */
  name: string;
  /** One line shown in the top-level command listing. */
  summary: string;
  /** The invocation form shown under "Usage:". */
  usage: string;
  /** A paragraph (multi-line ok) explaining what the command does and why. */
  description: string;
  /** Positional arguments, in order. */
  args?: Entry[];
  /** Command-specific flags (global flags are documented once, separately). */
  flags?: Entry[];
  /** Copy-pasteable example invocations. */
  examples?: string[];
}

/** Flags accepted by every command. Documented once in the top-level help. */
export const GLOBAL_FLAGS: Entry[] = [
  ["--base-url <url>", `API base (default https://jsonl-tools.dev; must be HTTPS).`],
  ["--token <credential>", `Use this credential instead of the stored file / env var.`],
  ["--allow-insecure", `Permit a non-HTTPS --base-url (local development only).`],
  ["--timeout <seconds>", `Per-request network timeout.`],
];

export const COMMANDS: CommandHelp[] = [
  {
    name: "login",
    summary: "Store a CLI credential on this box (read from stdin).",
    usage: `${BIN} login [--token <credential>]`,
    description:
      "Save the credential this box uses to authenticate later commands, written\n" +
      "owner-only (0600) to ~/.config/jsonl-tools/credentials so you don't pass\n" +
      "--token every time. With no --token flag and no JSONL_TOOLS_TOKEN set, the\n" +
      "credential is read from stdin: on a terminal it prompts you to paste the\n" +
      "one-time token minted in the web app (Account → CLI tab → Create token) and\n" +
      "press Enter; piped input (e.g. `pbpaste | login`) is read to end-of-input. The\n" +
      "credential carries a decryption key, so prefer this stored file over --token /\n" +
      "env on shared hosts (those leak into `ps`, shell history, and CI logs).",
    flags: [["--token <credential>", "Credential to store; skips the stdin prompt."]],
    examples: [
      `${BIN} login                       # prompts; paste the credential, then Enter`,
      `pbpaste | ${BIN} login             # pipe it in from the clipboard`,
      `${BIN} login --token "$JT_TOKEN"   # non-interactive (CI / scripts)`,
    ],
  },
  {
    name: "upload",
    summary: "Encrypt and upload a JSONL file (or stdin); prints the upload id.",
    usage: `${BIN} upload <file|-> [--title <text>]`,
    description:
      "Encrypt a JSONL file on this box and push the ciphertext to your history; the\n" +
      "server stores only data it cannot read. Pass a file path, or `-` to read the\n" +
      "content from stdin. On success it prints the new upload's id (the same id you\n" +
      "see in My History and pass to `view` / `delete`).",
    args: [["<file|->", "Path to a .jsonl file, or `-` to read from stdin."]],
    flags: [["--title <text>", "Human label for the upload (encrypted like the body)."]],
    examples: [
      `${BIN} upload session.jsonl --title "nightly run"`,
      `cat run.jsonl | ${BIN} upload -`,
    ],
  },
  {
    name: "list",
    summary: "List your uploads (id, size, date, state).",
    usage: `${BIN} list`,
    description:
      "Print one line per upload in your history — id, size in bytes, creation\n" +
      "timestamp, and state (active / revoked / …). Prints `(no uploads)` when the\n" +
      "history is empty.",
    examples: [`${BIN} list`],
  },
  {
    name: "download",
    summary: "Decrypt and pull every upload into a directory.",
    usage: `${BIN} download [--out <dir>]`,
    description:
      "Fetch and locally decrypt all of your uploads, writing one plaintext .jsonl\n" +
      "file per upload into --out (default: the current directory). Existing files are\n" +
      "never overwritten — colliding names get a numeric suffix. A failure on one\n" +
      "upload is reported on stderr and does not abort the others.",
    flags: [["--out <dir>", "Destination directory (created if missing; default `.`)."]],
    examples: [`${BIN} download --out ./pulled`],
  },
  {
    name: "view",
    summary: "Print an openable web link for one upload.",
    usage: `${BIN} view <id>`,
    description:
      "Print a shareable web link for one active upload. The decryption key rides in\n" +
      "the URL fragment (after #), which is never sent to the server — open the link\n" +
      "in a browser to read the decrypted content. Errors if the id is unknown or the\n" +
      "upload is not active.",
    args: [["<id>", "An upload id from `list`."]],
    examples: [`${BIN} view 8f3kQ2`],
  },
  {
    name: "delete",
    summary: "Delete one upload from your history.",
    usage: `${BIN} delete <id>`,
    description:
      "Permanently remove one upload from your history by id. This deletes the stored\n" +
      "ciphertext on the server; copies you already downloaded are unaffected.",
    args: [["<id>", "An upload id from `list`."]],
    examples: [`${BIN} delete 8f3kQ2`],
  },
];

const byName = new Map(COMMANDS.map((c) => [c.name, c]));

/** Pad `name` to `width` so a list of name/description pairs aligns in columns. */
function row(name: string, description: string, width: number): string {
  return `  ${name.padEnd(width)}  ${description}`;
}

/** The default help: the tagline, every command with its summary, and global flags. */
export function topLevelHelp(): string {
  const cmdWidth = Math.max(...COMMANDS.map((c) => c.name.length), "help".length);
  const flagWidth = Math.max(...GLOBAL_FLAGS.map(([n]) => n.length));

  const commandRows = COMMANDS.map((c) => row(c.name, c.summary, cmdWidth));
  commandRows.push(row("help", "Show this help, or `help <command>` for one command.", cmdWidth));
  const flagRows = GLOBAL_FLAGS.map(([n, d]) => row(n, d, flagWidth));

  return [
    `${BIN} — push JSONL files into your encrypted jsonl-tools history.`,
    "",
    "Each file is encrypted on this box before it leaves; the server only ever",
    "stores ciphertext it cannot read. Same zero-knowledge guarantee as the web app.",
    "",
    "Usage:",
    `  ${BIN} <command> [args] [flags]`,
    `  ${BIN} <command> --help      # detailed help for one command`,
    "",
    "Commands:",
    ...commandRows,
    "",
    "Global flags:",
    ...flagRows,
    "",
    "Credential resolution is flag > env (JSONL_TOOLS_TOKEN) > the stored file at",
    "~/.config/jsonl-tools/credentials. Run `login` to create that file.",
  ].join("\n");
}

/** Detailed help for one command, or null if `name` is not a known command. */
export function commandHelp(name: string): string | null {
  const c = byName.get(name);
  if (!c) return null;

  const lines: string[] = [
    `${BIN} ${c.name} — ${c.summary}`,
    "",
    "Usage:",
    `  ${c.usage}`,
    "",
    c.description,
  ];

  if (c.args?.length) {
    const w = Math.max(...c.args.map(([n]) => n.length));
    lines.push("", "Arguments:", ...c.args.map(([n, d]) => row(n, d, w)));
  }
  if (c.flags?.length) {
    const w = Math.max(...c.flags.map(([n]) => n.length));
    lines.push("", "Flags:", ...c.flags.map(([n, d]) => row(n, d, w)));
  }
  if (c.examples?.length) {
    lines.push("", "Examples:", ...c.examples.map((e) => `  ${e}`));
  }
  lines.push("", "Global flags (all commands): " + GLOBAL_FLAGS.map(([n]) => n).join("  "));
  return lines.join("\n");
}

/**
 * True when the parsed flags carry a help request (`--help` / `-h`). Checks for
 * key presence rather than `=== true` so `--help` that swallowed a following token
 * (e.g. `login --help foo`) is still treated as a help request.
 */
export function isHelpRequested(flags: Record<string, string | boolean>): boolean {
  return "help" in flags || "h" in flags;
}
