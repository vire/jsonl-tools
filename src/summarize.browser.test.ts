import { test, expect } from "bun:test";
import { summarize } from "./summarize.browser";

const jsonlExample = await Bun.file(
  new URL("./jsonl-example.jsonl", import.meta.url)
).text();

test("summarize parses jsonl example without throwing", () => {
  expect(() => summarize(jsonlExample)).not.toThrow();
});

test("summarize returns markdown table", () => {
  const result = summarize(jsonlExample);
  expect(result).toContain("| Timestamp | Delta | Type | Description |");
  expect(result).toContain("|-----------|-------|------|-------------|");
});

test("summarize includes entries with timestamps", () => {
  const result = summarize(jsonlExample);
  // Should include user and assistant entries
  expect(result).toContain("user");
  expect(result).toContain("assistant");
});

test("summarize calculates deltas", () => {
  const result = summarize(jsonlExample);
  const lines = result.split("\n");
  // Skip header rows (0 and 1), check data rows
  const dataLines = lines.slice(2);
  expect(dataLines.length).toBeGreaterThan(0);
  // Should have entries with actual timestamps (not just dashes)
  const hasTimestamp = dataLines.some((line) => /\d{2}:\d{2}:\d{2}/.test(line));
  expect(hasTimestamp).toBe(true);
});

test("summarize uses snapshot.timestamp as fallback", () => {
  const input = `{"type":"file-history-snapshot","snapshot":{"timestamp":"2026-01-31T17:20:47.035Z"}}`;
  const result = summarize(input);
  expect(result).toContain("17:20:47.035");
});

test("summarize handles entries without any timestamp", () => {
  const input = `{"type":"unknown","data":"test"}`;
  const result = summarize(input);
  // Should show dashes for missing timestamp/delta
  expect(result).toContain("| — | — |");
});
