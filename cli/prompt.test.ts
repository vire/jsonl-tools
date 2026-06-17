import { test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { promptLine } from "./prompt";

test("promptLine writes the prompt to output and resolves the first Enter-terminated line", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (c) => (written += c.toString()));

  const pending = promptLine(input, output, "Paste it:\n");
  input.write("jt1_tok.sec.key\n"); // user pastes the credential and presses Enter

  expect(await pending).toBe("jt1_tok.sec.key");
  expect(written).toContain("Paste it:");
});

test("promptLine reads a single line (one paste), not the whole stream", async () => {
  const input = new PassThrough();
  const output = new PassThrough();

  const pending = promptLine(input, output, "x");
  input.write("first-line\nsecond-line\n");

  expect(await pending).toBe("first-line");
});
