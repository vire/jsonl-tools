import { test, expect } from "bun:test";
import {
  COMMANDS,
  topLevelHelp,
  commandHelp,
  isHelpRequested,
} from "./help";

const COMMAND_NAMES = ["login", "upload", "list", "download", "view", "delete"];

test("topLevelHelp lists every command with a one-line description", () => {
  const out = topLevelHelp();
  for (const name of COMMAND_NAMES) {
    const meta = COMMANDS.find((c) => c.name === name)!;
    expect(meta, `COMMANDS is missing ${name}`).toBeDefined();
    // the command's name and its summary sentence both appear in the listing
    expect(out).toContain(name);
    expect(out).toContain(meta.summary);
  }
});

test("topLevelHelp documents the global flags", () => {
  const out = topLevelHelp();
  for (const flag of ["--base-url", "--token", "--allow-insecure", "--timeout"]) {
    expect(out).toContain(flag);
  }
});

test("topLevelHelp tells the reader how to get per-command help", () => {
  expect(topLevelHelp()).toContain("--help");
});

test("every command has a detailed help entry with a usage line", () => {
  for (const name of COMMAND_NAMES) {
    const out = commandHelp(name);
    expect(out, `commandHelp(${name}) returned null`).not.toBeNull();
    expect(out!).toContain(`jsonl-tools ${name}`);
  }
});

test("commandHelp(login) explains the stdin paste, the --token alternative, and shows examples", () => {
  const out = commandHelp("login")!;
  expect(out.toLowerCase()).toContain("stdin");
  expect(out).toContain("--token");
  expect(out).toContain("Examples:");
});

test("commandHelp(upload) documents the file/stdin argument and --title", () => {
  const out = commandHelp("upload")!;
  expect(out).toContain("<file");
  expect(out).toContain("--title");
});

test("commandHelp(view) and commandHelp(delete) document the <id> argument", () => {
  expect(commandHelp("view")!).toContain("<id>");
  expect(commandHelp("delete")!).toContain("<id>");
});

test("commandHelp returns null for an unknown command", () => {
  expect(commandHelp("frobnicate")).toBeNull();
});

test("isHelpRequested detects --help / -h flags and nothing else", () => {
  expect(isHelpRequested({ help: true })).toBe(true);
  expect(isHelpRequested({ h: true })).toBe(true);
  expect(isHelpRequested({ help: "anything" })).toBe(true); // --help that swallowed a token
  expect(isHelpRequested({})).toBe(false);
  expect(isHelpRequested({ title: "x" })).toBe(false);
});
