import { test, expect } from "bun:test";
import { parseArgs } from "./args";

test("first token is the command; the rest are positionals", () => {
  const { command, positionals, flags } = parseArgs(["upload", "run.jsonl"]);
  expect(command).toBe("upload");
  expect(positionals).toEqual(["run.jsonl"]);
  expect(flags).toEqual({});
});

test("no argv defaults the command to help", () => {
  expect(parseArgs([]).command).toBe("help");
});

test("value flags consume the next token (space form and = form)", () => {
  expect(parseArgs(["upload", "f", "--title", "hi"]).flags.title).toBe("hi");
  expect(parseArgs(["upload", "f", "--title=hi"]).flags.title).toBe("hi");
  expect(parseArgs(["download", "--out", "dir"]).flags.out).toBe("dir");
});

// Regression: a bare boolean flag before a positional used to swallow the
// positional as its "value" AND never register as true.
test("a boolean flag does not consume the following positional", () => {
  const { positionals, flags } = parseArgs(["upload", "--allow-insecure", "run.jsonl"]);
  expect(flags["allow-insecure"]).toBe(true);
  expect(positionals).toEqual(["run.jsonl"]);
});

test("boolean flag before a positional works for view/delete too", () => {
  const view = parseArgs(["view", "--allow-insecure", "abc123"]);
  expect(view.flags["allow-insecure"]).toBe(true);
  expect(view.positionals).toEqual(["abc123"]);
});

// Regression: an empty-string value was dropped (treated as boolean true) and
// the "" was mis-pushed as a phantom positional, shifting the real file arg.
test("an empty-string flag value is preserved, not dropped", () => {
  const { positionals, flags } = parseArgs(["upload", "--title", "", "run.jsonl"]);
  expect(flags.title).toBe("");
  expect(positionals).toEqual(["run.jsonl"]);
});

test("a value flag with no following token becomes a boolean", () => {
  expect(parseArgs(["upload", "f", "--title"]).flags.title).toBe(true);
});

test("a value flag followed by another flag does not consume it", () => {
  const { flags } = parseArgs(["upload", "f", "--title", "--base-url", "https://x"]);
  expect(flags.title).toBe(true);
  expect(flags["base-url"]).toBe("https://x");
});
