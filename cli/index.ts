#!/usr/bin/env node
// @jsonl-tools/cli entry (plan U7/U8). Parses argv, resolves config, and
// dispatches to the command core. File and stdin I/O live here (real fs); the
// crypto + HTTP round-trip lives in core.ts so it stays testable.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { resolveBaseUrl, resolveCredential, type ConfigOpts } from "./config";
import { writeCredential, credentialPath } from "./credential";
import { parseArgs, type Args } from "./args";
import { topLevelHelp, commandHelp, isHelpRequested } from "./help";
import { promptLine } from "./prompt";
import {
  uploadContent,
  listUploads,
  downloadAll,
  viewLink,
  deleteUpload,
  type Deps,
  type FileSink,
} from "./core";

/** A flag value as a string, or undefined if absent / a bare boolean flag. */
const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

function configOpts(flags: Args["flags"]): ConfigOpts {
  return {
    baseUrl: str(flags["base-url"]),
    token: str(flags.token),
    allowInsecure: flags["allow-insecure"] === true,
  };
}

function requireDeps(flags: Args["flags"]): Deps {
  const opts = configOpts(flags);
  const baseUrl = resolveBaseUrl(opts);
  const credential = resolveCredential(opts);
  if (!credential) {
    throw new Error("No credential found. Run `jsonl-tools login` or pass --token / set JSONL_TOOLS_TOKEN.");
  }
  const timeoutSec = Number(str(flags.timeout));
  const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : undefined;
  return { baseUrl, credential, timeoutMs };
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

const LOGIN_PROMPT =
  "Paste the credential from the web app (Account → CLI tab → Create token), then press Enter:\n";

/**
 * Resolve the login credential from stdin. On an interactive terminal, prompt and
 * read one line via readline — reliable on a TTY (a synchronous fd-0 read either
 * throws EAGAIN or blocks with no output) and finished with Enter, not Ctrl-D. The
 * prompt is written to stderr so a piped `… | login` keeps stdout clean. When
 * stdin is piped (e.g. `pbpaste | jsonl-tools login`) it is read to EOF instead.
 */
async function readLoginCredential(): Promise<string> {
  if (process.stdin.isTTY) {
    return promptLine(process.stdin, process.stderr, LOGIN_PROMPT);
  }
  return readStdin();
}

async function main(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);

  // Help routing comes before the command switch so `<command> --help` prints that
  // command's help and never executes it (executing `login`, for one, would block
  // on stdin). `help [command]`, `--help`, and `-h` all land here too.
  if (command === "help" || command === "--help" || command === "-h") {
    const topic = positionals[0];
    console.log((topic && commandHelp(topic)) || topLevelHelp());
    return 0;
  }
  if (isHelpRequested(flags)) {
    console.log(commandHelp(command) ?? topLevelHelp());
    return 0;
  }

  switch (command) {
    case "login": {
      const opts = configOpts(flags);
      const raw = str(flags.token) || process.env.JSONL_TOOLS_TOKEN || (await readLoginCredential());
      // validate before storing
      const cred = resolveCredential({ ...opts, token: raw.trim() });
      if (!cred) throw new Error("No credential provided to login.");
      writeCredential(raw);
      console.log(`Saved credential to ${credentialPath()}`);
      return 0;
    }
    case "upload": {
      const deps = requireDeps(flags);
      const src = positionals[0];
      if (!src) throw new Error("upload needs a <file> path or - for stdin.");
      const content = src === "-" ? readStdin() : readFileSync(src, "utf8");
      const filename = src === "-" ? "stdin" : basename(src);
      const title = str(flags.title) ?? null;
      const { id } = await uploadContent(deps, { filename, content, title });
      console.log(id);
      return 0;
    }
    case "list": {
      const deps = requireDeps(flags);
      const items = await listUploads(deps);
      if (items.length === 0) console.log("(no uploads)");
      for (const it of items) {
        console.log(`${it.shareId}  ${it.sizeBytes}b  ${it.createdAt}  ${it.state}`);
      }
      return 0;
    }
    case "download": {
      const deps = requireDeps(flags);
      const outDir = str(flags.out) ?? ".";
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      const sink: FileSink = {
        exists: (name) => existsSync(join(outDir, name)),
        write: (name, c) => writeFileSync(join(outDir, name), c),
      };
      const { written, failed } = await downloadAll(deps, sink);
      console.log(written.length ? written.map((w) => join(outDir, w)).join("\n") : "(nothing to download)");
      for (const f of failed) console.error(`Failed: ${f.shareId} — ${f.error}`);
      return failed.length ? 1 : 0;
    }
    case "view": {
      const deps = requireDeps(flags);
      const id = positionals[0];
      if (!id) throw new Error("view needs an upload <id>.");
      const items = await listUploads(deps);
      const item = items.find((i) => i.shareId === id);
      if (!item) throw new Error(`No upload found with id ${id}.`);
      if (item.state !== "active") {
        throw new Error(`Upload ${id} is ${item.state} — no openable link.`);
      }
      console.log(await viewLink(deps, item));
      return 0;
    }
    case "delete": {
      const deps = requireDeps(flags);
      const id = positionals[0];
      if (!id) throw new Error("delete needs an upload <id>.");
      await deleteUpload(deps, id);
      console.log(`Deleted ${id}`);
      return 0;
    }
    default:
      console.error(`Unknown command: ${command}\n\n${topLevelHelp()}`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  });
